/**
 * Ключ шифрования локальных данных (сообщения в SQLite, outbox) хранится в SecureStore
 * (Keychain / Android Keystore через expo-secure-store). Сами записи в БД — только ciphertext.
 */
import * as SecureStore from './secureStoreQueued';
import { randomBytes } from '@noble/hashes/utils.js';
import { encryptSymmetric, decryptSymmetric, SYMMETRIC_KEY_BYTES } from '../crypto/encrypt';
import {
  decideDek,
  type CanaryState,
  type MnemonicState,
  type StoredKeyState,
} from './dekPolicy';
import { classifyAtRestCell, type AtRestCell } from './atRestCell';
import { shouldReportFailure } from './unreadableCell';
import { log } from '../logger';

export const DEK_KEY = 'airchat_local_dek_v1';
/**
 * Канарейка к ключу (v4.32.520): известная строка, зашифрованная самим DEK.
 *
 * Лежит рядом с ключом и в том же хранилище — прятать её незачем, содержимое
 * известно заранее, а ключ она не выдаёт. Смысл в другом: по ней про любой
 * ключ-кандидат можно сказать, тот ли это ключ, которым зашифрованы данные.
 * Без неё «ключа нет» и «ключ не прочитался» неразличимы, а цена ошибки в
 * этом различии — вся переписка (см. docblock в dekPolicy).
 */
export const DEK_CANARY_KEY = 'airchat_local_dek_canary_v1';
const CANARY_PLAINTEXT = 'airchat-dek-canary-v1';
/** Префикс для полей text/media_cids/payload в SQLite. */
export const AT_REST_PREFIX = 'enc2:';

/**
 * Ключ к локальным данным недоступен, и подменять его новым нельзя.
 *
 * Отдельный класс, а не обычная Error: отказ здесь — не поломка, а решение, и
 * отличать его в журнале от «база занята» нужно с первого взгляда.
 */
export class DekUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`local data key unavailable: ${reason}`);
    this.name = 'DekUnavailableError';
    this.reason = reason;
  }
}

let dekMemory: Uint8Array | null = null;

/**
 * v4.32.615: счётчик намеренных смен ключа в памяти.
 *
 * Пока идёт `getOrCreateDataEncryptionKey`, ключ рядом могли поменять — сменой
 * профиля, dispose сервиса или миграцией из `local.ts`. Без счётчика такой
 * вызов дописывал бы в `dekMemory` уже чужой ключ, отменяя эту смену.
 */
let dekGeneration = 0;

export function setDekMemory(dek: Uint8Array): void {
  dekMemory = dek;
  dekGeneration += 1;
  dekInflight = null;
}

/** Сброс кэша DEK в памяти при смене профиля / dispose сервиса (секрет перечитывается из SecureStore). */
export function clearDekMemory(): void {
  dekMemory = null;
  dekGeneration += 1;
  dekInflight = null;
}

/** Сырой DEK из SecureStore (без генерации). */
export async function readDekFromSecureStoreRaw(): Promise<Uint8Array | null> {
  const b64 = await SecureStore.getItemAsync(DEK_KEY);
  if (!b64) return null;
  const dek = new Uint8Array(Buffer.from(b64, 'base64'));
  if (dek.length !== SYMMETRIC_KEY_BYTES) return null;
  return dek;
}

/** Ключ из SecureStore с различением «нет», «испорчен» и «не прочитался». */
async function observeStoredDek(): Promise<{ state: StoredKeyState; dek: Uint8Array | null }> {
  let b64: string | null;
  try {
    b64 = await SecureStore.getItemAsync(DEK_KEY);
  } catch {
    return { state: 'unreadable', dek: null };
  }
  if (!b64) return { state: 'absent', dek: null };
  const dek = new Uint8Array(Buffer.from(b64, 'base64'));
  if (dek.length !== SYMMETRIC_KEY_BYTES) return { state: 'malformed', dek: null };
  return { state: 'valid', dek };
}

