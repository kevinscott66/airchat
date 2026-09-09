package expo.modules.airchatvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Запускает Xray, упакованный вместе с подписанным APK, и локальный SOCKS5.
 * Полноценный системный VPN (TUN) здесь не поднимается — маршрутизация
 * поддерживаемого HTTP идёт через OkHttp+SOCKS в [AirChatVpnModule].
 */
class XrayForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  private var xrayProcess: Process? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val configJson = intent?.getStringExtra(EXTRA_CONFIG) ?: run {
      stopSelf()
      return START_NOT_STICKY
    }
    val socksPort = intent.getIntExtra(EXTRA_SOCKS_PORT, 0)
    if (socksPort !in 1..65535) {
      Log.e(TAG, "invalid local SOCKS port")
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
        if (!waitForSocksListener(p, socksPort)) {
          p.destroyForcibly()
          xrayProcess = null
          throw IllegalStateException("Xray did not open the local SOCKS listener")
        }
        isRunningFlag = true
        val pid = try {
          val m = java.lang.Process::class.java.getMethod("pid")
          (m.invoke(p) as Long).toInt()
        } catch (_: Throwable) {
          -1
        }
        Log.i(TAG, "xray process started pid=$pid")
        Thread {
          try {
            p.waitFor()
          } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
          } finally {
            if (xrayProcess === p) {
              xrayProcess = null
              isRunningFlag = false
              stopSelf(startId)
            }
          }
        }.start()
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

  private fun xrayBinaryFile(): File = xrayBinaryFromApk()

  private fun ensureXrayBinary() {
    val fromApk = xrayBinaryFromApk()
    if (fromApk.exists() && fromApk.length() > 1_000_000L) {
      return
    }

    throw IllegalStateException("Xray binary is missing from this signed APK")
  }

  private fun waitForSocksListener(process: Process, port: Int): Boolean {
    val deadline = System.nanoTime() + 6_000_000_000L
    while (System.nanoTime() < deadline) {
      if (!process.isAlive) return false
      try {
        Socket().use { socket ->
          socket.connect(InetSocketAddress("127.0.0.1", port), 250)
          return true
        }
      } catch (_: Exception) {
        try {
          Thread.sleep(100)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          return false
        }
      }
    }
    return false
  }

  companion object {
    private const val TAG = "AirChatXray"
    const val EXTRA_CONFIG = "config_json"
    const val EXTRA_SOCKS_PORT = "socks_port"
    private const val CHANNEL_ID = "airchat_vpn"
    private const val NOTIFICATION_ID = 10042
    @Volatile
    var isRunningFlag: Boolean = false
  }
}
