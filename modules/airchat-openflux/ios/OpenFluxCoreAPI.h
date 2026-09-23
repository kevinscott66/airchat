/*
 * C-API ядра OpenFlux (Go, сборка с тегом mobile) — объявления для Swift.
 *
 * Почему заголовок написан руками, а не взят сгенерированный. На Android в
 * модуль кладётся тот самый liboflux.h, который выплюнул cgo, — там он нужен
 * JNI-обёртке и лежит рядом с .so, то есть появляется и исчезает вместе с
 * ядром. Здесь так нельзя: ядро в git не хранится (30 МБ, полностью
 * получаются из исходников), а модуль обязан собираться и в свежем клоне, где
 * ядра ещё нет. Сгенерированный заголовок там отсутствовал бы, и приложение не
 * компилировалось бы вовсе — вместо честного «туннель недоступен».
 *
 * Объявления без вызовов ничего не требуют от линковщика: пока Swift не зовёт
 * эти функции (флаг AIRCHAT_OPENFLUX_CORE выключен, см. подspec), символов в
 * объектных файлах не появляется, и отсутствие архива никого не смущает.
 *
 * Расхождение с настоящим ядром ловится при сборке: scripts/build-openflux-ios.sh
 * сверяет эти строки с тем, что сгенерировал cgo, и останавливается, если
 * сигнатуры разошлись. Иначе приложение слинковалось бы с неверным объявлением
 * и упало бы уже на устройстве.
 *
 * Главное правило ядра: строки, которые вернули OpenFluxStart и
 * OpenFluxSocksAddr, выделены внутри Go через C.CString. Освобождать их обязан
 * вызывающий, и только через OpenFluxFree — free() из другой libc не подходит.
 */
#ifndef AIRCHAT_OPENFLUX_CORE_API_H
#define AIRCHAT_OPENFLUX_CORE_API_H

#ifdef __cplusplus
extern "C" {
#endif

/* Включает отладочный вывод ядра в stderr — в том числе строку
 * "[SOCKS5] CONNECT host:port" на каждое соединение, которое реально пошло
 * через туннель. Выключить обратно нельзя: в ядре это односторонний флаг. */
extern void OpenFluxSetDebug(int on);

/* NULL при успехе, иначе текст ошибки (его же показываем пользователю).
 * maxToken/maxUID нужны транспорту Max; у нас документ Яндекса, который
 * авторизуется ссылкой, — туда уходят пустые строки. */
extern char* OpenFluxStart(char* transportName, char* docURL, char* maxToken, char* maxUID, char* socksAddr, char* dns);

/* Фактический адрес локального SOCKS5 ("127.0.0.1:54321"). Опущенный туннель
 * ядро описывает пустой строкой, а не NULL. */
extern char* OpenFluxSocksAddr(void);

extern int OpenFluxIsRunning(void);
extern void OpenFluxStop(void);
extern void OpenFluxFree(char* p);

/* ── Живость канала и смена сети ─────────────────────────────────────────── */

/* Сказать ядру, что сетевой путь сменился: рвёт несущий сокет и сбрасывает
 * экспоненту паузы переподключения. Без этого вызова туннель после
 * переключения Wi-Fi ↔ LTE или включения постороннего VPN встаёт не сразу, а
 * по дедлайну чтения — десятки секунд. Звать безопасно до Start, после Stop и
 * несколько раз подряд: система на одном переключении присылает пачку
 * событий. */
extern int OpenFluxNetworkChanged(void);

/* Есть ли живой канал ПРЯМО СЕЙЧАС. Отличается от OpenFluxIsRunning, который
 * отвечает лишь «объект существует» и остаётся единицей на мёртвом туннеле. */
extern int OpenFluxIsConnected(void);

/* JSON состояния: connected, mode, socks_addr, байты и пакеты в обе стороны,
 * reconnects, uptime_ms. Растущий reconnects при нулевом bytes_received —
 * единственный способ увидеть с телефона, что ядро крутится в цикле.
 * Строку освобождать через OpenFluxFree. */
extern char* OpenFluxState(void);

/* ── Режим системного VPN ────────────────────────────────────────────────── */

/* На iOS не используется: здесь туннель app-scoped (локальный SOCKS5 +
 * proxyConfigurations), права Network Extension у команды нет. Объявления
 * держим только потому, что сборочный скрипт сверяет заголовок с C-API ядра
 * целиком и останавливается на любом расхождении. */
extern char* OpenFluxTunStart(char* transportName, char* docURL, char* maxToken, char* maxUID, char* dns, int mtu);
extern void OpenFluxTunWritePacket(char* buf, int n);
extern int OpenFluxTunReadPacket(char* buf, int capacity);
extern char* OpenFluxTunStats(void);
extern int OpenFluxTunIsRunning(void);
extern void OpenFluxTunStop(void);

#ifdef __cplusplus
}
#endif

#endif /* AIRCHAT_OPENFLUX_CORE_API_H */
