import { bytesEqualConstTime } from '../crypto/bytesEqual';
import { ecdhSharedSecret } from '../crypto/keyManager';
import { deriveSymmetricKey } from '../crypto/encrypt';
import { isEd25519PublicKey, isPubKeyB64, publicKeyFromB64, publicKeyToB64 } from '../crypto/pubKeyFormat';
import { displayNameOrNull, sanitizeDisplayName, sanitizeParagraphText } from './sysLineGuard';
import { profileLinksKey, sanitizeProfileLinks, type ProfileLink } from '../identity/profileLinks';
import { normalizeUsername } from '../identity/username';
import { sanitizePeerPronouns } from './peerPronouns';
import { sanitizePeerStatus } from './peerStatus';
import type { KeyPairBytes } from '../crypto/keyManager';
import {
  kvDelete,
  kvGetSecretCell,
  kvSetSecret,
  profileKvGet,
  profileKvSet,
  profileKvDelete,
  notifyChatStorageChanged,
} from '../storage/local';
import { scopedKvTryGetFor } from '../storage/profileScopedKv';
import { profileScopedKey } from '../storage/kvKeys';
import { cellTextOrNull, mayOverwrite, type AtRestCell } from '../storage/atRestCell';
import { isPlainCid } from '../cid';
import { log } from '../logger';
import { publicKeyHash4 } from '../crypto/keyManager';
import { profileManager } from '../identity/profileManager';
import { parseDidKey } from '../identity/did';
import { parseAppLink } from '../net/appLink';
import { mergeExplicitContactRow } from './contactRowMerge';

const PREFIX = 'contact:';

/**
 * Потолок указателя контактов (v4.32.617).
 *
 * Он всегда стоял на чтении — `listContactsFor` отрезает хвост, иначе
 * подсунутый указатель на 100 000 строк подвешивает список. А запись потолка
 * не знала вовсе, и указатель рос дальше: строку заводит не только человек, но
 * и любой незнакомец, написавший в личные (ensureImplicitContact). Разойтись
 * этим двум числам нельзя — за 5000-й записью настоящий контакт переставал
 * показываться в списках молча и навсегда. Теперь потолок один на обе стороны,
 * и переполнение видно в журнале.
 */
const CONTACTS_INDEX_MAX = 5000;

/**
 * v4.32.286: строка контакта — секрет, а не настройка.
 *
 * В ней лежит `symKey` — тот самый симметричный ключ, которым шифруется
 * переписка с этим человеком. Он хранился в kv открытым текстом: сообщения в
 * chat_messages шифровались, а ключ к ним лежал строкой рядом, в той же базе.
 * Кто угодно, добравшийся до файла БД, читал переписку целиком, не подбирая
 * ничего. Вместе с ключом открыто лежали имя контакта, его «о себе» и
 * avatarCid — а `nb:`-дескриптор аватара сам несёт ключ расшифровки файла
 * (blobRef.ts).
 *
 * Значение шифруется, имя ключа — нет: по `p<id>:contact:%` идут выборки в
 * резервной копии и уборка при удалении профиля. Публичный ключ пира виден в
 * имени ключа и так, поэтому список `contacts_index` шифровать смысла нет —
 * он не добавил бы ничего, чего нельзя прочитать из имён строк.
 *
 * Записанное до этой версии читается как есть: decryptAtRestString пропускает
 * незашифрованное насквозь, и строка переезжает на шифртекст при первой же
 * перезаписи.
 */
/**
 * Строка контакта тремя состояниями: есть, нет, не прочиталась (v4.32.641).
 *
 * `kvGetSecret` сводит к `null` и отсутствие строки, и отказ базы, и недоступный
 * DEK. Читающим местам этого хватает — показать нечего в любом случае. А вот
 * трём местам ниже не хватало: разбор индекса считал непрочитанную строку
 * испорченной и ВЫЧЁРКИВАЛ контакт из `contacts_index` навсегда, а две записи
 * собирали строку заново с чистого листа поверх целого шифртекста. Одного
 * неоткрытого хранилища (телефон только что перезагрузили, Keychain ещё
 * заперт) хватало, чтобы вся записная книжка ушла в `badIds` и была стёрта
 * фоновой починкой, которой человек не видит.
 */
async function contactRowCell(pid: number, peerPubB64: string): Promise<AtRestCell> {
  const own = await kvGetSecretCell(profileScopedKey(pid, `${PREFIX}${peerPubB64}`));
  // Непрочитанную свою строку глобальная заслонить не может: иначе запись
  // легла бы поверх неё, а прочитать её мы как раз и не смогли.
  if (own.state !== 'absent') return own;
  // Глобальный ключ до v4.32.124 наследует только первый профиль — он писался
  // тогда, когда профиль был один.
  if (pid === 1) return await kvGetSecretCell(`${PREFIX}${peerPubB64}`);
  return own;
}

async function contactRowGet(pid: number, peerPubB64: string): Promise<string | null> {
  return cellTextOrNull(await contactRowCell(pid, peerPubB64)) || null;
}

/**
 * Возвращает false, если запись не легла на диск. v4.32.660: kvSetSecret
 * сообщает исход честно, а здесь он терялся — и все четыре вызывающих
 * распоряжались несостоявшейся записью как удавшейся: показывали человеку
 * успех, ставили ключ в указатель контактов, рассылали событие «контакты
 * изменились».
 */
async function contactRowSet(pid: number, peerPubB64: string, json: string): Promise<boolean> {
  return await kvSetSecret(profileScopedKey(pid, `${PREFIX}${peerPubB64}`), json);
}

/** Кэш симметричного ключа по base64 ключа пира (чтение kv не на каждое сообщение). */
const symKeyCache = new Map<string, Uint8Array>();
const SYM_CACHE_MAX = 64;

/**
 * v4.32.124 (AUDIT P1): drop all in-memory symmetric keys. Called on
 * logout / wallet wipe / profile switch so stale ECDH-derived keys for the
 * previous identity don't linger in RAM across sessions.
 */
export function clearSymKeyCache(): void {
  symKeyCache.clear();
  contactsListCache.clear();
}

