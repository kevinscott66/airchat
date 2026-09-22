import Foundation

/**
 * Мост в C-API ядра OpenFlux. Вся возня с char* и strdup — здесь, остальному
 * коду модуля видно только «получилось/не получилось» и адрес SOCKS5.
 *
 * Обе ветки #if обязаны иметь одинаковый набор методов: ядра в свежем клоне
 * нет (см. AirChatOpenFlux.podspec), и тогда компилируется заглушка, у которой
 * isAvailable == false. Так модуль собирается всегда, а туннель просто
 * объявляет себя недоступным.
 */
enum OpenFluxCore {
#if AIRCHAT_OPENFLUX_CORE
  static let isAvailable = true

  /// Отладочный вывод ядра в stderr. Односторонний: выключить обратно ядро не
  /// умеет, поэтому и наружу это отдаётся как кнопка, а не как переключатель.
  static func enableDebug() {
    OpenFluxSetDebug(1)
  }

  /// nil при успехе, иначе текст ошибки ядра — его и показываем пользователю.
  ///
  /// Портировано с TunnelController.callStart (ios/Sources/TunnelController.swift
  /// в репозитории ядра): порядок аргументов и освобождение строк здесь важнее
  /// красоты, переписывать своими словами нечего.
  static func start(
    transport: String,
    docURL: String,
    socksAddr: String,
    dns: String
  ) -> String? {
    // maxToken/maxUID нужны транспорту Max; у нас документ Яндекса, который
    // авторизуется самой ссылкой, — туда уходят пустые строки.
    let args = [transport, docURL, "", "", socksAddr, dns]
    let c = args.map { strdup($0) }
    defer { c.forEach { free($0) } }

    guard let err = OpenFluxStart(c[0], c[1], c[2], c[3], c[4], c[5]) else { return nil }
    let text = String(cString: err)
    // Строку выделил Go — освобождать её может только он.
    OpenFluxFree(err)
    return text
  }

  /// "127.0.0.1:54321" -> ("127.0.0.1", 54321)
  static func currentAddr() -> (host: String, port: UInt16)? {
    guard let raw = OpenFluxSocksAddr() else { return nil }
    let s = String(cString: raw)
    OpenFluxFree(raw)
    guard let colon = s.lastIndex(of: ":"),
          let port = UInt16(s[s.index(after: colon)...])
    else { return nil }
    return (String(s[s.startIndex..<colon]), port)
  }

  static func isRunning() -> Bool {
    OpenFluxIsRunning() != 0
  }

  static func stop() {
    OpenFluxStop()
  }
#else
  static let isAvailable = false

  static func enableDebug() {}

  static func start(
    transport _: String,
    docURL _: String,
    socksAddr _: String,
    dns _: String
  ) -> String? {
    "Ядро OpenFlux не собрано в этой сборке"
  }

  static func currentAddr() -> (host: String, port: UInt16)? { nil }

  static func isRunning() -> Bool { false }

  static func stop() {}
#endif
}
