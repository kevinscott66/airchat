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
 *
 * v4.32.834: уборка переживает снятие приложения.
 *
 * Дефект. Вся память об отложенной уборке — переменная `pending` в этом модуле.
 * Она не переживала ничего: снятие из многозадачности, падение, выгрузку по
 * нехватке памяти. А сценарий, ради которого модуль и написан, — «скопировал и
 * ушёл вставлять в заметки» — это ровно уход из приложения, то есть та самая
 * секунда, когда система выгружает фоновое. Приложение возвращалось без
 * `pending`, убирать за собой было некому, и двенадцать слов оставались в
 * буфере навсегда — при том что верхние строки этого же файла объясняют,
 * почему «навсегда в буфере» и есть непоправимое. Правило 2 делало промах
 * вероятнее, а не реже: пока приложение в фокусе, оно буфер прочитать не может
 * и честно ждёт возвращения — а возвращаться ему после выгрузки уже некуда.
 *
 * Правка. Рядом с копией на диск ложится расписка: отпечаток секрета и срок.
 * Сам секрет на диск не идёт — сравнить достаточно отпечатка, а вторая копия
 * двенадцати слов нужна здесь меньше всего. По той же причине и в памяти теперь
 * живёт отпечаток, а не слова. На следующем запуске `resumeSecretClipboardSweep`
 * поднимает расписку и продолжает с того же места, с обоими правилами выше.
 * Образец — `viewOncePending` (v4.32.828): там обещание «один показ» точно так
 * же держалось на таймере в памяти и точно так же его не пережило.
 */
import { AppState, type NativeEventSubscription } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { sha256 } from '@noble/hashes/sha2.js';
import { log } from '../logger';
import { kvDelete, kvSetChecked, kvTryGet } from '../storage/local';

/** Сколько секрет живёт в буфере, прежде чем его уберут. */
export const SECRET_CLIPBOARD_TTL_MS = 60_000;

/** Сколько ещё пытаться после срока, если приложение всё это время в фоне. */
const GIVE_UP_MS = 10 * 60_000;

/** Где лежит расписка. Одна на устройство: буфер обмена тоже один на всех. */
export const CLIPBOARD_SECRET_KEY = 'clipboard_secret_sweep';

/**
 * Чем перезаписываем буфер.
 *
 * Пробел, а не пустая строка: часть менеджеров буфера считает пустой клип
 * отсутствием изменения и оставляет предыдущее содержимое на месте — то самое,
 * от которого мы избавляемся.
 */
const ERASED = ' ';

/**
 * Отпечаток секрета — единственное, что мы о нём помним.
 *
 * Сравнить «то же самое лежит в буфере или уже чужое» отпечатка достаточно, а
 * восстановить из него нечего. Хранить рядом с буфером вторую копию тех же
 * двенадцати слов — ровно та беда, от которой этот модуль и защищает.
 *
 * Строка kv, где отпечаток лежит, не шифруется, и он на эти несколько минут
 * становится проверочным словом: у кого база и догадка, тот догадку подтвердит.
 * Подтверждать, впрочем, нечего — у двенадцати слов 128 бит, и кто их угадал,
 * тому проверка уже не нужна. Плата за это меньше, чем фраза, оставшаяся в
 * буфере навсегда.
 */
function fingerprint(secret: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(secret))).toString('hex');
}

type Pending = {
  hash: string;
  dueAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Легла ли расписка на диск: без неё и убирать с диска нечего. */
  shelved: boolean;
};

let pending: Pending | null = null;
let appStateSub: NativeEventSubscription | null = null;

/** Разобрать расписку. Испорченная — то же самое, что её отсутствие. */
function parseShelf(raw: string | null): { hash: string; dueAt: number } | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const { h, due } = v as { h?: unknown; due?: unknown };
  if (typeof h !== 'string' || h.length === 0) return null;
  if (typeof due !== 'number' || !Number.isFinite(due)) return null;
  return { hash: h, dueAt: due };
}