/**
 * v4.32.227 (PERF): short-TTL in-memory cache of listContacts() per profile.
 * listContacts does N+1 SQLite reads (index + one row per contact) and is
 * called in bursts — chat-list render, presence resubscribe sweep (every 30s),
 * groups, startListening — all hammering the same kv table. On a slow device a
 * single `contacts_index` read was observed taking 35.9s under lock contention,
 * freezing the JS thread (and every tab tap with it). Contacts change rarely, so
 * cache the materialized list and invalidate on ANY contact write (centralized
 * in withContactLock below) plus a 5s TTL safety net.
 */
const contactsListCache = new Map<number, { at: number; data: Contact[] }>();
const CONTACTS_LIST_TTL_MS = 5000;

/** Drop the cached contact list (call after any contacts mutation). */
export function invalidateContactsList(pid?: number): void {
  if (pid === undefined) contactsListCache.clear();
  else contactsListCache.delete(pid);
}

/**
 * v4.32.115: serialize ALL contact-row and contacts_index writes per profile.
 * Prevents lost-update race between concurrent ensureImplicitContact() calls
 * (e.g. outgoing sendMessage + inbound LAN frame for different strangers)
 * and between addContact/deleteContact/renameContact. Each write awaits the
 * previous one via a chained promise tail.
 */
const contactWriteLock: Map<number, Promise<void>> = new Map();
function withContactLock<T>(pid: number, fn: () => Promise<T>): Promise<T> {
  const prev = contactWriteLock.get(pid) ?? Promise.resolve();
  // v4.32.227 (PERF): every contact-row / contacts_index write goes through this
  // lock, so it is the single choke point to invalidate the listContacts cache.
  const invalidatingFn = async (): Promise<T> => {
    try {
      return await fn();
    } finally {
      contactsListCache.delete(pid);
    }
  };
  const next = prev.then(invalidatingFn, invalidatingFn);
  // Store a void-typed tail (swallow errors so subsequent ops still run).
  contactWriteLock.set(pid, next.then(() => undefined, () => undefined));
  return next;
}

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

/**
 * v4.32.124 (AUDIT P0 #7): accept pid as an explicit parameter. Previously
 * cacheSymKey() called activeProfileId() internally, so a profile switch
 * between the start of addContact/ensureImplicitContact (where the contact
 * row is written under the OLD pid) and the cacheSymKey() call (reading
 * the NEW pid) would poison the cache under the wrong profile. Callers
 * now capture pid at the top of their function and pass it in.
 */
function cacheSymKey(pid: number, peerPublicKeyB64: string, key: Uint8Array): void {
  if (symKeyCache.size >= SYM_CACHE_MAX) {
    const first = symKeyCache.keys().next().value as string | undefined;
    if (first) symKeyCache.delete(first);
  }
  symKeyCache.set(`${pid}:${peerPublicKeyB64}`, new Uint8Array(key));
}

const contactListeners = new Set<() => void>();

/** UI (например «Рядом») может подписаться на обновление списка после BLE / добавления контакта. */
export function subscribeContactsChanged(cb: () => void): () => void {
  contactListeners.add(cb);
  return () => contactListeners.delete(cb);
}

function emitContactsChanged(): void {
  for (const cb of contactListeners) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

export type Contact = {
  peerPublicKey: string;
  displayName: string;
  /** Optional signed profile CID on IPFS (for DM history sync). */
  profileCid?: string;
  /**
   * v4.32.247: как контакт назвал себя сам (конверт профиля, profileEnvelope).
   * Хранится отдельно от displayName: то — наша местная подпись, которую
   * пользователь задал руками, и перезаписывать её чужим именем нельзя.
   * Показывается, когда местной подписи нет.
   */
  peerName?: string;
  /** Канонический username, присланный самим аккаунтом. */
  peerUsername?: string;
  /** «О себе» контакта — из его же конверта профиля. */
  bio?: string;
  /**
   * v4.32.616: местоимения и статус контакта — из того же конверта.
   *
   * Оба поля есть в редакторе профиля с прошлых версий, но до этой их видел
   * только владелец. Статус приезжал ещё и конвертом присутствия, но там он
   * живёт в памяти, пока человек в сети; здесь он лежит рядом с именем и
   * показывается в карточке всегда.
   */
  pronouns?: string;
  peerStatus?: string;
  /** Фото контакта: обычный CID или `nb:`-дескриптор вложения. */
  avatarCid?: string;
  /** Метка времени применённого конверта — отбрасываем устаревшие. */
  profileTs?: number;
  /**
   * v4.32.547: официальная галочка контакта — уже проверенная.
   *
   * Хранится результатом, а не бумагой, потому что список контактов читается
   * на каждой отрисовке чатов, а проверка подписи — операция, которой там не
   * место. Проверку делает приём конверта (profileSync), где известен и
   * отправитель, и его имя; сюда попадает только её ответ.
   *
   * Поле перезаписывается КАЖДЫМ принятым конвертом, включая пустое значение:
   * аккаунт, сменивший имя или лишившийся бумаги, обязан потерять галочку и у
   * собеседника, иначе она пережила бы то, что подтверждала.
   */
  verified?: 'official';
  /**
   * v4.32.575: привязанные учётные записи — имя на площадке и адрес
   * публикации с доказательством (см. identity/profileLinks).
   *
   * Хранится не результатом проверки, в отличие от галочки рядом, а тем, из
   * чего проверку можно провести. Причина та же, по которой галочка хранится
   * результатом: галочку проверяет подпись, и это дёшево, а привязку —
   * запрос к площадке, и делать его за человека при разборе входящего
   * сообщения нельзя. Кто и когда его сделал, помнит peerLinkVerify.
   */
  links?: ProfileLink[];
  /**
   * v4.32.113 T1: true — контакт создан автоматически при переписке со странgerом
   * (implicit). Такие контакты показываются в списке чатов, но не в «Контакты».
   * Пользователь может явно «Добавить» → implicit становится false.
   */
  implicit?: boolean;
};

/**
 * v4.32.31: универсальный парсер идентификатора контакта.
 * Принимает любую форму, в которой пользователь мог скопировать ID:
 *   • `did:key:z...`              — строка из QR-кода ProfileScreen
 *   • `airchat://contact/<did>`   — deep-link
 *   • ссылка на профиль в любой из форм (v4.32.606): `airchat://u/<ключ>` и
 *     `https://<адрес>/l/u/<ключ>`. Адрес не проверяется намеренно — ссылка,
 *     выданная под прежним адресом, обязана читаться и после его смены.
 *   • чистый base64 raw public key (32 байта) — исторический формат ChatListScreen
 *   • строка с любыми пробелами/переносами вокруг
 *
 * Возвращает Uint8Array длиной 32 (Ed25519 public key), либо null если парс неудачен.
 */
export function parseContactId(input: string): Uint8Array | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;

  // v4.32.606: ссылка на профиль (и на переписку — в ней тот же ключ).
  // Стоит первой: разбор ссылки строгий, он либо узнаёт форму целиком, либо
  // отдаёт null и не мешает разобрать строку остальным способам.
  const link = parseAppLink(s);
  if (link && (link.kind === 'contact' || link.kind === 'dm')) {
    return publicKeyFromB64(link.peerPubB64);
  }

  // Deep-link: airchat://contact/<did>
  if (s.startsWith('airchat://contact/')) {
    s = s.slice('airchat://contact/'.length).trim();
  }
  // airchat://did:key:...
  if (s.startsWith('airchat://')) {
    s = s.slice('airchat://'.length).trim();
  }

  // did:key:z...
  // v4.32.427: длина здесь больше не проверяется. parseDidKey разбирает
  // мультикодек и отдаёт ровно 32 байта либо null — проверка после него не
  // могла не пройти, а выглядела как настоящая: читающий видел проверку и
  // считал ключ проверенным. Проверка, которая не способна отказать, хуже
  // отсутствующей.
  if (s.startsWith('did:key:')) return parseDidKey(s);

  // Base64 сырого открытого ключа. try/catch здесь стоял зря: Buffer.from на
  // недопустимой base64 не бросает ничего и никогда — он молча выбрасывает
  // лишние символы. Отказ даёт только проверка длины и алфавита.
  return publicKeyFromB64(s);
}

