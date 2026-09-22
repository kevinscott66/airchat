import Foundation
import Network

/**
 * Перехват трафика приложения и увод его в локальный SOCKS5, который поднимает
 * ядро. На Android для этого хватает одной строки — ProxySelector.setDefault()
 * (см. OpenFluxProxy.kt), потому что весь сетевой стек там один OkHttp. На iOS
 * такой единой точки нет, поэтому слоёв два.
 *
 * Слой 1 — системный, Network.framework:
 *   nw_privacy_context_add_proxy(NW_DEFAULT_PRIVACY_CONTEXT, socks5).
 * Это ближайший аналог ProxySelector: прокси видят все соединения процесса,
 * которые идут через Network.framework, — а на современной iOS через него
 * идёт почти всё, включая CFNetwork поверх него. Требует iOS 17.
 *
 * Слой 2 — гарантированный для HTTP, React Native:
 *   RCTSetCustomNSURLSessionConfigurationProvider + configuration.proxyConfigurations.
 * Он нужен именно потому, что про слой 1 нельзя сказать «покрывает всё» —
 * это надо измерять, а не предполагать. Слой 2 же покрывает ровно то, что
 * известно: fetch/XHR из JS.
 *
 * ── Чего здесь намеренно НЕТ ────────────────────────────────────────────────
 *
 * • connectionProxyDictionary с ключами kCFStreamPropertySOCKSProxy*.
 *   Самый популярный совет в интернете и нерабочий: URLSession читает из этого
 *   словаря только семейство ключей HTTP/HTTPS, а SOCKS-ключи молча
 *   игнорирует. «Молча» здесь главное слово — прокси как будто настроен, а
 *   трафик идёт напрямую. Поэтому используется новый API Network.framework
 *   (ProxyConfiguration), а не старый словарь.
 *
 * • Network Extension (NEPacketTunnelProvider).
 *   Он перехватил бы вообще весь трафик на уровне пакетов, но требует
 *   entitlement com.apple.developer.networking.networkextension, то есть
 *   платного аккаунта разработчика и отдельного профиля. Ради туннеля, который
 *   и так работает на уровне сокетов, городить второй процесс и просить
 *   entitlement незачем.
 *
 * • Подмена методов (swizzling) NSURLSession или SocketRocket.
 *   Не нужна: обе точки подключения, которыми мы пользуемся, — публичные
 *   функции. Swizzling здесь добавил бы только хрупкости при обновлении RN.
 *
 * ── Что честно НЕ покрыто ───────────────────────────────────────────────────
 *
 * Веб-сокеты React Native на iOS идут не через URLSession, а через SocketRocket
 * поверх CFStream (RCTWebSocketModule.mm импортирует SocketRocket/SRWebSocket.h
 * и создаёт сокет напрямую). Слой 2 их не касается — он про URLSession.
 * Покрывает ли их слой 1 — неизвестно, и именно это надо измерить счётчиком
 * соединений (OpenFluxTunnelLog): ntfy, главный канал AirChat, держится как
 * раз на веб-сокете. Если окажется, что не покрывает, в RN есть третья точка —
 * RCTSetCustomSRWebSocketProvider (RCTWebSocketModule.mm), но писать её вслепую
 * мы не стали: она дороже двух первых, и без измерения неизвестно, нужна ли.
 */
final class OpenFluxRouting {
  static let shared = OpenFluxRouting()

  /// Куда не заворачиваем трафик. Аналог OpenFluxProxy.isLoopback() на Android:
  /// свой же SOCKS5 и всё остальное на петле через туннель гонять нельзя.
  ///
  /// Честная оговорка: nw_proxy_config_add_excluded_domain сравнивает суффикс
  /// ИМЕНИ хоста, поэтому «127.0.0.1» отработает только для буквального
  /// адреса-строки. В dev-сборке Metro живёт на LAN-адресе Mac'а, который
  /// заранее неизвестен и в исключения не попадёт: при поднятом туннеле
  /// перезагрузка бандла может не работать. Для релизной сборки это неважно —
  /// Metro там нет.
  private static let excludedHosts = ["localhost", "127.0.0.1", "::1"]