function forget(): void {
  const wasShelved = pending?.shelved === true;
  if (pending?.timer) clearTimeout(pending.timer);
  pending = null;
  appStateSub?.remove();
  appStateSub = null;
  // Расписку снимаем только если сами её и клали: лишний вызов поднял бы базу
  // там, где её могли намеренно закрыть (полный сброс устройства).
  if (wasShelved) void kvDelete(CLIPBOARD_SECRET_KEY);
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
  if (fingerprint(current) !== p.hash) {
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

/** Завести ожидание уборки: таймер и подписка на возвращение в приложение. */
function arm(hash: string, dueAt: number, shelved: boolean): void {
  if (pending?.timer) clearTimeout(pending.timer);
  pending = { hash, dueAt, timer: null, shelved };
  pending.timer = setTimeout(() => {
    void sweep();
  }, Math.max(0, dueAt - Date.now()));
  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void sweep();
    });
  }
}

/**
 * Положить секрет в буфер обмена так, чтобы он оттуда ушёл.
 *
 * Вызывающему стоит сказать человеку про срок: буфер, который чистится сам, —
 * приятная неожиданность только в одну сторону.
 */
export async function copySecretToClipboard(secret: string, ttlMs: number = SECRET_CLIPBOARD_TTL_MS): Promise<void> {
  await Clipboard.setStringAsync(secret);
  const dueAt = Date.now() + ttlMs;
  const hash = fingerprint(secret);
  const shelved = await kvSetChecked(CLIPBOARD_SECRET_KEY, JSON.stringify({ h: hash, due: dueAt }));
  // Расписка не легла — уборка в этом запуске всё равно состоится по таймеру,
  // потеряна только страховка на случай снятия приложения. Отказывать из-за
  // этого в самой копии было бы хуже: фразу человек иначе не перенесёт.
  if (!shelved) log.warn('clipboard_secret_shelf_write_failed');
  arm(hash, dueAt, shelved);
}

/**
 * Поднять расписку с диска, если своего ожидания в памяти нет (v4.32.834).
 *
 * Срок сдвигается на «сейчас», если он уже прошёл. GIVE_UP_MS отмеряет, сколько
 * мы готовы ждать доступа к буферу, — а доступ этот даётся приложению в фокусе,
 * то есть отсчитывать его надо от запуска, а не от копии, сделанной позавчера.
 * Со старым сроком единственная попытка после долгого перерыва сразу упиралась
 * бы в «пора сдаваться» — при том, что фраза всё это время лежала в буфере.
 */
async function armFromShelf(): Promise<void> {
  // Своё, ещё живое ожидание важнее: расписка на диске — та же самая.
  if (pending) return;
  const read = await kvTryGet(CLIPBOARD_SECRET_KEY);
  if (!read) {
    log.warn('clipboard_secret_shelf_read_failed');
    return;
  }
  const shelf = parseShelf(read.value);
  if (!shelf) return;
  arm(shelf.hash, Math.max(shelf.dueAt, Date.now()), true);
}

/**
 * Продолжить уборку, начатую до перезапуска (v4.32.834).
 *
 * Зовётся с запуска приложения. Расписки нет — делать нечего; есть — это тот же
 * `sweep` с теми же двумя правилами: чужое не трогаем, нечитаемый буфер ждём.
 */
export async function resumeSecretClipboardSweep(): Promise<void> {
  await armFromShelf();
  if (!pending) return;
  await sweep();
}

/**
 * Убрать секрет из буфера немедленно, не дожидаясь срока.
 *
 * Закрытие окна с seed-фразой сюда сознательно НЕ ведёт: скопировать и уйти
 * вставлять — это и есть обычный порядок действий, и очистка на закрытии сломала
 * бы ровно то, ради чего кнопку нажали. Зовёт отсюда полный сброс устройства: он
 * убирает расшифрованное из кэша, и оставить при этом двенадцать слов в буфере
 * значило бы вычистить всё, кроме самого ценного.
 *
 * v4.32.834: сброс поднимает и расписку с диска — иначе секрет, скопированный
 * до перезапуска, пережил бы полную очистку устройства. Расписка лежит в kv,
 * поэтому шаг сброса зовётся, пока местная база ещё открыта.
 */
export async function clearSecretClipboardNow(): Promise<void> {
  await armFromShelf();
  if (!pending) return;
  await sweep(true);
}