/** Текст отказа: показывается человеку, поэтому по-русски и без деталей кривой. */
export const BAD_PUBLIC_KEY_MESSAGE = 'Некорректный открытый ключ контакта';

/** Тот же случай, что и выше: показывается человеку, поэтому по-русски. */
export const CONTACT_ROW_UNREADABLE_MESSAGE = 'Не удалось прочитать запись контакта';

/** v4.32.660: запись не легла на диск. Тоже видит человек — по-русски. */
export const CONTACT_ROW_WRITE_FAILED_MESSAGE = 'Не удалось сохранить запись контакта';

export async function addContact(
  pair: KeyPairBytes,
  peerPublicKey: Uint8Array,
  name: string,
  profileCid?: string
): Promise<void> {
  // v4.32.427: единственная точка, через которую проходят все пять вызовов, —
  // и до этой правки она не проверяла ключ вообще. Из пяти вызывающих длину
  // проверял один. Отказ приходил из кривой, то есть защитой служило
  // исключение чужой библиотеки, и его текст — «"point" expected Uint8Array
  // of length 32, got length=10» — показывался в русском окне как объяснение,
  // почему не добавился контакт. Проверка здесь делает ошибку ненаписуемой:
  // новый вызывающий не может забыть то, чего ему не поручено.
  if (!isEd25519PublicKey(peerPublicKey)) {
    throw new Error(BAD_PUBLIC_KEY_MESSAGE);
  }
  const pid = activeProfileId();
  const b64 = publicKeyToB64(peerPublicKey);
  const myB64 = publicKeyToB64(pair.publicKey);
  // v4.32.192 (Round-22 #7): cap name at entry — profile-card imports can
  // ship a multi-KB name field that would then bloat every listContacts call.
  // v4.32.369: и чистка та же, что у остальных имён из сети. Своя копия знала
  // только C0, а имя контакта показывается и в списке чатов, и в баннере
  // уведомления, и в системных строках.
  name = sanitizeDisplayName(name, 64) ?? '';
  // Canonical salt: both sides sort pub keys the same way → identical symKey on sender and receiver
  const [kA, kB] = [myB64, b64].sort();
  const shared = ecdhSharedSecret(pair.secretKey, peerPublicKey);
  const salt = new TextEncoder().encode(`airchat-dm:${kA}:${kB}`);
  const sym = deriveSymmetricKey(shared, salt);
  await withContactLock(pid, async () => {
    // v4.32.113 T1: если row уже есть с флагом implicit, промоутим его в explicit,
    // сохраняя displayName и profileCid из существующей записи, если новые не переданы.
    // v4.32.570: и всё остальное тоже. Строка собиралась заново из литерала с
    // четырьмя полями, а профиль собеседника (peerName, peerUsername, bio,
    // avatarCid, profileTs) лежит в ней же с v4.32.247 — и исчезал. Добавить в
    // контакты того, с кем уже переписка, значило потерять его имя и
    // фотографию: контакт превращался в кружок с буквой и оставался им до
    // следующей рассылки профиля. Слияние — в contactRowMerge.
    // v4.32.641: непрочитанная строка — не «строки нет». mergeExplicitContactRow
    // получал бы на неё `null` и собрал бы контакт из четырёх переданных полей,
    // а профиль собеседника (имя, юзернейм, «О себе», фотография) лежит в той
    // же строке — ровно та потеря, которую закрыли в v4.32.570, только теперь
    // от сбоя чтения, а не от забытого слияния.
    const cell = await contactRowCell(pid, b64);
    if (!mayOverwrite(cell)) throw new Error(CONTACT_ROW_UNREADABLE_MESSAGE);
    const existing = cellTextOrNull(cell);
    const stored = await contactRowSet(
      pid,
      b64,
      mergeExplicitContactRow(existing, {
        displayName: name,
        symKeyB64: Buffer.from(sym).toString('base64'),
        profileCid,
      })
    );
    // v4.32.660: несостоявшаяся запись — отказ, а не успех. Иначе ключ ложился
    // в указатель контактов без самой строки: человек видел «контакт добавлен»,
    // а в списке появлялась пустая позиция, которую самолечение потом убирало.
    if (!stored) throw new Error(CONTACT_ROW_WRITE_FAILED_MESSAGE);
    await rememberContactIdUnlocked(pid, b64);
  });
  cacheSymKey(pid, b64, sym);
  emitContactsChanged();
}

