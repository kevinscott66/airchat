package expo.modules.airchatopenflux

import android.util.Log
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI

/**
 * Переводит весь исходящий трафик приложения на локальный SOCKS5 ядра.
 *
 * Почему именно ProxySelector, а не настройка клиента. React Native ходит в
 * сеть через OkHttp — и `fetch`, и `WebSocket` (на нём держится ntfy, то есть
 * главный канал AirChat). Клиентов этих в процессе несколько, создаются они в
 * разное время и до нас: часть — внутри RN, часть — внутри Expo. Задать им
 * прокси поимённо нельзя, а вот OkHttp, которому прокси не задали явно,
 * спрашивает `ProxySelector.getDefault()` на каждое новое соединение. Значит
 * один подменённый селектор разворачивает и уже созданные клиенты, и
 * переключается на лету — без перезапуска приложения.
 *
 * Известное ограничение: выбор действует на НОВЫЕ соединения. Уже открытый
 * сокет (тот самый веб-сокет ntfy) после включения туннеля продолжит идти
 * прежним путём, пока его не закроют. Поэтому переключение туннеля в настройках
 * перезапускает интернет-транспорт (см. OpenFluxSettingsSection) — иначе оно
 * выглядело бы как «включил, а ничего не изменилось».
 *
 * При автозапуске перезапуск не нужен: туннель поднимается на загрузке конфига,
 * задолго до того, как появятся ключи и стартует транспорт. А в сети с белым
 * списком, ради которой всё и делается, прежнего соединения попросту нет —
 * оно там не открывается.
 */
internal object OpenFluxProxy : ProxySelector() {
  private const val TAG = "AirChatOpenFlux"

  private val direct = listOf(Proxy.NO_PROXY)

  /** Прежний селектор: ему отдаём выбор, когда туннель опущен. */
  @Volatile
  private var previous: ProxySelector? = null

  /**
   * Куда уводить трафик. `null` — туннеля нет, ходим напрямую.
   * @Volatile, потому что пишет его поток модуля, а читают потоки OkHttp.
   */
  @Volatile
  private var tunnel: List<Proxy>? = null

  @Volatile
  private var installed = false

  /**
   * Встать глобальным селектором. Ставится один раз при создании модуля, ещё до
   * того, как туннель кому-то понадобился: подменять селектор в момент, когда
   * приложение уже вовсю ходит в сеть, — лишняя гонка, а пока `tunnel == null`
   * подмена ничего не меняет.
   */
  @Synchronized
  fun install() {
    if (installed) {
      return
    }
    val current = ProxySelector.getDefault()
    // Защита от повторной установки через другой путь: иначе селектор стал бы
    // запасным самому себе и первый же DIRECT ушёл в бесконечную рекурсию.
    previous = if (current === this) previous else current
    ProxySelector.setDefault(this)
    installed = true
  }

  /**
   * Включить туннель. [socksAddr] — то, что вернуло ядро, вида `127.0.0.1:54321`.
   * Кривой адрес не роняет старт, но и трафик никуда не уводит: лучше остаться
   * без туннеля, чем без сети.
   */
  fun enable(socksAddr: String) {
    val parsed = parse(socksAddr)
    if (parsed == null) {
      Log.e(TAG, "не разобрал адрес SOCKS5: $socksAddr")
      tunnel = null
      return
    }
    tunnel = listOf(Proxy(Proxy.Type.SOCKS, parsed))
    Log.i(TAG, "трафик приложения переведён на $socksAddr")
  }

  /** Выключить туннель: новые соединения снова пойдут напрямую. */
  fun disable() {
    if (tunnel != null) {
      Log.i(TAG, "трафик приложения возвращён напрямую")
    }
    tunnel = null
  }

  override fun select(uri: URI?): List<Proxy> {
    val active = tunnel ?: return previousSelect(uri)
    // Свои же локальные адреса — всегда напрямую. Сам SOCKS5 ядра висит на
    // 127.0.0.1, и без этой ветки соединение с прокси шло бы через прокси,
    // то есть зациклилось бы на первом же запросе.
    if (isLoopback(uri?.host)) {
      return direct
    }
    return active
  }

  override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
    // Прежний селектор мог вести свою статистику отказов (так делает, например,
    // системный PAC). Молча её обрывать незачем.
    val prev = previous
    if (prev != null && uri != null && sa != null && ioe != null) {
      try {
        prev.connectFailed(uri, sa, ioe)
      } catch (t: Throwable) {
        Log.w(TAG, "прежний ProxySelector споткнулся на connectFailed", t)
      }
    }
  }

  private fun previousSelect(uri: URI?): List<Proxy> {
    val prev = previous ?: return direct
    if (uri == null) {
      return direct
    }
    return try {
      prev.select(uri)?.takeIf { it.isNotEmpty() } ?: direct
    } catch (t: Throwable) {
      Log.w(TAG, "прежний ProxySelector споткнулся на select", t)
      direct
    }
  }

  /**
   * 10.0.2.2 здесь не случайно: это адрес хостовой машины внутри эмулятора, по
   * нему в отладочной сборке живёт Metro. Увести его в туннель — значит
   * остаться без обновления бандла. На реальном устройстве Metro виден по
   * адресу в локальной сети, и его отсюда не опознать — это цена решения,
   * отладочные сборки на устройстве при поднятом туннеле грузят бандл до его
   * включения.
   */
  private fun isLoopback(host: String?): Boolean {
    if (host.isNullOrBlank()) {
      return true
    }
    val h = host.trim().lowercase().removeSurrounding("[", "]")
    return h == "localhost" ||
      h == "::1" ||
      h == "0:0:0:0:0:0:0:1" ||
      h == "10.0.2.2" ||
      h.startsWith("127.")
  }

  private fun parse(socksAddr: String): InetSocketAddress? {
    val trimmed = socksAddr.trim()
    val sep = trimmed.lastIndexOf(':')
    if (sep <= 0 || sep == trimmed.length - 1) {
      return null
    }
    val host = trimmed.substring(0, sep).removeSurrounding("[", "]")
    val port = trimmed.substring(sep + 1).toIntOrNull() ?: return null
    if (port !in 1..65535 || host.isBlank()) {
      return null
    }
    return try {
      InetSocketAddress(host, port)
    } catch (t: Throwable) {
      Log.w(TAG, "не создал адрес SOCKS5 из $socksAddr", t)
      null
    }
  }
}
