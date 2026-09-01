package expo.modules.airchatvpn

import android.content.Intent
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit

class AirChatVpnModule : Module() {
  private var socksPort: Int = 10809

  companion object {
    private const val TAG = "AirChatVpn"
  }

  override fun definition() = ModuleDefinition {
    Name("AirChatVpn")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("start") { configJson: String, localSocksPort: Int ->
      socksPort = localSocksPort
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      try {
        val intent = Intent(ctx, XrayForegroundService::class.java)
        intent.putExtra(XrayForegroundService.EXTRA_CONFIG, configJson)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          ctx.startForegroundService(intent)
        } else {
          ctx.startService(intent)
        }
        true
      } catch (e: Exception) {
        Log.e("AirChatVpn", "start failed", e)
        false
      }
    }

    AsyncFunction("stop") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      try {
        ctx.stopService(Intent(ctx, XrayForegroundService::class.java))
        true
      } catch (e: Exception) {
        Log.e("AirChatVpn", "stop failed", e)
        false
      }
    }

    AsyncFunction("isRunning") {
      XrayForegroundService.isRunningFlag
    }

    AsyncFunction("fetchGet") { url: String, allowDirectFallback: Boolean? ->
      val allow = allowDirectFallback == true
      try {
        executeGet(socksClient(), url)
      } catch (e: Exception) {
        Log.w(TAG, "fetchGet via SOCKS failed, allowDirect=$allow", e)
        if (!allow) throw e
        try {
          executeGet(directClient(), url)
        } catch (e2: Exception) {
          Log.e(TAG, "fetchGet direct fallback failed", e2)
          throw e2
        }
      }
    }

    AsyncFunction("postMultipartFile") { url: String, fileUri: String, fieldName: String?, allowDirectFallback: Boolean? ->
      val allow = allowDirectFallback == true
      val path = fileUri.removePrefix("file://")
      val file = java.io.File(path)
      if (!file.isFile) {
        return@AsyncFunction mapOf("ok" to false, "status" to 0, "bodyText" to "file_not_found")
      }
      val field = fieldName?.takeIf { it.isNotBlank() } ?: "file"
      val body = MultipartBody.Builder()
        .setType(MultipartBody.FORM)
        .addFormDataPart(
          field,
          file.name,
          file.asRequestBody("application/octet-stream".toMediaType())
        )
        .build()
      try {
        executePostMultipart(socksClient(), url, body)
      } catch (e: Exception) {
        Log.w(TAG, "postMultipart via SOCKS failed, allowDirect=$allow", e)
        if (!allow) throw e
        try {
          executePostMultipart(directClient(), url, body)
        } catch (e2: Exception) {
          Log.e(TAG, "postMultipart direct fallback failed", e2)
          throw e2
        }
      }
    }
  }

  private fun executeGet(client: OkHttpClient, url: String): Map<String, Any> {
    val req = Request.Builder().url(url).get().build()
    client.newCall(req).execute().use { resp ->
      val bytes = resp.body?.bytes() ?: byteArrayOf()
      val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
      return mapOf(
        "ok" to resp.isSuccessful,
        "status" to resp.code,
        "bodyBase64" to b64
      )
    }
  }

  private fun executePostMultipart(client: OkHttpClient, url: String, body: RequestBody): Map<String, Any> {
    val req = Request.Builder().url(url).post(body).build()
    client.newCall(req).execute().use { resp ->
      val text = resp.body?.string() ?: ""
      return mapOf(
        "ok" to resp.isSuccessful,
        "status" to resp.code,
        "bodyText" to text
      )
    }
  }

  private fun socksClient(): OkHttpClient {
    val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort))
    return OkHttpClient.Builder()
      .proxy(proxy)
      .connectTimeout(45, TimeUnit.SECONDS)
      .readTimeout(120, TimeUnit.SECONDS)
      .writeTimeout(120, TimeUnit.SECONDS)
      .build()
  }

  private fun directClient(): OkHttpClient {
    return OkHttpClient.Builder()
      .connectTimeout(45, TimeUnit.SECONDS)
      .readTimeout(120, TimeUnit.SECONDS)
      .writeTimeout(120, TimeUnit.SECONDS)
      .build()
  }
}
