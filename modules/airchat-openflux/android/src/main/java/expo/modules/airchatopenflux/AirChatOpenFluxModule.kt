package expo.modules.airchatopenflux

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** Ядра нет в сборке — не ошибка, а состояние: iOS, web и не-arm64 живут без туннеля. */
internal class OpenFluxUnavailableException :
  CodedException("ERR_OPENFLUX_UNAVAILABLE", "Ядро OpenFlux недоступно в этой сборке", null)

/** Текст сюда приходит от ядра — он и попадает пользователю в «Повторить». */
internal class OpenFluxStartException(message: String) :
  CodedException("ERR_OPENFLUX_START", message, null)

/**
 * Значения по умолчанию совпадают с DEFAULT_CONFIG.openflux (src/core/config.ts).
 * Дублирование тут осознанное: JS может прислать запись без поля, и тогда лучше
 * поднять туннель на разумных значениях, чем упасть на пустой строке.
 */
class OpenFluxStartOptions(
  @Field val transport: String = "yandex",
  @Field val docUrl: String = "",
  @Field val socksAddr: String = "127.0.0.1:0",
  @Field val dns: String = "1.1.1.1:53"
) : Record

/**
 * Туннель OpenFlux: ядро на Go внутри процесса + подмена ProxySelector.
 *
 * Модуль намеренно почти не содержит логики повторов и расписаний — этим
 * занимается openFluxController на стороне JS, где видно и настройки, и
 * состояние сети, и экран. Здесь только то, что нельзя сделать из JS: поднять
 * ядро, увести в него сокеты всего процесса и не дать Android усыпить туннель.
 */
class AirChatOpenFluxModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AirChatOpenFlux")

    OnCreate {
      // Селектор ставится сразу, а не при первом старте туннеля: подменять его
      // посреди работы приложения — лишняя гонка с потоками OkHttp, а пока
      // туннель опущен, подмена ничего не меняет (всё уходит в DIRECT).
      OpenFluxProxy.install()
    }

    AsyncFunction("isSupported") {
      OpenFluxNative.isAvailable
    }

    // runOnQueue(DEFAULT) — это и так поведение по умолчанию, но здесь оно
    // принципиально: OpenFluxStart ходит в сеть (открывает документ, ждёт
    // ответа Яндекса) и на главном потоке дал бы ANR.
    AsyncFunction("start") { options: OpenFluxStartOptions ->
      startTunnel(options)
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("stop") {
      stopTunnel()
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("isRunning") {
      OpenFluxNative.isAvailable && OpenFluxNative.nativeIsRunning()
    }

    AsyncFunction("socksAddr") {
      if (OpenFluxNative.isAvailable) OpenFluxNative.nativeSocksAddr() else null
    }

    OnDestroy {
      // Перезагрузка JS (dev-reload, смена пользователя) пересоздаёт модуль, но
      // не процесс: ядро осталось бы поднятым и на следующий start ответило бы
      // «клиент уже запущен». Поэтому туннель гасим вместе с контекстом.
      if (OpenFluxNative.isAvailable && OpenFluxNative.nativeIsRunning()) {
        stopTunnel()
      }
    }
  }

  private fun startTunnel(options: OpenFluxStartOptions): String {
    if (!OpenFluxNative.isAvailable) {
      throw OpenFluxUnavailableException()
    }

    // Ссылка на документ — это ключ к нему, а не настройка: в репозиторий она
    // не кладётся и в сборке без EXPO_PUBLIC_OPENFLUX_DOC_URL приходит пустой.
    // Отвечаем внятно, а не невнятной ошибкой ядра.
    val docUrl = options.docUrl.trim()
    if (docUrl.isEmpty()) {
      throw OpenFluxStartException("В этой сборке не задана ссылка на документ OpenFlux")
    }

    val transport = options.transport.trim().ifEmpty { "yandex" }
    val socksAddr = options.socksAddr.trim().ifEmpty { "127.0.0.1:0" }
    val dns = options.dns.trim().ifEmpty { "1.1.1.1:53" }

    // Ни docUrl, ни текста ошибки с ним в лог не пишем: logcat читается с
    // устройства кем угодно, а ссылка даёт право писать в документ.
    Log.i(TAG, "поднимаю туннель: транспорт=$transport, socks=$socksAddr")

    val error = OpenFluxNative.nativeStart(transport, docUrl, socksAddr, dns)
    if (error != null) {
      throw OpenFluxStartException(error)
    }

    val actualAddr = OpenFluxNative.nativeSocksAddr()
    if (actualAddr.isNullOrBlank()) {
      // Без адреса туннель бесполезен — трафик в него не увести. Оставлять
      // ядро поднятым в таком виде нельзя, иначе следующий старт упрётся в
      // «клиент уже запущен».
      OpenFluxNative.nativeStop()
      throw OpenFluxStartException("Ядро поднялось, но не сообщило адрес SOCKS5")
    }

    OpenFluxProxy.enable(actualAddr)
    startKeepAliveService()
    return actualAddr
  }

  private fun stopTunnel() {
    // Сначала возвращаем трафик напрямую и только потом гасим ядро: наоборот —
    // это окно, в котором новые соединения идут в уже мёртвый SOCKS5.
    OpenFluxProxy.disable()
    stopKeepAliveService()
    if (OpenFluxNative.isAvailable) {
      OpenFluxNative.nativeStop()
    }
  }

  private fun startKeepAliveService() {
    val ctx: Context = appContext.reactContext ?: return
    try {
      val intent = Intent(ctx, OpenFluxForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
    } catch (t: Throwable) {
      // С Android 12 запуск foreground-сервиса из фона запрещён. Туннель при
      // этом уже поднят и работает — рушить старт из-за сервиса неправильно:
      // без сервиса он просто проживёт до усыпления процесса.
      Log.w(TAG, "не удалось поднять foreground-сервис, туннель остаётся без защиты от усыпления", t)
    }
  }

  private fun stopKeepAliveService() {
    val ctx: Context = appContext.reactContext ?: return
    try {
      ctx.stopService(Intent(ctx, OpenFluxForegroundService::class.java))
    } catch (t: Throwable) {
      Log.w(TAG, "не удалось погасить foreground-сервис", t)
    }
  }

  companion object {
    private const val TAG = "AirChatOpenFlux"
  }
}
