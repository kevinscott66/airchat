// AirChatScreenGuard на Android (v4.32.570).
//
// Android умеет не то же самое, что iOS, и это различие не сглаживается.
// FLAG_SECURE закрывает окно целиком: снимок экрана система либо не делает
// вовсе, либо отдаёт чёрный кадр, и спрятать одну только ленту сообщений,
// оставив шапку, здесь нечем. Поэтому `isSupported` отвечает false — частичного
// скрытия нет, — а окно закрывается на время, пока открыта переписка с
// запретом.
package expo.modules.airchatscreenguard

import android.content.Context
import android.view.WindowManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView

/** Обёртка ничего не скрывает сама: на Android за это отвечает флаг окна. */
class SecureContentView(context: Context, appContext: AppContext) : ExpoView(context, appContext)

class AirChatScreenGuardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AirChatScreenGuard")

    Function("isSupported") { false }

    AsyncFunction("setWindowSecure") { enabled: Boolean ->
      val activity = appContext.currentActivity ?: return@AsyncFunction
      activity.runOnUiThread {
        if (enabled) {
          activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
          activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
      }
    }

    View(SecureContentView::class) {}
  }
}
