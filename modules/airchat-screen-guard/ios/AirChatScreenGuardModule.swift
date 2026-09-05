// AirChatScreenGuard — переписка не попадает на снимок экрана (v4.32.570,
// переписан после зависания v4.32.594).
//
// Как это работает и почему выглядит трюком. iOS не даёт приложению запретить
// снимок экрана, но исключает из ленты захвата содержимое защищённого поля
// ввода (UITextField.isSecureTextEntry): глазу оно видно, на снимке и в записи
// экрана — нет. Внутри такого поля есть вьюха-холст, на которой поле рисует
// себя; дети кладутся в неё, а не в обёртку. Координаты при этом не меняются —
// поле растянуто по обёртке, холст — по полю, — поэтому разметка, касания и
// прокрутка остаются прежними.
//
// ЧТО БЫЛО СЛОМАНО (v4.32.594). Первая версия ЗАБИРАЛА холст из поля себе и
// прибивала его своими констрейнтами. Холст полю принадлежит: на каждой своей
// разметке поле возвращало его обратно, а наши констрейнты тянули назад — и
// эти двое зацикливали проход разметки. Включение запрета из карточки профиля
// подменяло обёртку ленты сообщений ровно в этот момент, и приложение вставало
// намертво. Теперь холст остаётся там, где родился, а поле просто растянуто по
// обёртке: тянуть друг у друга нечего.
//
// Опора на внутреннее устройство UIKit здесь честно ограничена и падает в
// безопасную сторону: холст ищется по имени класса и по размеру, и если Apple
// переставила внутренности — детей кладём как обычно, `isSupported` отвечает
// false, и приложение говорит человеку, что скрыть переписку со снимка на этом
// устройстве не выйдет, вместо молчаливого обещания, которого никто не
// выполняет.
import ExpoModulesCore
import UIKit

/// Холст защищённого поля: та самая вьюха, содержимое которой не попадает в
/// захват экрана. Проверяем не «есть ли хоть какой-то ребёнок» (так проходило
/// что угодно), а имя класса и то, что вьюха действительно закрывает поле.
private func secureCanvas(of field: UITextField) -> UIView? {
  field.layoutIfNeeded()
  guard let host = field.subviews.first else { return nil }
  guard String(describing: type(of: host)).contains("Canvas") else { return nil }
  guard host.bounds.width > 0, host.bounds.height > 0 else { return nil }
  return host
}

/// Держится ли трюк на этом устройстве. Считается один раз на главном потоке:
/// UIKit с чужого потока трогать нельзя, а ждать главный из JS-потока — верный
/// способ получить второе зависание вместо вылеченного первого.
private final class SecureCanvasProbe {
  static let shared = SecureCanvasProbe()
  private var value = false

  private init() {
    if Thread.isMainThread {
      value = SecureCanvasProbe.probe()
    } else {
      DispatchQueue.main.async { [self] in value = SecureCanvasProbe.probe() }
    }
  }

  var supported: Bool { value }

  private static func probe() -> Bool {
    let field = UITextField(frame: CGRect(x: 0, y: 0, width: 64, height: 32))
    field.isSecureTextEntry = true
    return secureCanvas(of: field) != nil
  }
}

final class SecureContentView: ExpoView {
  private let secureField = UITextField()
  /// Холст защищённого поля: с ним дети скрыты со снимка, без него — обычная вьюха.
  private var canvas: UIView?
  /// Холст ищется один раз, когда у обёртки появился размер: у поля нулевой
  /// ширины холста нет, а спрашивать его на каждой разметке — это разметка,
  /// вызывающая разметку.
  private var canvasResolved = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    secureField.isSecureTextEntry = true
    // Поле — только подложка. Выключенное, оно не станет первым откликающимся и
    // не поднимет клавиатуру, но касания сквозь себя к детям пропускает:
    // hitTest смотрит на isUserInteractionEnabled, а не на isEnabled.
    secureField.isEnabled = false
    secureField.borderStyle = .none
    secureField.backgroundColor = .clear
    secureField.textColor = .clear
    secureField.translatesAutoresizingMaskIntoConstraints = false
    super.addSubview(secureField)
    NSLayoutConstraint.activate([
      secureField.topAnchor.constraint(equalTo: topAnchor),
      secureField.leadingAnchor.constraint(equalTo: leadingAnchor),
      secureField.trailingAnchor.constraint(equalTo: trailingAnchor),
      secureField.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  // Дети приезжают от React (и на старой архитектуре, и на Fabric) обычным
  // addSubview/insertSubview — перехватываем ровно эти две двери.
  override func addSubview(_ view: UIView) {
    if let host = canvas, view !== secureField {
      host.addSubview(view)
    } else {
      super.addSubview(view)
    }
  }

  override func insertSubview(_ view: UIView, at index: Int) {
    if let host = canvas, view !== secureField {
      host.insertSubview(view, at: min(index, host.subviews.count))
    } else {
      super.insertSubview(view, at: index)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    adoptCanvas()
  }

  /// Переселяет детей на холст, как только он появился. Дети могли приехать
  /// раньше первой разметки — тогда они лежат прямо в обёртке, и их надо
  /// перенести, сохранив порядок (subviews отдаются снизу вверх).
  private func adoptCanvas() {
    guard !canvasResolved, bounds.width > 0, bounds.height > 0 else { return }
    canvasResolved = true
    guard SecureCanvasProbe.shared.supported, let host = secureCanvas(of: secureField) else { return }
    host.isUserInteractionEnabled = true
    canvas = host
    for child in subviews where child !== secureField {
      host.addSubview(child)
    }
  }
}

public class AirChatScreenGuardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AirChatScreenGuard")

    // Опрос делается на главном потоке, поэтому его заводят заранее — при
    // создании модуля, а не первым вопросом из JS: иначе первый ответ был бы
    // «не умеем» просто потому, что главный поток ещё не дошёл до проверки.
    OnCreate {
      _ = SecureCanvasProbe.shared
    }

    // Проверяем ровно то, на чём держится трюк. Не держится — значит скрывать
    // нечем, и врать нельзя.
    Function("isSupported") { () -> Bool in
      SecureCanvasProbe.shared.supported
    }

    // На iOS окно целиком не закрывается: скрывается только то, что обёрнуто
    // вьюхой. Функция оставлена ради общего интерфейса с Android.
    AsyncFunction("setWindowSecure") { (_: Bool) in }

    View(SecureContentView.self) {}
  }
}
