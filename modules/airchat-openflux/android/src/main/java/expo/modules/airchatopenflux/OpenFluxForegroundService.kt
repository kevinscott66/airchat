package expo.modules.airchatopenflux

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Держит процесс живым, пока поднят туннель.
 *
 * В отличие от [XrayForegroundService] соседнего модуля, здесь сервис ничего не
 * запускает: ядро OpenFlux живёт внутри того же процесса (это Go, загруженный
 * через JNI), отдельного бинарника нет. Сервис нужен ровно за тем, ради чего
 * его и придумали, — сказать Android, что процесс занят делом. Без этого
 * свёрнутое приложение через несколько минут усыпляют, туннель рвётся, и
 * сообщения перестают приходить именно тогда, когда на телефон не смотрят.
 *
 * Тип dataSync, а не connectedDevice/specialUse: мы действительно синхронизируем
 * данные через сеть, и это единственный тип, который Android принимает без
 * дополнительных разрешений.
 */
class OpenFluxForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val ch = NotificationChannel(CHANNEL_ID, "AirChat", NotificationManager.IMPORTANCE_LOW)
      // IMPORTANCE_LOW и без звука: уведомление тут служебное, его задача —
      // существовать, а не сообщать.
      nm.createNotificationChannel(ch)
    }
    startForeground(NOTIFICATION_ID, buildNotification())
    // START_STICKY: если систему всё же прижало и процесс сняли, сервис стоит
    // поднять обратно — контроллер на стороне JS увидит опущенный туннель и
    // переподнимет ядро.
    return START_STICKY
  }

  override fun onDestroy() {
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
      .setContentText("OpenFlux: канал через документ поднят")
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "airchat_openflux"
    // Свой номер: у VPN-сервиса 10042, и совпадение погасило бы чужое
    // уведомление вместе со своим.
    private const val NOTIFICATION_ID = 10043
  }
}
