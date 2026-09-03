// AirChatScreenGuard — переписка не попадает на снимок экрана (v4.32.570).
//
// Как это работает и почему выглядит трюком. iOS не даёт приложению запретить
// снимок экрана, но исключает из ленты захвата содержимое защищённого поля
// ввода (UITextField.isSecureTextEntry): глазу оно видно, на снимке и в записи
// экрана — нет. Внутри такого поля есть вьюха-холст, на которой поле рисует
// себя; мы растягиваем её на всю обёртку и складываем детей в неё, а не в
// себя. Координаты при этом не меняются — холст совпадает с обёрткой границами,
// — поэтому разметка, касания и прокрутка остаются прежними.
//
// Опора на внутреннее устройство UIKit здесь честно ограничена: если холст не
// найден (Apple переставила внутренности), дети кладутся как обычно, ничего не
// ломается, а `isSupported` отвечает false — и приложение говорит человеку, что
// скрыть переписку со снимка на этом устройстве не выйдет, вместо молчаливого
// обещания, которого никто не выполняет.
import ExpoModulesCore
import UIKit

/// Достаёт вьюху-холст у защищённого поля. Холст появляется после разметки,
/// поэтому поле сначала раскладывают, а потом спрашивают.
private func secureCanvas(of field: UITextField) -> UIView? {
  field.isSecureTextEntry = true
  field.layoutIfNeeded()
  return field.subviews.first
}

final class SecureContentView: ExpoView {
  private let secureField = UITextField()
  /// Холст защищённого поля: с ним дети скрыты со снимка, без него — обычная вьюха.
  private var canvas: UIView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    secureField.isSecureTextEntry = true
    secureField.isUserInteractionEnabled = false
    secureField.backgroundColor = .clear
    secureField.frame = bounds
    super.addSubview(secureField)
    guard let host = secureCanvas(of: secureField) else { return }
    host.isUserInteractionEnabled = true
    host.translatesAutoresizingMaskIntoConstraints = false
    super.addSubview(host)
    NSLayoutConstraint.activate([
      host.topAnchor.constraint(equalTo: topAnchor),
      host.leadingAnchor.constraint(equalTo: leadingAnchor),
      host.trailingAnchor.constraint(equalTo: trailingAnchor),
      host.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    canvas = host
  }

  // Дети приезжают от React (и на старой архитектуре, и на Fabric) обычным
  // addSubview/insertSubview — перехватываем ровно эти две двери.
  override func addSubview(_ view: UIView) {
    if let host = canvas, view !== host, view !== secureField {
      host.addSubview(view)
    } else {
      super.addSubview(view)
    }
  }

  override func insertSubview(_ view: UIView, at index: Int) {
    if let host = canvas, view !== host, view !== secureField {
      host.insertSubview(view, at: min(index, host.subviews.count))
    } else {
      super.insertSubview(view, at: index)
    }
  }

  // Размер холста держит автолейаут, но поле живёт вне его — ему хватит рамки.
  override func layoutSubviews() {
    super.layoutSubviews()
    secureField.frame = CGRect(origin: .zero, size: CGSize(width: 1, height: 1))
  }
}

public class AirChatScreenGuardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AirChatScreenGuard")

    // Проверяем ровно то, на чём держится трюк: находится ли холст у
    // защищённого поля. Не находится — значит скрывать нечем, и врать нельзя.
    Function("isSupported") { () -> Bool in
      let field = UITextField(frame: CGRect(x: 0, y: 0, width: 64, height: 32))
      return secureCanvas(of: field) != nil
    }

    // На iOS окно целиком не закрывается: скрывается только то, что обёрнуто
    // вьюхой. Функция оставлена ради общего интерфейса с Android.
    AsyncFunction("setWindowSecure") { (_: Bool) in }

    View(SecureContentView.self) {}
  }
}