async function readCanary(): Promise<{ state: CanaryState; stored: string | null }> {
  try {
    const v = await SecureStore.getItemAsync(DEK_CANARY_KEY);
    if (!v) return { state: 'absent', stored: null };
    return { state: 'present', stored: v };
  } catch {
    return { state: 'unreadable', stored: null };
  }
}

/** null — сравнивать было нечего: нет канарейки или нет ключа-кандидата. */
function canaryOpens(stored: string | null, dek: Uint8Array | null): boolean | null {
  if (stored === null || dek === null) return null;
  try {
    return tryDecryptAtRest(stored, dek) === CANARY_PLAINTEXT;
  } catch {
    return false;
  }
}

/**
 * Мнемоника и выведенный из неё ключ.
 *
 * Чтение сейфа отделено от загрузки модулей намеренно. Сбой чтения — это
 * «мнемоника, возможно, есть, но мы её не видим», и придумывать в такой момент
 * случайный ключ нельзя: он разойдётся с тем, который выведется из seed на
 * следующем запуске. А несобравшийся динамический импорт — это про сборку, про
 * сейф он не говорит ничего; сюда с ним попадают только установки, где нет ни
 * ключа, ни канарейки, то есть терять пока нечего.
 */
async function probeSeedDek(): Promise<{ state: MnemonicState; dek: Uint8Array | null }> {
  let readMnemonic: () => Promise<string | null>;
  let derive: (mnemonic: string) => Uint8Array;
  try {
    readMnemonic = (await import('../backup/seedPhrase')).getStoredMnemonic;
    derive = (await import('./dekDerivation')).deriveLocalDekFromMnemonic;
  } catch {
    return { state: 'absent', dek: null };
  }
  try {
    const mnemonic = await readMnemonic();
    if (!mnemonic?.trim()) return { state: 'absent', dek: null };
    return { state: 'present', dek: derive(mnemonic) };
  } catch {
    return { state: 'unreadable', dek: null };
  }
}

/**
 * Записать канарейку выбранным ключом.
 *
 * Сбой записи проглатывается: канарейка — страховка следующего запуска, а не
 * условие работы этого. Отказать сейчас из-за неё значило бы поменять
 * «приложение работает без страховки» на «приложение не открывается».
 */
async function writeCanary(dek: Uint8Array): Promise<string | null> {
  const value = encryptAtRestString(CANARY_PLAINTEXT, dek);
  try {
    await SecureStore.setItemAsync(DEK_CANARY_KEY, value);
    return value;
  } catch {
    return null;
  }
}

/**
 * Открывается ли канарейка этим ключом.
 *
 * Наружу — для миграции ключа в local.ts: та меняет DEK сама, до всякого
 * getOrCreateDataEncryptionKey, и без этой проверки перешифровала бы базу
 * ключом, которым база не зашифрована.
 *
 * v4.32.617: «канарейки нет» и «канарейку не прочитать» разведены. Раньше оба
 * случая возвращали null, и миграция толковала null как разрешение: на
 * запертом устройстве Keychain отвечает отказом на чтение — и та же миграция
 * тут же писала канарейку своим ключом поверх непрочитанной. Свидетельство о
 * настоящем ключе данных пропадало, а отказ открыть базу превращался в
 * молчаливое чтение мусора. Отличать обязан вызывающий.
 */
export type CanaryVerdict = boolean | 'absent' | 'unreadable';

export async function canaryOpensWith(dek: Uint8Array): Promise<CanaryVerdict> {
  const c = await readCanary();
  if (c.state === 'absent') return 'absent';
  if (c.state !== 'present') return 'unreadable';
  return canaryOpens(c.stored, dek) === true;
}

