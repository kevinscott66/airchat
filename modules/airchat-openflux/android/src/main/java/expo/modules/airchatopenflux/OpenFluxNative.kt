package expo.modules.airchatopenflux

import android.util.Log

/**
 * Тонкая прослойка над C-API ядра OpenFlux (cpp/openflux_jni.c).
 *
 * Отдельным объектом, а не методами модуля: ядро в процессе одно (в Go это
 * глобальный клиент под мьютексом), и «одно на процесс» честнее выражается
 * object'ом, чем экземпляром модуля, который Expo создаёт и пересоздаёт.
 */
internal object OpenFluxNative {
  private const val TAG = "AirChatOpenFlux"

  /**
   * Есть ли ядро в этой сборке. Собирается только под arm64 (см. build.gradle),
   * поэтому на x86_64-эмуляторе загрузка честно не удаётся — и туннель должен
   * ответить «не поддерживается», а не уронить приложение при первом вызове.
   */
  val isAvailable: Boolean = try {
    // Сначала ядро, потом обёртка: обёртка на него слинкована, и порядок
    // избавляет от сюрпризов на старых загрузчиках.
    System.loadLibrary("openflux")
    System.loadLibrary("openflux_jni")
    true
  } catch (t: Throwable) {
    Log.w(TAG, "ядро OpenFlux недоступно в этой сборке", t)
    false
  }

  /** Поднять ядро. `null` — получилось, иначе текст ошибки от ядра. */
  external fun nativeStart(transport: String, docUrl: String, socksAddr: String, dns: String): String?

  /** Фактический адрес локального SOCKS5, пока туннель поднят, иначе `null`. */
  external fun nativeSocksAddr(): String?

  external fun nativeIsRunning(): Boolean

  external fun nativeStop()

  external fun nativeSetDebug(on: Boolean)
}
