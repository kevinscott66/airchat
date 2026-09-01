package expo.modules.airchatvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.system.Os
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * Загружает бинарник Xray (релиз GitHub), пишет config и запускает локальный SOCKS5.
 * Полноценный системный VPN (TUN) здесь не поднимается — маршрутизация IPFS HTTP идёт через OkHttp+SOCKS в [AirChatVpnModule].
 */
class XrayForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  private var xrayProcess: Process? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val configJson = intent?.getStringExtra(EXTRA_CONFIG) ?: run {
      stopSelf()
      return START_NOT_STICKY
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val ch = NotificationChannel(CHANNEL_ID, "AirChat", NotificationManager.IMPORTANCE_LOW)
      nm.createNotificationChannel(ch)
    }
    startForeground(NOTIFICATION_ID, buildNotification())

    Thread {
      try {
        xrayProcess?.destroyForcibly()
        xrayProcess = null
        isRunningFlag = false

        ensureXrayBinary()
        val cfgFile = File(cacheDir, "xray_config.json")
        cfgFile.writeText(configJson)

        val bin = xrayBinaryFile()
        val pb = ProcessBuilder(bin.absolutePath, "run", "-c", cfgFile.absolutePath)
        pb.redirectErrorStream(true)
        val p = pb.start()
        xrayProcess = p
        isRunningFlag = true
        val pid = try {
          val m = java.lang.Process::class.java.getMethod("pid")
          (m.invoke(p) as Long).toInt()
        } catch (_: Throwable) {
          -1
        }
        Log.i(TAG, "xray process started pid=$pid")
      } catch (e: Exception) {
        Log.e(TAG, "xray failed: ${e.javaClass.simpleName}: ${e.message}", e)
        isRunningFlag = false
      }
    }.start()

    return START_STICKY
  }

  override fun onDestroy() {
    try {
      xrayProcess?.destroyForcibly()
    } catch (_: Exception) {
    }
    xrayProcess = null
    isRunningFlag = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("AirChat")
      .setContentText("Защищённый канал (SOCKS)")
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .build()
  }

  /** Бинарник из APK (jniLibs/libairchat_xray.so) — путь, откуда SELinux разрешает exec. */
  private fun xrayBinaryFromApk(): File {
    val nld = applicationInfo.nativeLibraryDir ?: return File("")
    val direct = File(nld, "libairchat_xray.so")
    if (direct.exists() && direct.length() > 1_000_000L) {
      return direct
    }
    // На части OEM каталог на диске — lib/arm64, а nativeLibraryDir — …/lib/arm64-v8a (файла там нет).
    val libParent = File(nld).parentFile ?: return direct
    for (abi in listOf("arm64", "arm64-v8a", "x86_64")) {
      val alt = File(libParent, "$abi/libairchat_xray.so")
      if (alt.exists() && alt.length() > 1_000_000L) {
        return alt
      }
    }
    return direct
  }

  /** Fallback: скачивание в code_cache (на части OEM всё равно не исполняется). */
  private fun xrayBinaryDownloaded(): File = File(codeCacheDir, "xray_bin")

  private fun xrayBinaryFile(): File {
    val apk = xrayBinaryFromApk()
    if (apk.exists() && apk.length() > 1_000_000L) {
      return apk
    }
    return xrayBinaryDownloaded()
  }

  private fun ensureXrayBinary() {
    val fromApk = xrayBinaryFromApk()
    if (fromApk.exists() && fromApk.length() > 1_000_000L) {
      return
    }

    val out = xrayBinaryDownloaded()
    if (out.exists() && out.length() > 1_000_000L) {
      out.setExecutable(true, false)
      chmod755(out)
      return
    }

    // Релизы Xray v26+ публикуют Xray-android-arm64-v8a.zip / Xray-android-amd64.zip (старые имена *-64.zip — 404).
    val abis = Build.SUPPORTED_ABIS
    val zipName = when {
      abis.any { it.contains("arm64") || it == "aarch64" } -> "Xray-android-arm64-v8a.zip"
      abis.any { it.contains("x86_64") } -> "Xray-android-amd64.zip"
      else -> throw IllegalStateException(
        "Неподдерживаемая ABI: ${abis.joinToString()}. Нужны arm64-v8a или x86_64 (в релизе нет 32-бит Android zip).",
      )
    }

    val primary = "$DOWNLOAD_BASE/$XRAY_VERSION/$zipName"
    val urls = listOf(
      primary,
      "https://mirror.ghproxy.com/$primary",
    )

    var extracted = false
    var lastError: Exception? = null
    for (urlString in urls) {
      try {
        extracted = downloadAndExtractXrayZip(urlString, out)
        if (extracted) break
      } catch (e: Exception) {
        lastError = e
        Log.w(TAG, "xray zip failed: $urlString — ${e.message}")
      }
    }

    if (!extracted || !out.exists() || out.length() < 10_000L) {
      throw lastError ?: IllegalStateException("Не удалось извлечь xray из архива (GitHub недоступен?)")
    }
    out.setExecutable(true, false)
    chmod755(out)
  }

  /** @return true если бинарник записан и по размеру похож на xray */
  private fun downloadAndExtractXrayZip(urlString: String, out: File): Boolean {
    val conn = (URL(urlString).openConnection() as HttpURLConnection).apply {
      connectTimeout = 60_000
      readTimeout = 120_000
      instanceFollowRedirects = true
      setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36")
      setRequestProperty("Accept", "*/*")
    }
    try {
      conn.connect()
      val code = conn.responseCode
      if (code !in 200..299) {
        val err = try {
          conn.errorStream?.bufferedReader()?.use { it.readText() }?.take(160)?.replace("\r\n", " ")
        } catch (_: Exception) {
          null
        }
        Log.w(TAG, "HTTP $code for $urlString ${err ?: ""}")
        return false
      }
      var extracted = false
      ZipInputStream(conn.inputStream.buffered()).use { zis ->
        var entry = zis.nextEntry
        while (entry != null) {
          val name = entry.name
          if (!entry.isDirectory && (name == "xray" || name.endsWith("/xray"))) {
            FileOutputStream(out).use { fos -> zis.copyTo(fos) }
            extracted = true
            break
          }
          entry = zis.nextEntry
        }
      }
      return extracted && out.exists() && out.length() >= 10_000L
    } finally {
      conn.disconnect()
    }
  }

  private fun chmod755(f: File) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      try {
        Os.chmod(f.absolutePath, 493) // 0755
        return
      } catch (_: Throwable) {
      }
    }
    try {
      Runtime.getRuntime().exec(arrayOf("/system/bin/chmod", "755", f.absolutePath)).waitFor()
    } catch (_: Exception) {
    }
  }

  companion object {
    private const val TAG = "AirChatXray"
    const val EXTRA_CONFIG = "config_json"
    private const val CHANNEL_ID = "airchat_vpn"
    private const val NOTIFICATION_ID = 10042
    private const val XRAY_VERSION = "v26.2.6"
    private const val DOWNLOAD_BASE = "https://github.com/XTLS/Xray-core/releases/download"

    @Volatile
    var isRunningFlag: Boolean = false
  }
}