/**
 * Записать ключ как действующий: в канарейку, в хранилище и в память.
 *
 * Одной функцией, потому что порознь эти три записи расходятся: ключ в
 * SecureStore от канарейки прошлого ключа, и следующий запуск честно доложит,
 * что данные зашифрованы не тем, что лежит рядом.
 *
 * v4.32.617: канарейка пишется ПЕРВОЙ. Между двумя записями в Keychain стоит
 * await, и вторая может не состояться — устройство заперто, «User interaction
 * is not allowed». Нас зовут после того, как данные уже лежат под `dek`, и от
 * порядка зависит, чем обернётся этот обрыв:
 *
 *  - ключ первым: в хранилище новый ключ, канарейка ещё от старого. Ни один из
 *    них канарейку не открывает — `stored_does_not_match_data`, и приложение
 *    больше не открывается никогда, хотя данные целы;
 *  - канарейка первой: канарейка от нового ключа, в хранилище ещё старый.
 *    Старый её не открывает, а выведенный из секретных слов — открывает, и
 *    следующий запуск сам выбирает верный ключ (`stored_stale_seed_matches`).
 *
 * Второй обрыв — сбой самой канарейки — от порядка не зависит: тогда не
 * записано ничего, и это ровно то состояние, в котором мы были до вызова.
 */
export async function persistDek(dek: Uint8Array): Promise<void> {
  await writeCanary(dek);
  await SecureStore.setItemAsync(DEK_KEY, Buffer.from(dek).toString('base64'));
  setDekMemory(dek);
}

/**
 * v4.32.615: параллельные вызовы складываются в один.
 *
 * Дефект. Между чтением хранилища и записью выбранного ключа стоят несколько
 * await — чтение SecureStore, чтение канарейки, распаковка мнемоники. Звали эту
 * функцию из сотни мест, и на первом запуске (`create-random`) два вызова
 * успевали оба решить «ключа нет» и сгенерировать РАЗНЫЕ случайные ключи.
 * Дальше — как лягут записи: часть строк уезжает под первый ключ, часть под
 * второй, а канарейка может остаться запечатанной третьим сочетанием. Тогда
 * следующий запуск честно откажется открывать базу
 * (`stored_does_not_match_data`), и переписка не откроется уже никогда.
 *
 * Склейка — та же, что у `getStoredMnemonic` в `seedPhrase.ts`: первый вызов
 * делает работу, остальные ждут его обещание. Отказ обещание не кэширует —
 * следующий вызов попробует заново.
 */
let dekInflight: Promise<Uint8Array> | null = null;

export function getOrCreateDataEncryptionKey(): Promise<Uint8Array> {
  if (dekMemory && dekMemory.length === SYMMETRIC_KEY_BYTES) return Promise.resolve(dekMemory);
  if (dekInflight) return dekInflight;
  const p = resolveDataEncryptionKey().finally(() => {
    if (dekInflight === p) dekInflight = null;
  });
  dekInflight = p;
  return p;
}

/** Сколько раз перечитываем хранилище, если ключ рядом сменили. */
const DEK_RESOLVE_ATTEMPTS = 3;

/**
 * v4.32.615: чужая смена ключа отменяет наши записи, а не только память.
 *
 * Дефект. Проверка `dekGeneration === gen` стояла ПОСЛЕ обеих записей в
 * постоянное хранилище. `performLocalWalletWipe` сбрасывает память (это и
 * поднимает счётчик) на несколько шагов раньше, чем удаляет из SecureStore
 * ключ и канарейку. Вызов, начавшийся до выхода из аккаунта, дописывал свой
 * ключ уже после вытирания — на устройстве оставался рабочий ключ к данным
 * аккаунта, который считается стёртым. Второй случай той же поломки — два
 * параллельных вызова: любой сброс памяти обнуляет `dekInflight`, так что
 * второй вызов начинает работу заново и может завести ВТОРОЙ случайный ключ.
 *
 * Теперь поколение сверяется перед каждой записью, а несовпадение не пишет
 * ничего и перечитывает хранилище: за время наших await соседний вызов уже
 * положил туда свой ключ, и попытка номер два его подхватит.
 */