/**
 * v4.32.113 T1 (Telegram-style): создаёт implicit-контакт для незнакомца.
 * Используется когда:
 *   • мы отправляем DM по pubkey, которого нет в contacts (вставка из QR / deep-link);
 *   • получаем DM от незнакомого sender (через self-inbox в Этапе 2).
 *
 * Идемпотентно: если row уже есть — no-op (не перезаписываем explicit-флаг и displayName).
 * sym-key детерминирован через ECDH + canonical salt, поэтому обе стороны получат одинаковый
 * ключ независимо от того, кто из них первым вызвал ensureImplicitContact.
 *
 * Возвращает true, если был создан новый row.
 *
 * v4.32.464: номер профиля приходит параметром, а не читается из активного.
 * Пара ключей у функции была всегда, а строка контакта ложилась туда, где
 * человек сейчас: незнакомец, написавший в личный профиль, оказывался в
 * контактах рабочего — при том что сама переписка сохранялась в личном.
 * Второй аккаунт заводят ровно затем, чтобы его не связали с первым.
 */
export async function ensureImplicitContact(
  ownerProfileId: number,
  pair: KeyPairBytes,
  peerPublicKey: Uint8Array,
  displayName?: string
): Promise<boolean> {
  const pid = ownerProfileId;
  const b64 = Buffer.from(peerPublicKey).toString('base64');
  // Skip self-contact (отправка сообщения самому себе — Saved Messages, без implicit row)
  const myB64 = Buffer.from(pair.publicKey).toString('base64');
  if (b64 === myB64) return false;
  // Fast-path check outside the lock (avoids ECDH + lock acquisition for existing rows).
  // v4.32.641: непрочитанная строка тоже значит «не заводить». Раньше отказ
  // чтения давал здесь `null`, и неявная строка ложилась поверх явной: контакт
  // терял имя, которое ему задал человек, флаг explicit и весь профиль.
  const pre = await contactRowCell(pid, b64);
  if (pre.state !== 'absent') return false;
  const [kA, kB] = [myB64, b64].sort();
  const shared = ecdhSharedSecret(pair.secretKey, peerPublicKey);
  const salt = new TextEncoder().encode(`airchat-dm:${kA}:${kB}`);
  const sym = deriveSymmetricKey(shared, salt);
  // v4.32.115: serialize via withContactLock + re-check under lock to close TOCTOU window.
  const created = await withContactLock(pid, async () => {
    const existing = await contactRowCell(pid, b64);
    if (existing.state !== 'absent') return false;
    const stored = await contactRowSet(
      pid,
      b64,
      JSON.stringify({
        displayName: displayName?.trim() || '',
        symKey: Buffer.from(sym).toString('base64'),
        implicit: true,
      })
    );
    // v4.32.660: бросать здесь нельзя — неявный контакт заводится по ходу
    // приёма чужого сообщения, и отказ базы не повод ронять приём. Но и
    // отвечать «завёл» неправдой тоже нельзя: ключ в указатель не пойдёт,
    // implicit_contact_created не запишется, вызывающий узнает про отказ.
    if (!stored) {
      log.warn('implicit_contact_write_failed', { peer: b64.slice(0, 12) });
      return false;
    }
    await rememberContactIdUnlocked(pid, b64);
    return true;
  });
  if (!created) return false;
  cacheSymKey(pid, b64, sym);
  emitContactsChanged();
  log.info('implicit_contact_created', { peer: b64.slice(0, 12) });
  return true;
}

// v4.32.377: следом за promoteImplicitContact убрана и isImplicitContact —
// «создан ли контакт автоматически из переписки с незнакомцем». Флаг
// `implicit` в строке контакта остаётся и по-прежнему сохраняется при записи;
// спрашивать его отдельно не хотел никто.

// v4.32.128 (AUDIT): removed dead `promoteImplicitContact`.
// It was exported but had zero call-sites — UI promotion flows (UserProfilePeek,
// ContactCardBubble, GroupsScreen, ChatListScreen) all call `addContact` which
// already handles the implicit→explicit promotion path: when an existing row
// with `implicit: true` is found it merges displayName/profileCid and rewrites
// with `implicit: false` (see addContact, lines ~148–171). Keeping two parallel
// implementations invited drift.

export async function listContacts(): Promise<Contact[]> {
  return listContactsFor(activeProfileId());
}

/**
 * Контакты названного профиля (v4.32.465).
 *
 * «Активный» — это про экран, а не про работу: приём группового конверта и
 * разбор заявки на вступление идут под парой ключей, которой конверт
 * расшифрован, и ждут сеть. К моменту вопроса «в контактах ли этот человек»
 * активным может быть уже другой аккаунт — и тогда заявка незнакомца
 * проходит фильтр «только контакты», а заявка своего контакта им отсекается.
 */
export async function listContactsFor(ownerProfileId: number): Promise<Contact[]> {
  return (await listContactsReadFor(ownerProfileId)) ?? [];
}

/** Контакты активного профиля, отличая «пусто» от «не прочиталось». */
export async function listContactsRead(): Promise<Contact[] | null> {
  return listContactsReadFor(activeProfileId());
}

/**
 * То же чтение, что и `listContactsFor`, но отличающее «контактов нет» от
 * «прочитать не вышло» (v4.32.622).
 *
 * `listContactsFor` возвращает пустой список в обоих случаях — и это верно для
 * проверок «в контактах ли он», которым нужен ответ, а не диагноз. Экрану же
 * пустой список означает «Добавьте первый контакт»: сорванное чтение он рисовал
 * как пустую записную книжку, из которой человек делал вывод, что контакты
 * пропали. Возвращает null ровно при отказе.
 *
 * Это правило `DbRead` из storage/readResult, только со своим (изменяемым)
 * массивом: каждый вызов и без того отдаёт свежую копию, и просить экраны
 * копировать её ещё раз незачем — `shouldApplyRows` принимает и такую.
 */
