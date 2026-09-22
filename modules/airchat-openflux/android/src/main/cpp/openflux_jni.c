/*
 * JNI-обёртка над C-API ядра OpenFlux (см. cpp/include/libopenflux.h).
 *
 * Обёртка намеренно тонкая: никакой логики, только перевод строк между JVM и
 * Go и аккуратное освобождение памяти. Всё решение о том, когда поднимать и
 * гасить туннель, живёт в Kotlin (AirChatOpenFluxModule) — там же, где
 * ProxySelector и foreground-сервис, и отлаживать его несравнимо проще, чем C.
 *
 * Главное правило ядра: строки, которые вернули OpenFluxStart и
 * OpenFluxSocksAddr, выделены внутри Go через C.CString. Их обязан освободить
 * вызывающий, и только через OpenFluxFree — free() из другой libc тут не
 * подходит.
 */
#include <jni.h>
#include <stddef.h>

#include "libopenflux.h"

/*
 * C-API объявляет параметры как char*, хотя ядро их только читает. Копию ради
 * одной константности делать незачем — снимаем const при передаче.
 */
static const char *jstr_begin(JNIEnv *env, jstring s) {
  if (s == NULL) {
    return NULL;
  }
  return (*env)->GetStringUTFChars(env, s, NULL);
}

static void jstr_end(JNIEnv *env, jstring s, const char *chars) {
  if (s != NULL && chars != NULL) {
    (*env)->ReleaseStringUTFChars(env, s, chars);
  }
}

/* Забирает строку у Go: переносит в JVM и сразу отдаёт память обратно ядру. */
static jstring take_go_string(JNIEnv *env, char *owned) {
  if (owned == NULL) {
    return NULL;
  }
  jstring result = (*env)->NewStringUTF(env, owned);
  OpenFluxFree(owned);
  return result;
}

JNIEXPORT jstring JNICALL
Java_expo_modules_airchatopenflux_OpenFluxNative_nativeStart(
    JNIEnv *env,
    jobject thiz,
    jstring transport,
    jstring docUrl,
    jstring socksAddr,
    jstring dns) {
  (void) thiz;

  /* Пустая строка вместо NULL: ядро зовёт C.GoString, а он NULL не любит. */
  static char empty[] = "";

  const char *c_transport = jstr_begin(env, transport);
  const char *c_doc_url = jstr_begin(env, docUrl);
  const char *c_socks_addr = jstr_begin(env, socksAddr);
  const char *c_dns = jstr_begin(env, dns);

  /*
   * maxToken/maxUID пустые: они нужны транспорту Max, а у нас документ Яндекса,
   * который авторизуется ссылкой. Контракт модуля (src/index.ts) их не знает и
   * знать не должен, пока транспорт один.
   */
  char *err = OpenFluxStart(
      (char *) (c_transport != NULL ? c_transport : empty),
      (char *) (c_doc_url != NULL ? c_doc_url : empty),
      empty,
      empty,
      (char *) (c_socks_addr != NULL ? c_socks_addr : empty),
      (char *) (c_dns != NULL ? c_dns : empty));

  jstr_end(env, transport, c_transport);
  jstr_end(env, docUrl, c_doc_url);
  jstr_end(env, socksAddr, c_socks_addr);
  jstr_end(env, dns, c_dns);

  /* NULL от ядра = успех, и он же становится null в Kotlin. */
  return take_go_string(env, err);
}

JNIEXPORT jstring JNICALL
Java_expo_modules_airchatopenflux_OpenFluxNative_nativeSocksAddr(
    JNIEnv *env,
    jobject thiz) {
  (void) thiz;

  char *addr = OpenFluxSocksAddr();
  if (addr == NULL) {
    return NULL;
  }
  /*
   * Опущенный туннель ядро описывает пустой строкой, а не NULL. Контракт
   * модуля обещает null — приводим здесь, чтобы Kotlin не повторял эту
   * особенность у себя.
   */
  if (addr[0] == '\0') {
    OpenFluxFree(addr);
    return NULL;
  }
  return take_go_string(env, addr);
}

JNIEXPORT jboolean JNICALL
Java_expo_modules_airchatopenflux_OpenFluxNative_nativeIsRunning(
    JNIEnv *env,
    jobject thiz) {
  (void) env;
  (void) thiz;

  return OpenFluxIsRunning() != 0 ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_expo_modules_airchatopenflux_OpenFluxNative_nativeStop(
    JNIEnv *env,
    jobject thiz) {
  (void) env;
  (void) thiz;

  OpenFluxStop();
}

JNIEXPORT void JNICALL
Java_expo_modules_airchatopenflux_OpenFluxNative_nativeSetDebug(
    JNIEnv *env,
    jobject thiz,
    jboolean on) {
  (void) env;
  (void) thiz;

  OpenFluxSetDebug(on == JNI_TRUE ? 1 : 0);
}