async function resolveDataEncryptionKey(): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= DEK_RESOLVE_ATTEMPTS; attempt += 1) {
    // Пока мы читали, ключ мог появиться в памяти — тогда он и есть верный.
    const known = dekMemory;
    if (known && known.length === SYMMETRIC_KEY_BYTES) return known;
    const chosen = await resolveDekOnce(dekGeneration);
    if (chosen) return chosen;
    log.warn('dek_resolve_restarted', { attempt });
  }
  throw new DekUnavailableError('dek_changed_while_resolving');
}

/**
 * Одна попытка. `null` — ключ рядом сменили, читать надо заново.
 */
async function resolveDekOnce(gen: number): Promise<Uint8Array | null> {
  const stored = await observeStoredDek();
  const canary = await readCanary();
  const storedOpensCanary = canaryOpens(canary.stored, stored.dek);
  // Обычный запуск — ключ на месте и канарейка им открывается — сейф не
  // трогает вовсе: чтение мнемоники стоит дорого и может само отказать.
  const seedIsIrrelevant = stored.state === 'valid'
    && (storedOpensCanary === true || canary.state !== 'present');
  const seed = seedIsIrrelevant
    ? { state: 'absent' as MnemonicState, dek: null }
    : await probeSeedDek();

  const decision = decideDek({
    stored: stored.state,
    canary: canary.state,
    storedOpensCanary,
    mnemonic: seed.state,
    derivedOpensCanary: canaryOpens(canary.stored, seed.dek),
  });

  let chosen: Uint8Array;
  if (decision.action === 'use-stored') {
    if (!stored.dek) throw new DekUnavailableError('stored_vanished');
    chosen = stored.dek;
  } else if (decision.action === 'use-derived') {
    if (!seed.dek) throw new DekUnavailableError('derived_vanished');
    chosen = seed.dek;
  } else if (decision.action === 'create-random') {
    chosen = randomBytes(SYMMETRIC_KEY_BYTES);
  } else {
    throw new DekUnavailableError(decision.reason);
  }

  // Проверка стоит ДО записей: иначе они воскресили бы ключ аккаунта,
  // который в это же время вытирают.
  if (dekGeneration !== gen) return null;

  let wroteKey: string | null = null;
  if (decision.action !== 'use-stored') {
    wroteKey = Buffer.from(chosen).toString('base64');
    await SecureStore.setItemAsync(DEK_KEY, wroteKey);
  }
  let wroteCanary: string | null = null;
  if (decision.writeCanary && dekGeneration === gen) wroteCanary = await writeCanary(chosen);
  if (dekGeneration !== gen) {
    await dropOwnWrite(DEK_CANARY_KEY, wroteCanary);
    await dropOwnWrite(DEK_KEY, wroteKey);
    return null;
  }
  dekMemory = chosen;
  return chosen;
}

/**
 * Убрать собственную запись, если её успела обогнать чужая смена ключа.
 *
 * Сравнение с тем, что лежит сейчас, обязательно: за время наших await ключ
 * рядом могли и стереть (выход из аккаунта — тогда наша запись осталась и её
 * надо снять), и заменить своим (`persistDek` при восстановлении — тогда
 * стирать нельзя, снесли бы рабочий ключ).
 */
async function dropOwnWrite(key: string, written: string | null): Promise<void> {
  if (!written) return;
  try {
    if ((await SecureStore.getItemAsync(key)) === written) await SecureStore.deleteItemAsync(key);
  } catch {
    /* уборка, а не условие работы */
  }
}

export function encryptAtRestString(plain: string, dek: Uint8Array): string {
  const ct = encryptSymmetric(dek, new TextEncoder().encode(plain));
  return AT_REST_PREFIX + Buffer.from(ct).toString('base64');
}

/**
 * Сколько столбцов не открылось за жизнь процесса.
 *
 * v4.32.556: раньше это число не считал никто. Показанная пустыми пузырями
 * переписка и переписка, которой нет, в журнале выглядели одинаково.
 */
let atRestFailures = 0;

/** Счётчик неудачных расшифровок — для диагностики и для проверок. */
export function atRestDecryptFailures(): number {
  return atRestFailures;
}