export async function listContactsReadFor(ownerProfileId: number): Promise<Contact[] | null> {
  try {
    const pid = ownerProfileId;
    // v4.32.227 (PERF): serve from the short-TTL cache to avoid the N+1 SQLite
    // read storm on every render/sweep (see contactsListCache above).
    const cached = contactsListCache.get(pid);
    // v4.32.227: return a shallow copy so a caller doing in-place sort/splice
    // can't corrupt the shared cached array for everyone else.
    if (cached && Date.now() - cached.at < CONTACTS_LIST_TTL_MS) return cached.data.slice();
    // v4.32.659: отказ чтения отличаем от пустоты. profileKvGet сводит их в
    // один null (kvTryGet гасит ошибку базы внутри себя), и обещание докблока
    // выше не выполнялось: недоступный момент SQLite экран рисовал как пустую
    // записную книжку. Наследование общей (беспрефиксной) записи первым
    // профилем — v4.32.124 (AUDIT P0 #8), остальным она не достаётся, иначе
    // список профиля A утекал бы профилю B при первом открытии, — делает сам
    // scopedKvTryGetFor, вместе с правилом «сначала копия, потом удаление».
    const read = await scopedKvTryGetFor(pid, 'contacts_index');
    if (read === null) return null;
    const raw = read.value;
    if (!raw) return [];
    // v4.32.115: Array.isArray guard against corrupted index.
    const parsed = JSON.parse(raw);
    // v4.32.198 (Round-28 #6): filter non-string / wrong-length IDs and cap
    // count. A corrupt/imported contacts_index with 100k entries stalls
    // listContacts and breaks SQL param binding in profileKvGet.
    const ids = (Array.isArray(parsed) ? (parsed as unknown[]) : [])
      // v4.32.368: форма ключа общая (crypto/pubKeyFormat), не только длина.
      .filter(isPubKeyB64)
      .slice(0, CONTACTS_INDEX_MAX);
    const out: Contact[] = [];
    // v4.32.124 (AUDIT P1 Block 7): collect IDs whose row is missing OR
    // unparseable — heal the index persistently instead of re-warning on
    // every listContacts() call.
    const badIds: string[] = [];
    for (const id of ids) {
      const cell = await contactRowCell(pid, id);
      // v4.32.641: непрочитанная строка НЕ попадает в badIds. Починка индекса
      // ниже — удаление, и удалять по итогу неудавшегося чтения нельзя: строка
      // цела, открыть её не вышло, а вычеркнутый из индекса контакт вернуть
      // уже нечем. Один заблокированный Keychain стирал так всю книжку разом.
      if (cell.state === 'unreadable') continue;
      const row = cellTextOrNull(cell);
      // v4.32.71: skip empty-string rows (legacy artefact of old deleteContact
      // which wrote '' instead of DELETE'ing the row); JSON.parse('') would throw.
      if (!row || !row.trim()) {
        badIds.push(id);
        continue;
      }
      try {
        const j = JSON.parse(row) as {
          displayName?: unknown; profileCid?: unknown; implicit?: unknown;
          peerName?: unknown; peerUsername?: unknown; bio?: unknown;
          peerPronouns?: unknown; peerStatus?: unknown;
          avatarCid?: unknown; profileTs?: unknown;
          peerVerified?: unknown;
          peerLinks?: unknown;
        };
        // v4.32.197 (Round-27 #6): coerce/cap fields. Legacy rows + future
        // import paths may produce non-string / multi-MB values that bloat
        // every chat-list render and break `.slice()` downstream.
        // v4.32.371: та же вычистка, что при записи, но на чтении. Строки,
        // записанные до неё, лежат в базе как есть, и имя из одних невидимых
        // символов проходило `displayName || peerName` ниже — настоящее имя
        // собеседника оно вытесняло, а само не показывало ничего.
        const displayName = displayNameOrNull(j.displayName, 128) ?? '';
        const profileCid = isPlainCid(j.profileCid) ? j.profileCid : undefined;
        const peerName = displayNameOrNull(j.peerName, 64) ?? '';
        // v4.32.374: та же вычистка на чтении, что у имени рядом. «О себе»
        // раньше только обрезалось по длине — а в базу оно попадает не только
        // из разобранного конверта: строки лежат там с прошлых версий и с
        // импорта профиля (identity/profile), где чистки нет вовсе.
        const bio = sanitizeParagraphText(j.bio, 512);
        // v4.32.616: юзернейм читался обратно НИГДЕ. Он записывался
        // конвертом профиля с v4.32.4xx и сравнивался при записи, но в разбор
        // строки не входил — значит `contact.peerUsername` всегда был
        // undefined, и карточка контакта, которая его показывает, не
        // показывала его никогда.
        const peerUsername = normalizeUsername(j.peerUsername);
        const peerPronouns = sanitizePeerPronouns(j.peerPronouns);
        const peerStatus = sanitizePeerStatus(j.peerStatus);
        const peerLinks = sanitizeProfileLinks(j.peerLinks);
        out.push({
          peerPublicKey: id,
          // Местная подпись важнее: её задал пользователь. Имя из конверта
          // подставляется только там, где подписи нет, — иначе незнакомец из
          // self-inbox навсегда остался бы пустой строкой в списке чатов.
          displayName: displayName || peerName,
          profileCid,
          implicit: j.implicit === true,
          // v4.32.247: поля профиля контакта. Пределы те же, что при записи, —
          // строка в базе могла попасть туда из старого импорта.
          ...(peerName ? { peerName } : {}),
          ...(peerUsername ? { peerUsername } : {}),
          ...(bio ? { bio } : {}),
          ...(peerPronouns ? { pronouns: peerPronouns } : {}),
          ...(peerStatus ? { peerStatus } : {}),
          ...(typeof j.avatarCid === 'string' && j.avatarCid ? { avatarCid: j.avatarCid } : {}),
          ...(typeof j.profileTs === 'number' && Number.isFinite(j.profileTs) ? { profileTs: j.profileTs } : {}),
          // Единственное допустимое значение сверяется здесь, а не приводится:
          // строка в базе могла приехать из резервной копии, и «что угодно
          // непустое» означало бы галочку по чужому файлу.
          ...(j.peerVerified === 'official' ? { verified: 'official' as const } : {}),
          // Строка в базе — такой же недоверенный ввод, как конверт: она
          // могла приехать из резервной копии или лежать с прошлой версии.
          ...(peerLinks ? { links: peerLinks } : {}),
        });
      } catch (e) {
        log.warn('contact_row_parse_failed', { id, err: e instanceof Error ? e.message : String(e) });
        badIds.push(id);
      }
    }
    if (badIds.length > 0) {
      // Heal asynchronously outside the hot path — don't block listContacts
      // on lock acquisition. Next listContacts() won't hit these entries.
      void withContactLock(pid, async () => {
        try {
          const curRaw = await profileKvGet(pid, 'contacts_index');
          if (!curRaw) return;
          const cur = JSON.parse(curRaw);
          if (!Array.isArray(cur)) return;
          const bad = new Set(badIds);
          const cleaned = (cur as string[]).filter((x) => !bad.has(x));
          if (cleaned.length !== cur.length) {
            await profileKvSet(pid, 'contacts_index', JSON.stringify(cleaned));
            log.info('contacts_index_healed', { pid, removed: cur.length - cleaned.length });
          }
        } catch (e) {
          log.warn('contacts_index_heal_failed', {
            err: e instanceof Error ? e.message : String(e),
          });
        }
      });
    }
    // v4.32.31: алфавитная сортировка по displayName (case-insensitive, локаль ru).
    out.sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || '', 'ru', { sensitivity: 'base' })
    );
    // v4.32.227 (PERF): cache the materialized list; invalidated on any write.
    contactsListCache.set(pid, { at: Date.now(), data: out });
    return out;
  } catch (e) {
    log.warn('contacts_list_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function rememberContactId(peerPublicKeyB64: string): Promise<void> {
  const pid = activeProfileId();
  await withContactLock(pid, () => rememberContactIdUnlocked(pid, peerPublicKeyB64));
}

/** v4.32.115: unlocked inner — callers already holding withContactLock use this. */
async function rememberContactIdUnlocked(pid: number, peerPublicKeyB64: string): Promise<void> {
  // v4.32.659: указатель здесь перечитывается, меняется и кладётся обратно —
  // поэтому сорванное чтение стоило дороже всего. Прежде оно давало '[]', и на
  // диск ложился указатель из одной записи: один недоступный момент базы стирал
  // весь список контактов. Наследование общей записи первым профилем
  // (v4.32.124, AUDIT P0 #8) теперь внутри scopedKvTryGetFor.
  const read = await scopedKvTryGetFor(pid, 'contacts_index');
  if (read === null) {
    log.warn('contacts_index_read_failed', { pid, op: 'remember' });
    return;
  }
  const raw = read.value ?? '[]';
  try {
    const parsed = JSON.parse(raw);
    // v4.32.115: guard against corrupted index (e.g. `{}` instead of `[]`).
    const arr = Array.isArray(parsed) ? (parsed as string[]) : [];
    const ids = new Set(arr);
    if (!ids.has(peerPublicKeyB64) && ids.size >= CONTACTS_INDEX_MAX) {
      // Молча дописать было бы хуже: запись легла бы на диск, а читатель до
      // неё всё равно не дошёл. Дальше идёт разговор про то, чем указатель
      // забит, — вытеснять здесь наугад нечего.
      log.warn('contacts_index_full', { pid, size: ids.size });
      return;
    }
    ids.add(peerPublicKeyB64);
    await profileKvSet(pid, 'contacts_index', JSON.stringify([...ids]));
    notifyChatStorageChanged();
  } catch (e) {
    log.warn('contacts_index_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Returns true if a new contact row was created from a BLE invite. */
export async function handleIncomingInvite(
  pair: KeyPairBytes,
  peerPublicKey: Uint8Array
): Promise<boolean> {
  if (bytesEqualConstTime(peerPublicKey, pair.publicKey)) return false;
  const pid = activeProfileId();
  const b64 = Buffer.from(peerPublicKey).toString('base64');
  const row = await contactRowGet(pid, b64);
  if (row) return false;
  await addContact(pair, peerPublicKey, 'Nearby');
  return true;
}

/** Match BLE manufacturer hash (first 4 bytes of sha256(pub)) to a stored contact. */
export async function findContactPubKeyByHash(hash: Uint8Array): Promise<string | null> {
  try {
    const contacts = await listContacts();
    for (const c of contacts) {
      const pk = publicKeyFromB64(c.peerPublicKey);
      if (!pk) continue;
      const h = publicKeyHash4(pk);
      if (Buffer.from(h).equals(Buffer.from(hash))) return c.peerPublicKey;
    }
    return null;
  } catch (e) {
    log.warn('contact_find_hash_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function getContactProfileCid(peerPublicKeyB64: string): Promise<string | null> {
  try {
    const pid = activeProfileId();
    const row = await contactRowGet(pid, peerPublicKeyB64);
    if (!row) return null;
    const j = JSON.parse(row) as { profileCid?: string };
    return j.profileCid ?? null;
  } catch {
    return null;
  }
}

// v4.32.377: setContactProfileCid записывала контакту CID профиля в IPFS. На
// телефоне IPFS выключен с v4.32.19, профиль с v4.32.247 доезжает обычным
// зашифрованным сообщением (см. profileEnvelope), и записывать этот CID стало
// некому. Чтение (getContactProfileCid, выше) оставлено: у кого-то в базе он
// ещё лежит от старых версий.

/**
 * v4.32.247: применить профиль, который контакт прислал о себе.
 *
 * Местная подпись (displayName) не трогается — её задал пользователь, и чужое
 * имя не должно её затирать. Поля профиля перезаписываются целиком, включая
 * пустые: удалённое «О себе» обязано исчезнуть и у собеседника.
 *
 * Возвращает true, если что-то изменилось (UI стоит перерисовать).
 */
export async function setPeerProfile(
  peerPublicKeyB64: string,
  profile: PeerProfilePatch
): Promise<boolean> {
  return await setPeerProfileFor(activeProfileId(), peerPublicKeyB64, profile);
}

/**
 * То же, но для явно названного профиля (v4.32.481).
 *
 * Профиль контакта приезжает личным сообщением, а его расшифровка и разбор —
 * это await'ы: пока они идут, человек успевает переключить аккаунт, и чужое
 * фото ложилось в список контактов другого профиля. Служба переписки знает
 * владельца по своей паре ключей — пусть он и называется.
 */
export type PeerProfilePatch = {
  name: string | null;
  username?: string | null;
  bio: string | null;
  /** v4.32.616: местоимения и статус. Отсутствуют в конвертах до 4.32.616. */
  pronouns?: string | null;
  status?: string | null;
  avatarCid: string | null;
  /** v4.32.547: результат проверки бумаги на галочку. Проверяет profileSync. */
  verified?: 'official' | null;
  /** v4.32.575: привязанные учётные записи — как приехали, непроверенные. */
  links?: ProfileLink[] | null;
  ts: number;
};

export async function setPeerProfileFor(
  pid: number,
  peerPublicKeyB64: string,
  profile: PeerProfilePatch
): Promise<boolean> {
  const changed = await withContactLock(pid, async () => {
    try {
      const row = await contactRowGet(pid, peerPublicKeyB64);
      if (!row) return false;
      const j = JSON.parse(row) as Record<string, unknown>;
      // Устаревший конверт: сообщения могут прийти не в том порядке, в каком
      // отправлялись, и старое имя не должно возвращаться поверх нового.
      const prevTs = typeof j.profileTs === 'number' ? j.profileTs : 0;
      if (profile.ts < prevTs) return false;
      const next = {
        peerName: profile.name ?? '',
        ...(profile.username !== undefined ? { peerUsername: profile.username ?? '' } : {}),
        bio: profile.bio ?? '',
        // Пустая строка записывается так же обязательно, как пустая галочка:
        // стёртый статус обязан исчезнуть и у собеседника. А отсутствие поля
        // в конверте (undefined) значит «конверт его не касается» — так шлют
        // клиенты до 4.32.616, и стирать за них нечего.
        ...(profile.pronouns !== undefined ? { peerPronouns: profile.pronouns ?? '' } : {}),
        ...(profile.status !== undefined ? { peerStatus: profile.status ?? '' } : {}),
        avatarCid: profile.avatarCid ?? '',
        // Пустая строка — «галочки нет», и записывается она так же обязательно,
        // как удалённое «О себе»: отсутствие поля в конверте не должно
        // оставлять в базе вчерашнее подтверждение.
        ...(profile.verified !== undefined ? { peerVerified: profile.verified ?? '' } : {}),
        // Пустой список записывается так же обязательно, как пустая галочка:
        // человек, отвязавший учётную запись, обязан потерять её и здесь.
        ...(profile.links !== undefined ? { peerLinks: profile.links ?? [] } : {}),
        profileTs: profile.ts,
      };
      const same =
        (j.peerName ?? '') === next.peerName &&
        (profile.username === undefined || (j.peerUsername ?? '') === next.peerUsername) &&
        (j.bio ?? '') === next.bio &&
        (profile.pronouns === undefined || (j.peerPronouns ?? '') === (profile.pronouns ?? '')) &&
        (profile.status === undefined || (j.peerStatus ?? '') === (profile.status ?? '')) &&
        (profile.verified === undefined || (j.peerVerified ?? '') === (profile.verified ?? '')) &&
        (profile.links === undefined ||
          profileLinksKey(sanitizeProfileLinks(j.peerLinks)) === profileLinksKey(profile.links)) &&
        (j.avatarCid ?? '') === next.avatarCid;
      const stored = await contactRowSet(pid, peerPublicKeyB64, JSON.stringify({ ...j, ...next }));
      // v4.32.660: `!same` отвечало «профиль собеседника обновился» по одному
      // лишь различию присланного и сохранённого — даже когда сохранить не
      // удалось. Экраны перерисовывались по старой строке и показывали прежнее
      // имя, а отправитель считал профиль доставленным.
      if (!stored) {
        log.warn('contact_peer_profile_write_failed', { peer: peerPublicKeyB64.slice(0, 12) });
        return false;
      }
      return !same;
    } catch (e) {
      log.warn('contact_peer_profile_failed', { err: e instanceof Error ? e.message : String(e) });
      return false;
    }
  });
  if (changed) {
    notifyChatStorageChanged();
    emitContactsChanged();
  }
  return changed;
}

/** Rename a contact's display name. */
export async function renameContact(peerPublicKeyB64: string, newName: string): Promise<void> {
  const pid = activeProfileId();
  await withContactLock(pid, async () => {
    const row = await contactRowGet(pid, peerPublicKeyB64);
    // v4.32.581: пустая строка вместо записи — наследие старого deleteContact
    // (см. ту же проверку в разборе индекса выше): JSON.parse('') бросает.
    if (!row || !row.trim()) return;
    // v4.32.115: preserve `implicit` flag across renames.
    const j = JSON.parse(row) as { displayName?: string; symKey?: string; profileCid?: string; implicit?: boolean };
    // Разбор мог удаться и дать не объект — `null`, число, массив. Присвоение
    // поля такому значению падает, а переименование контакта человек делает
    // руками и ждёт ответа: молча оборвавшийся вызов выглядит как зависание.
    if (!j || typeof j !== 'object' || Array.isArray(j)) return;
    // v4.32.192 (Round-22 #7): strip control chars + cap name at 64 chars so
    // a malicious profile-card or deep-link can't bloat contacts_index JSON.
    j.displayName = (sanitizeDisplayName(newName, 64) ?? '').trim();
    const stored = await contactRowSet(pid, peerPublicKeyB64, JSON.stringify(j));
    // v4.32.660: переименование человек делает руками и ждёт ответа. Прежде
    // при отказе записи он получал «Имя обновлено», а имя оставалось старым —
    // до перезапуска приложения это выглядело как потерянная правка. Все три
    // экрана, зовущие renameContact, уже ловят исключение и показывают текст.
    if (!stored) throw new Error(CONTACT_ROW_WRITE_FAILED_MESSAGE);
  });
  notifyChatStorageChanged();
  emitContactsChanged();
}

/**
 * Убрать человека из контактов.
 *
 * v4.32.615: прежнее описание обещало здесь больше, чем происходит на самом
 * деле — «ключ шифрования исчез, читаемых сообщений от этого человека больше
 * не будет». Ключа в строке контакта и не было: он считается из двух открытых
 * ключей (`deriveSymmetricKeyForStranger` ниже), поэтому следующее сообщение
 * удалённого расшифруется по-прежнему, а вместе с ним `ensureImplicitContact`
 * заведёт строку заново. Это не оплошность, а то, ради чего неявные контакты
 * и сделаны: удаление — это уборка списка, а не запрет. Запрет — блокировка,
 * и она проверяется отдельно, в том числе перед созданием такой строки
 * (`messaging.receiveDirectLanEnvelope`).
 */
export async function deleteContact(peerPublicKeyB64: string): Promise<void> {
  const pid = activeProfileId();
  await withContactLock(pid, async () => {
    // Remove from index
    // v4.32.659: отказ чтения отличаем от пустоты. Наследование общей
    // (беспрефиксной) записи первым профилем — v4.32.124 (AUDIT P0 #8) —
    // делает сам scopedKvTryGetFor.
    const read = await scopedKvTryGetFor(pid, 'contacts_index');
    if (read === null) {
      // Класть указатель обратно нельзя: '[]' на месте несостоявшегося чтения
      // стирал весь список, а просили убрать одного. Строку человека всё равно
      // удаляем — он просил именно этого, — а из указателя его вычистит
      // самолечение при следующем удачном чтении списка (badIds выше).
      log.warn('contacts_index_read_failed', { pid, op: 'delete' });
    } else {
      let ids: Set<string>;
      try {
        const parsed = JSON.parse(read.value ?? '[]');
        ids = new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
      } catch {
        ids = new Set();
      }
      ids.delete(peerPublicKeyB64);
      await profileKvSet(pid, 'contacts_index', JSON.stringify([...ids]));
    }
    // v4.32.71: физическое удаление row вместо записи пустой строки.
    await profileKvDelete(pid, `${PREFIX}${peerPublicKeyB64}`);
    // v4.32.286: и старая глобальная строка (до v4.32.124) — иначе удаление
    // сносило только запись профиля, а чтение по публичному ключу поднимало
    // глобальную обратно: имя, «о себе» и symKey удалённого человека
    // переживали его удаление. Из списка он при этом пропадал, потому что
    // список строится по contacts_index, — то есть следа не оставалось.
    // Только для первого профиля: глобальную строку писали тогда, когда
    // профиль был один.
    if (pid === 1) await kvDelete(`${PREFIX}${peerPublicKeyB64}`);
  });
  // Clear from sym key cache
  symKeyCache.delete(`${pid}:${peerPublicKeyB64}`);
  // v4.32.189 (Round-19 #5): drop persisted presence last-seen KV for
  // this peer so it doesn't leak across contact churn.
  try {
    // v4.32.482: запись живёт в namespace профиля — удаляется оттуда же.
    const { presenceLastSeenKey } = await import('./presenceService');
    const { kvDeleteScoped } = await import('../storage/local');
    await kvDeleteScoped(pid, presenceLastSeenKey(peerPublicKeyB64));
    if (pid === 1) await kvDelete(presenceLastSeenKey(peerPublicKeyB64));
  } catch { /* ignore */ }
  /**
   * v4.32.277: личная заметка о человеке и корзина удалённых сообщений
   * переписки с ним переживали удаление контакта. Заметку писал сам
   * пользователь «только для себя» — она про удалённого человека и после его
   * удаления не значит уже ничего, кроме утечки; корзина же держала тексты той
   * самой переписки, которую удаление и должно было унести.
   */
  try {
    const { contactNoteKey, recentlyDeletedKey, kvDeleteScoped } = await import('../storage/local');
    await kvDeleteScoped(pid, contactNoteKey(peerPublicKeyB64));
    await kvDeleteScoped(pid, recentlyDeletedKey(peerPublicKeyB64));
  } catch { /* ignore */ }
  notifyChatStorageChanged();
  emitContactsChanged();
}

/**
 * v4.32.120: stateless sym-key derivation — no DB touch, no contact row needed.
 * Used by self-inbox ingress to attempt decrypt BEFORE creating an implicit
 * contact row. If decrypt fails, the packet is attacker traffic and no
 * persistence side-effect should happen.
 *
 * Math is identical to addContact / ensureImplicitContact (canonical salt over
 * sorted pub keys), so both sides produce the same key.
 */
export function deriveSymmetricKeyForStranger(
  pair: KeyPairBytes,
  peerPublicKey: Uint8Array,
): Uint8Array {
  const myB64 = Buffer.from(pair.publicKey).toString('base64');
  const peerB64 = Buffer.from(peerPublicKey).toString('base64');
  const [kA, kB] = [myB64, peerB64].sort();
  const shared = ecdhSharedSecret(pair.secretKey, peerPublicKey);
  const salt = new TextEncoder().encode(`airchat-dm:${kA}:${kB}`);
  return deriveSymmetricKey(shared, salt);
}

/**
 * Ключ переписки с этим собеседником — в указанном профиле (v4.32.464).
 *
 * Номер профиля обязателен и стоит первым, потому что спрашивает отсюда ключ
 * MessagingService: он создан под конкретную пару ключей, а между началом
 * приёма конверта и этим вызовом стоят await'ы на сеть и на ECDH. Пока они
 * идут, человек успевает переключить профиль — и версия без параметра
 * возвращала ключ пары «другой аккаунт↔тот же собеседник». Расшифровка молча
 * не удавалась (`drop silently, no DB touch`), сообщение пропадало навсегда, а
 * отправитель видел его отправленным; на отправке остаток участников группы
 * получал конверт, зашифрованный ключом чужого аккаунта.
 *
 * Кэш и так ключуется парой `${pid}:${peer}` — своим ключом у каждого профиля
 * этот ключ считался всегда, спрашивался только не у того.
 */
export async function getSymmetricKeyForPeer(
  ownerProfileId: number,
  peerPublicKeyB64: string
): Promise<Uint8Array | null> {
  try {
    const pid = ownerProfileId;
    const cacheKey = `${pid}:${peerPublicKeyB64}`;
    const hit = symKeyCache.get(cacheKey);
    if (hit) return new Uint8Array(hit);
    const row = await contactRowGet(pid, peerPublicKeyB64);
    if (!row) return null;
    const j = JSON.parse(row) as { symKey: string };
    const sym = new Uint8Array(Buffer.from(j.symKey, 'base64'));
    // v4.32.665: потолок SYM_CACHE_MAX существовал с самого появления
    // cacheSymKey, но на горячем пути чтения не применялся — здесь запись
    // шла в Map напрямую, мимо помощника, и вытеснение не случалось ни разу.
    // Ключ на каждого пира, чьё сообщение расшифровали за сеанс, оставался в
    // памяти до выхода из учётной записи.
    cacheSymKey(pid, peerPublicKeyB64, sym);
    return sym;
  } catch (e) {
    log.warn('contact_symkey_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