  private let lock = NSLock()

  /// Порт, который мы держим за собой на весь процесс.
  ///
  /// Зачем резервировать, а не брать любой свободный, как на Android. React
  /// Native спрашивает конфигурацию сессии ОДИН раз — лениво, на первом
  /// HTTP-запросе (RCTHTTPRequestHandler.mm: `if (_session == nullptr)`), и
  /// больше не спрашивает никогда: созданная NSURLSession хранит свою копию
  /// конфигурации до самой инвалидации. Дотянуться до этого объекта и
  /// инвалидировать его из модуля нечем — RCTBridge.currentBridge в bridgeless
  /// пуст. Значит адрес прокси должен быть верным ВСЕГДА, а не в момент
  /// установки: поэтому порт выбирается один раз при создании модуля и потом
  /// выдаётся ядру на каждом старте.
  ///
  /// Переключение туннеля при этом работает без перезапуска приложения:
  /// туннель поднят — на порту есть SOCKS5 и трафик идёт через него; туннель
  /// опущен — соединение на петлю мгновенно отлетает по ECONNREFUSED, и
  /// сработает failover (см. ниже). Цена — один отказанный connect на петле
  /// при каждом новом TCP-соединении, пока туннель выключен.
  private var reservedPort: UInt16?

  private var hookInstalled = false
  private var systemProxyActive = false

  /// Правда ли трафик HTTP сейчас может пойти в туннель: слой 2 поставлен и
  /// ядро слушает именно тот порт, который в него зашит.
  private var httpRoutedToReservedPort = false

  // MARK: - подготовка

  /// Есть ли на этой iOS то, чем вообще можно перехватить трафик.
  /// Оба слоя завязаны на API Network.framework из iOS 17; на 15–16 туннель
  /// поднялся бы, но не повёз бы ничего — а туннель, который ничего не везёт,
  /// честнее назвать недоступным.
  var isPlatformCapable: Bool {
    if #available(iOS 17, *) { return true }
    return false
  }

  /// Вызывается при создании модуля, до того как приложение сделает первый
  /// сетевой запрос.
  func prepare() {
    guard isPlatformCapable, OpenFluxCore.isAvailable else { return }

    lock.lock()
    if reservedPort == nil {
      reservedPort = Self.reserveLoopbackPort()
    }
    let alreadyInstalled = hookInstalled
    hookInstalled = true
    lock.unlock()

    guard !alreadyInstalled else { return }
    installHTTPProvider()
  }

  /// Адрес, который отдаём ядру при старте. Порт 0 — «выбери сам»: так ядро
  /// поднимется даже если зарезервировать порт не удалось, просто слой 2 в
  /// этом случае мимо (и мы об этом честно сообщаем в stats).
  func preferredSocksAddr() -> String {
    lock.lock()
    defer { lock.unlock() }
    guard let port = reservedPort else { return "127.0.0.1:0" }
    return "127.0.0.1:\(port)"
  }

  func fallbackSocksAddr() -> String {
    "127.0.0.1:0"
  }

  // MARK: - включение и выключение

  /// Ядро поднялось и слушает actualPort — заворачиваем в него трафик.
  func activate(host: String, port: UInt16) {
    lock.lock()
    httpRoutedToReservedPort = (reservedPort == port)
    lock.unlock()

    guard #available(iOS 17, *) else { return }
    setSystemProxy(host: host, port: port)
  }

  func deactivate() {
    lock.lock()
    httpRoutedToReservedPort = false
    lock.unlock()

    guard #available(iOS 17, *) else { return }
    clearSystemProxy()
  }

  // MARK: - слой 1: системный прокси

