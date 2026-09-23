// AirChatOpenFlux для iOS — туннель через документ: ядро на Go внутри процесса
// плюс три слоя перехвата трафика (OpenFluxRouting).
//
// Модуль намеренно почти не содержит логики повторов и расписаний — этим
// занимается openFluxController на стороне JS, где видно и настройки, и
// состояние сети, и экран. Здесь только то, чего из JS не сделать: поднять
// ядро и увести в него сокеты приложения.
//
// Отличие от Android-близнеца — в том, чего здесь нет. Нет foreground-сервиса:
// iOS такого понятия не знает, и туннель живёт ровно столько, сколько живёт
// процесс. Зато есть счётчик соединений (OpenFluxTunnelLog): на Android можно
// посмотреть на ProxySelector и быть уверенным, что трафик пошёл в прокси, а
// здесь это надо доказывать.
import ExpoModulesCore

/// Ядра нет в сборке или iOS слишком старая — не ошибка, а состояние.
internal final class OpenFluxUnavailableException: Exception, @unchecked Sendable {
  override var code: String { "ERR_OPENFLUX_UNAVAILABLE" }
  override var reason: String { "Ядро OpenFlux недоступно в этой сборке" }
}

/// Текст сюда приходит от ядра — он и попадает пользователю в «Повторить».
internal final class OpenFluxStartException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_OPENFLUX_START" }
  override var reason: String { param }
}

/**
 * Значения по умолчанию совпадают с DEFAULT_CONFIG.openflux (src/core/config.ts)
 * и с Android-версией записи. Дублирование осознанное: JS может прислать запись
 * без поля, и тогда лучше поднять туннель на разумных значениях, чем упасть на
 * пустой строке.
 *
 * socksAddr от JS на iOS не используется: адрес выбирает OpenFluxRouting, и там
 * же объяснено, почему порт обязан быть постоянным на весь процесс. Поле
 * оставлено, чтобы запись совпадала с Android и не заставляла JS знать про
 * платформу.
 */
struct OpenFluxStartOptions: Record {
  @Field var transport: String = "yandex"
  @Field var docUrl: String = ""
  @Field var socksAddr: String = "127.0.0.1:0"
  @Field var dns: String = "1.1.1.1:53"
}

public class AirChatOpenFluxModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AirChatOpenFlux")

    // Перехват HTTP ставится сразу, а не при первом старте туннеля, и это не
    // перестраховка: React Native спрашивает конфигурацию своей сессии один
    // раз, на первом же запросе. Опоздать сюда — значит остаться без второго
    // слоя до перезапуска приложения. Подробности в OpenFluxRouting.
    OnCreate {
      OpenFluxRouting.shared.prepare()
    }

    AsyncFunction("isSupported") {
      OpenFluxCore.isAvailable && OpenFluxRouting.shared.isPlatformCapable
    }

    // AsyncFunction по умолчанию выполняется не на главном потоке, и здесь это
    // принципиально: OpenFluxStart ходит в сеть (открывает документ, ждёт
    // ответа Яндекса) и на главном потоке заморозил бы интерфейс.
    AsyncFunction("start") { (options: OpenFluxStartOptions) -> String in
      try self.startTunnel(options)
    }

    AsyncFunction("stop") {
      self.stopTunnel()
    }

    AsyncFunction("isRunning") {
      OpenFluxCore.isRunning()
    }

    AsyncFunction("socksAddr") { () -> String? in
      guard let addr = OpenFluxCore.currentAddr() else { return nil }
      return "\(addr.host):\(addr.port)"
    }

    // Односторонне: ядро умеет только включить отладку (utils/debug.go).
    AsyncFunction("enableTunnelStats") {
      guard OpenFluxCore.isAvailable else { throw OpenFluxUnavailableException() }
      OpenFluxTunnelLog.shared.enable()
    }

    AsyncFunction("tunnelStats") { () -> [String: Any] in
      let log = OpenFluxTunnelLog.shared.snapshot()
      let routing = OpenFluxRouting.shared.state()
      return [
        "counting": log.enabled,
        "connections": log.connections,
        "failures": log.failures,
        "lastTarget": log.lastTarget as Any,
        "lastAt": log.lastAt.map { $0.timeIntervalSince1970 * 1000 } as Any,
        "systemProxy": routing.systemProxy,
        "httpProxy": routing.httpProxy
      ]
    }

    OnDestroy {
      // Перезагрузка JS (dev-reload, смена пользователя) пересоздаёт модуль, но
      // не процесс: ядро осталось бы поднятым и на следующий start ответило бы
      // «клиент уже запущен».
      if OpenFluxCore.isRunning() {
        self.stopTunnel()
      }
    }
  }

  private func startTunnel(_ options: OpenFluxStartOptions) throws -> String {
    guard OpenFluxCore.isAvailable, OpenFluxRouting.shared.isPlatformCapable else {
      throw OpenFluxUnavailableException()
    }

    // Ссылка на документ — это ключ к нему, а не настройка: в репозиторий она
    // не кладётся и в сборке без EXPO_PUBLIC_OPENFLUX_DOC_URL приходит пустой.
    // Отвечаем внятно, а не невнятной ошибкой ядра.
    let docUrl = options.docUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !docUrl.isEmpty else {
      throw OpenFluxStartException("В этой сборке не задана ссылка на документ OpenFlux")
    }

    let transport = nonEmpty(options.transport, or: "yandex")
    let dns = nonEmpty(options.dns, or: "1.1.1.1:53")
    let routing = OpenFluxRouting.shared

    // Ни docUrl, ни текста ошибки с ним в лог не пишем: он даёт право писать в
    // документ, а логи с устройства достаёт кто угодно.
    func launchCore(at socksAddr: String) -> String? {
      OpenFluxCore.start(transport: transport, docURL: docUrl, socksAddr: socksAddr, dns: dns)
    }

    var error = launchCore(at: routing.preferredSocksAddr())

    // Зарезервированный порт мог за это время кто-то занять. Туннель важнее
    // второго слоя перехвата: поднимаемся на любом свободном порту, а про то,
    // что слой 2 в этот раз мимо, честно скажет tunnelStats. Повторяем только
    // на занятом порту — на любой другой ошибке (документ недоступен, нет
    // сети) второй заход просто удвоил бы ожидание.
    if let first = error,
       first.contains("address already in use"),
       routing.preferredSocksAddr() != routing.fallbackSocksAddr() {
      error = launchCore(at: routing.fallbackSocksAddr())
    }

    if let error {
      throw OpenFluxStartException(error)
    }

    guard let addr = OpenFluxCore.currentAddr() else {
      // Без адреса туннель бесполезен — трафик в него не увести. Оставлять
      // ядро поднятым в таком виде нельзя, иначе следующий старт упрётся в
      // «клиент уже запущен».
      OpenFluxCore.stop()
      throw OpenFluxStartException("Ядро поднялось, но не сообщило адрес SOCKS5")
    }

    routing.activate(host: addr.host, port: addr.port)
    return "\(addr.host):\(addr.port)"
  }

  private func stopTunnel() {
    // Сначала возвращаем трафик напрямую и только потом гасим ядро: наоборот —
    // это окно, в котором новые соединения идут в уже мёртвый SOCKS5.
    OpenFluxRouting.shared.deactivate()
    OpenFluxCore.stop()
  }

  private func nonEmpty(_ value: String, or fallback: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? fallback : trimmed
  }
}
