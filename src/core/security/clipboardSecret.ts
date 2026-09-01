/**
 * Секрет в буфере обмена: скопировать и убрать за собой (v4.32.314).
 *
 * Кнопка «Скопировать» под seed-фразой клала в буфер обмена двенадцать слов, из
 * которых целиком восстанавливается личность: ключи подписи, ключи переписки,
 * доступ ко всем аккаунтам. И оставляла их там навсегда.
 *
 * Буфер обмена — не частное место. Его читает экранная клавиатура (Gboard ведёт
 * собственную историю буфера и синхронизирует её), его читает системный
 * менеджер буфера на прошивках Samsung и Xiaomi, на Android 13+ содержимое
 * показывается всплывающей подсказкой поверх всего, а связка с Windows
 * отправляет его на другое устройство. Пережить перезапуск приложения буферу
 * тоже ничто не мешает. Двенадцать слов, попавшие в любое из этих мест, уже не
 * отозвать — ключи не меняются, менять пришлось бы личность.
 *
 * Поэтому копия здесь с истечением: через минуту буфер чистится сам. Правила
 * уборки два, и оба про то, чтобы не сделать хуже:
 *
 * 1. Чистим, только если в буфере всё ещё лежит ровно наш секрет. Успел человек
 *    скопировать что-то своё — это его буфер, не трогаем.
 * 2. Android 10+ не даёт читать и писать буфер приложению не в фокусе, и чтение
 *    возвращает пустую строку. Отличить «пусто, потому что нельзя прочитать» от
 *    «пусто, потому что и правда пусто» нельзя, поэтому пустой ответ означает
 *    «попробуем позже»: подписка на возвращение в приложение доводит уборку до
 *    конца. Это ровно тот случай, ради которого всё и затевалось — человек
 *    уходит вставить фразу в заметки и возвращается.
 *
 * Через GIVE_UP_MS после срока попытки прекращаются: буфер к тому времени либо
 * вычищен, либо давно перезаписан, а вечная подписка на AppState — это утечка.
 */
import { AppState, type NativeEventSubscription } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { log } from '../logger';

/** Сколько секрет живёт в буфере, прежде чем его уберут. */
export const SECRET_CLIPBOARD_TTL_MS = 60_000;

/** Сколько ещё пытаться после срока, если приложение всё это время в фоне. */
const GIVE_UP_MS = 10 * 60_000;

/**
 * Чем перезаписываем буфер.
 *
 * Пробел, а не пустая строка: часть менеджеров буфера считает пустой клип
 * отсутствием изменения и оставляет предыдущее содержимое на месте — то самое,
 * от которого мы избавляемся.
 */
const ERASED = ' ';

type Pending = { secret: string; dueAt: number; timer: ReturnType<typeof setTimeout> | null };

let pending: Pending | null = null;
let appStateSub: NativeEventSubscription | null = null;

function forget(): void {
  if (pending?.timer) clearTimeout(pending.timer);
  pending = null;
  appStateSub?.remove();
  appStateSub = null;
}

async function sweep(force = false): Promise<void> {
  const p = pending;
  if (!p) return;
  const now = Date.now();
  if (!force) {
    if (now < p.dueAt) return;
    if (now > p.dueAt + GIVE_UP_MS) {
      log.warn('clipboard_secret_give_up');
      forget();
      return;
    }
  }
  let current: string;
  try {
    current = await Clipboard.getStringAsync();
  } catch (e) {
    log.warn('clipboard_secret_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return;
  }
  // Пусто — скорее всего читать не дали (приложение не в фокусе). Ждём возвращения.
  if (current === '') return;
  // Лежит уже не наше — человек успел скопировать своё, это его буфер.
  if (current !== p.secret) {
    forget();
    return;
  }
  try {
    await Clipboard.setStringAsync(ERASED);
  } catch (e) {
    log.warn('clipboard_secret_clear_failed', { err: e instanceof Error ? e.message : String(e) });
    return;
  }
  log.info('clipboard_secret_cleared');
  forget();
}

/**
 * Положить секрет в буфер обмена так, чтобы он оттуда ушёл.
 *
 * Вызывающему стоит сказать человеку про срок: буфер, который чистится сам, —
 * приятная неожиданность только в одну сторону.
 */
export async function copySecretToClipboard(secret: string, ttlMs: number = SECRET_CLIPBOARD_TTL_MS): Promise<void> {
  await Clipboard.setStringAsync(secret);
  if (pending?.timer) clearTimeout(pending.timer);
  pending = { secret, dueAt: Date.now() + ttlMs, timer: null };
  pending.timer = setTimeout(() => {
    void sweep();
  }, ttlMs);
  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void sweep();
    });
  }
}

/**
 * Убрать секрет из буфера немедленно, не дожидаясь срока.
 *
 * Закрытие окна с seed-фразой сюда сознательно НЕ ведёт: скопировать и уйти
 * вставлять — это и есть обычный порядок действий, и очистка на закрытии сломала
 * бы ровно то, ради чего кнопку нажали. Зовёт отсюда полный сброс устройства: он
 * убирает расшифрованное из кэша, и оставить при этом двенадцать слов в буфере
 * значило бы вычистить всё, кроме самого ценного.
 */
export async function clearSecretClipboardNow(): Promise<void> {
  if (!pending) return;
  await sweep(true);
}