  @available(iOS 17, *)
  private func setSystemProxy(host: String, port: UInt16) {
    let endpoint = nw_endpoint_create_host(host, String(port))
    let proxy = nw_proxy_config_create_socksv5(endpoint)

    // Failover оставляем выключенным (это и есть значение по умолчанию,
    // ставим явно ради читателя). Смысл: пока туннель поднят, трафик обязан
    // идти через него или не идти вовсе. Разрешить обход — значит получить
    // приложение, которое «работает» в сети с белым списком ровно до первого
    // запроса мимо туннеля, и молча.
    nw_proxy_config_set_failover_allowed(proxy, false)
    for domain in Self.excludedHosts {
      nw_proxy_config_add_excluded_domain(proxy, domain)
    }

    // Контекст по умолчанию — общий для всего процесса. В Swift макрос
    // NW_DEFAULT_PRIVACY_CONTEXT не виден, зато виден символ, в который он
    // разворачивается.
    nw_privacy_context_clear_proxies(_nw_privacy_context_default_context)
    nw_privacy_context_add_proxy(_nw_privacy_context_default_context, proxy)

    lock.lock()
    systemProxyActive = true
    lock.unlock()
  }

  @available(iOS 17, *)
  private func clearSystemProxy() {
    nw_privacy_context_clear_proxies(_nw_privacy_context_default_context)
    lock.lock()
    systemProxyActive = false
    lock.unlock()
  }

  // MARK: - слой 2: HTTP через React Native

  private func installHTTPProvider() {
    AirChatOpenFluxInstallSessionConfigProvider { [weak self] in
      Self.makeSessionConfiguration(port: self?.currentReservedPort)
    }
  }

  private var currentReservedPort: UInt16? {
    lock.lock()
    defer { lock.unlock() }
    return reservedPort
  }

  private static func makeSessionConfiguration(port: UInt16?) -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.default

    // Повторяем то, что React Native ставит сам, когда провайдера нет
    // (RCTHTTPRequestHandler.mm): мы заменяем эту ветку целиком, и молчаливая
    // потеря куки была бы отличным способом сломать вход в аккаунт.
    configuration.httpShouldSetCookies = true
    configuration.httpCookieAcceptPolicy = .always
    configuration.httpCookieStorage = .shared

    guard #available(iOS 17, *), let port, let nwPort = NWEndpoint.Port(rawValue: port) else {
      return configuration
    }

    var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: nwPort))
    // А вот здесь failover как раз нужен, и по причине, обратной слою 1.
    // Конфигурация ставится один раз на всю жизнь сессии, в том числе когда
    // туннель выключен и включать его никто не собирается. Без failover
    // приложение без туннеля просто не смогло бы сходить в сеть.
    proxy.allowFailover = true
    proxy.excludedDomains = excludedHosts
    configuration.proxyConfigurations = [proxy]

    return configuration
  }

  // MARK: - состояние для UI

  struct RoutingState {
    let systemProxy: Bool
    let httpProxy: Bool
  }

  func state() -> RoutingState {
    lock.lock()
    defer { lock.unlock() }
    return RoutingState(systemProxy: systemProxyActive, httpProxy: httpRoutedToReservedPort)
  }

  // MARK: - резервирование порта

  /// Просит систему выдать свободный порт на петле и тут же его отпускает.
  /// Теоретически между отпусканием и стартом ядра порт может занять кто-то
  /// другой; на практике внутри песочницы приложения конкурентов нет, а если
  /// это всё же случится, ядро стартует на порту 0 (см. вызов в модуле) и
  /// слой 2 честно отметится как неактивный.
  private static func reserveLoopbackPort() -> UInt16? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }

    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")

    let bound = withUnsafePointer(to: &addr) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0 else { return nil }

    var assigned = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let read = withUnsafeMutablePointer(to: &assigned) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        getsockname(fd, sa, &length)
      }
    }
    guard read == 0 else { return nil }

    let port = UInt16(bigEndian: assigned.sin_port)
    return port == 0 ? nil : port
  }
}