/** Обнулить счётчик (нужно тестам, чтобы наборы не влияли друг на друга). */
export function resetAtRestDecryptFailures(): void {
  atRestFailures = 0;
}

export function decryptAtRestString(stored: string, dek: Uint8Array): string {
  if (stored === '') return '';
  if (!stored.startsWith(AT_REST_PREFIX)) return stored;
  const blob = new Uint8Array(Buffer.from(stored.slice(AT_REST_PREFIX.length), 'base64'));
  const pt = decryptSymmetric(dek, blob);
  // Раньше при сбое возвращался raw ciphertext (enc2:AAAA...) — UI показывал мусор.
  // Теперь при сбое — пустая строка (безопаснее и читаемее для пользователя).
  if (pt) return new TextDecoder().decode(pt);
  atRestFailures += 1;
  // Не на каждую строку: одно чтение списка — сотни столбцов подряд, и
  // предупреждение о первом утонуло бы в собственном повторе.
  if (shouldReportFailure(atRestFailures)) {
    log.warn('at_rest_decrypt_failed', { total: atRestFailures, bytes: blob.length });
  }
  return '';
}

/**
 * v4.32.279: как decryptAtRestString, но отличает «не расшифровалось» (null) от
 * пустой строки. Нужно перешифровке при смене DEK: там записать '' вместо
 * непрочитанного шифртекста значило бы стереть сообщение вместо переноса —
 * причём необратимо, старого ключа после миграции уже нет.
 *
 * Строка без префикса — это ещё не мигрированный открытый текст; возвращается
 * как есть, ровно как в decryptAtRestString.
 */
export function tryDecryptAtRest(stored: string, dek: Uint8Array): string | null {
  if (!stored.startsWith(AT_REST_PREFIX)) return stored;
  const blob = new Uint8Array(Buffer.from(stored.slice(AT_REST_PREFIX.length), 'base64'));
  const pt = decryptSymmetric(dek, blob);
  return pt ? new TextDecoder().decode(pt) : null;
}

/**
 * Чтение столбца для мест, которые собираются его ПЕРЕПИСАТЬ.
 *
 * v4.32.544. `decryptAtRestString` сводит «пусто» и «не прочиталось» к одной
 * пустой строке, и для показа этого достаточно. Там, где столбец читают,
 * дополняют и пишут обратно, такая склейка стирает данные: разбор пустоты
 * даёт пустую карту, а запись поверх — уничтожает прежний шифртекст. Здесь
 * состояния разведены; решать по ним — дело `mayOverwrite` в atRestCell.
 */
export function readAtRestCell(stored: string | null, dek: Uint8Array): AtRestCell {
  if (stored === null) return classifyAtRestCell(null, null);
  let decoded: string | null;
  try {
    decoded = tryDecryptAtRest(stored, dek);
  } catch {
    decoded = null;
  }
  return classifyAtRestCell(stored, decoded);
}

export function encryptAtRestNullable(plain: string | null, dek: Uint8Array): string | null {
  if (plain === null) return null;
  return encryptAtRestString(plain, dek);
}

export function decryptAtRestNullable(stored: string | null, dek: Uint8Array): string | null {
  if (stored === null) return null;
  return decryptAtRestString(stored, dek);
}

/**
 * v4.32.302: зашифровать, если ещё не зашифровано.
 *
 * Нужно там, где в одну колонку попадает и своё (уже шифртекст), и чужое —
 * строки из файла копии, сделанного до того, как колонку начали шифровать.
 * Разовая миграция такие строки не догонит: она отмечается в kv и второй раз не
 * запускается, а копию восстанавливают когда угодно после.
 *
 * Проверка префикса здесь и есть смысл функции: enc2 поверх enc2 читается один
 * раз и отдаёт наружу «enc2:…» вместо содержимого — то есть тихо портит данные,
 * а не ломается заметно.
 */
export function encryptAtRestIfPlain(value: string | null, dek: Uint8Array): string | null {
  if (value === null || value === '') return value;
  return value.startsWith(AT_REST_PREFIX) ? value : encryptAtRestString(value, dek);
}
