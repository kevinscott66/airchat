import Foundation

/**
 * Счётчик соединений, которые реально прошли через туннель.
 *
 * Зачем это вообще есть. Про перехват трафика на iOS нельзя сказать «работает»,
 * глядя на код: слой 1 (системный прокси Network.framework) покрывает
 * неизвестно что, слой 2 — только URLSession, а веб-сокеты ходят мимо обоих
 * и потребовали третьего слоя. Нарисовать в настройках зелёную галочку
 * «туннель работает» по факту «ядро поднялось» — это соврать: ядро может
 * стоять поднятым, пока весь трафик идёт напрямую. Поэтому показываем
 * единственное, что является доказательством: сколько соединений ядро приняло
 * на свой SOCKS5.
 *
 * Откуда берутся числа. Ядро с включённой отладкой печатает в stderr строку
 * "[SOCKS5] CONNECT host:port" на каждое соединение (socks5/socks5.go) и
 * "[SOCKS5] Dial failed: …" на каждое неудавшееся. На телефоне консоли нет,
 * поэтому перехватываем дескриптор 2 — тот же приём, что в отладочном
 * приложении самого ядра (ios/Sources/TunnelController.swift, LogCapture).
 *
 * Почему включение одностороннее. В ядре verbose — обычный флаг без обратного
 * хода (utils/debug.go: EnableDebug только выставляет его). Делать в UI
 * переключатель, который на самом деле не выключает, — та же ложь, что и
 * зелёная галочка. Поэтому наружу это кнопка «включить», и выключается она
 * перезапуском приложения.
 */
final class OpenFluxTunnelLog {
  static let shared = OpenFluxTunnelLog()

  private let lock = NSLock()
  private var enabled = false
  private var connections = 0
  private var failures = 0
  private var lastTarget: String?
  private var lastAt: Date?

  private var realStderr: Int32 = -1
  private var readSource: DispatchSourceRead?
  private var tail = Data()

  private let queue = DispatchQueue(label: "airchat.openflux.log")

  struct Snapshot {
    let enabled: Bool
    let connections: Int
    let failures: Int
    let lastTarget: String?
    let lastAt: Date?
  }

  func snapshot() -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    return Snapshot(
      enabled: enabled,
      connections: connections,
      failures: failures,
      lastTarget: lastTarget,
      lastAt: lastAt
    )
  }

  /// Включает отладку ядра и начинает считать соединения. Повторные вызовы
  /// ничего не делают.
  func enable() {
    lock.lock()
    let already = enabled
    enabled = true
    lock.unlock()
    guard !already else { return }

    startCapture()
    // Перехват ставим первым: ядро в EnableDebug запоминает os.Stderr, и хотя
    // подмена идёт на уровне дескриптора (то есть порядок не важен), так не
    // приходится об этом думать.
    OpenFluxCore.enableDebug()
  }

  // MARK: - перехват stderr

  private func startCapture() {
    // Построчная буферизация: иначе Go отдаёт строки пачками и счётчик
    // дёргается рывками.
    setvbuf(stderr, nil, _IOLBF, 0)

    var pair: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { return }
    let read = pair[0]
    let write = pair[1]

    // Почему socketpair, а не Pipe(). У трубы буфер 64 КБ, и если наш читатель
    // почему-либо встанет, запись в переполненную трубу заблокируется — то
    // есть заблокируется поток ядра, печатающий отладку, и туннель встанет
    // вместе с ним. Здесь оба конца неблокирующие: в худшем случае мы потеряем
    // отладочную строку, а не подвесим приложение.
    _ = fcntl(write, F_SETFL, fcntl(write, F_GETFL, 0) | O_NONBLOCK)
    _ = fcntl(read, F_SETFL, fcntl(read, F_GETFL, 0) | O_NONBLOCK)

    // Настоящий stderr сохраняем и дублируем в него всё, что перехватили:
    // иначе из Xcode пропадут и наши строки, и чужие (NSLog пишет туда же).
    realStderr = dup(2)
    guard dup2(write, 2) >= 0 else {
      close(read)
      close(write)
      return
    }
    close(write)

    let source = DispatchSource.makeReadSource(fileDescriptor: read, queue: queue)
    source.setEventHandler { [weak self] in
      self?.drain(read)
    }
    source.setCancelHandler { close(read) }
    source.resume()
    readSource = source
  }

  private func drain(_ fd: Int32) {
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let count = Darwin.read(fd, &buffer, buffer.count)
      if count <= 0 { break }

      if realStderr >= 0 {
        _ = buffer.withUnsafeBytes { raw in
          Darwin.write(realStderr, raw.baseAddress, count)
        }
      }

      tail.append(contentsOf: buffer[0..<count])
      consumeLines()
      if count < buffer.count { break }
    }
  }

  private func consumeLines() {
    let newline = UInt8(ascii: "\n")
    while let index = tail.firstIndex(of: newline) {
      let line = String(decoding: tail[tail.startIndex..<index], as: UTF8.self)
      tail = Data(tail[tail.index(after: index)...])
      handle(line: line)
    }
    // Ограничение на случай, если в stderr польётся что-то без переводов
    // строки: хвост не должен расти бесконечно.
    if tail.count > 64 * 1024 {
      tail = Data()
    }
  }

  private func handle(line: String) {
    if let range = line.range(of: "[SOCKS5] CONNECT ") {
      let target = line[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
      lock.lock()
      connections += 1
      lastTarget = target.isEmpty ? nil : target
      lastAt = Date()
      lock.unlock()
      return
    }
    if line.contains("[SOCKS5] Dial failed") {
      lock.lock()
      failures += 1
      lock.unlock()
    }
  }
}
