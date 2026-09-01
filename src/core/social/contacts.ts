import { bytesEqualConstTime } from '../crypto/bytesEqual';
import { ecdhSharedSecret } from '../crypto/keyManager';
import { deriveSymmetricKey } from '../crypto/encrypt';
import { isEd25519PublicKey, isPubKeyB64, publicKeyFromB64, publicKeyToB64 } from '../crypto/pubKeyFormat';
import { displayNameOrNull, sanitizeDisplayName, sanitizeParagraphText } from './sysLineGuard';
import type { KeyPairBytes } from '../crypto/keyManager';
import {
  kvGet,
  kvDelete,
  kvGetSecret,
  kvSetSecret,
  profileKvGet,
  profileKvSet,
  profileKvDelete,
  notifyChatStorageChanged,
} from '../storage/local';
import { profileScopedKey } from '../storage/kvKeys';
import { isPlainCid } from '../cid';
import { log } from '../logger';
import { publicKeyHash4 } from '../crypto/keyManager';
import { profileManager } from '../identity/profileManager';
import { parseDidKey } from '../identity/did';
import { mergeExplicitContactRow } from './contactRowMerge';

const PREFIX = 'contact:';

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
async function contactRowGet(pid: number, peerPubB64: string): Promise<string | null> {
  const own = await kvGetSecret(profileScopedKey(pid, `${PREFIX}${peerPubB64}`));
  if (own) return own;
  // Глобальный ключ до v4.32.124 наследует только первый профиль — он писался
  // тогда, когда профиль был один.
  if (own == null && pid === 1) return (await kvGetSecret(`${PREFIX}${peerPubB64}`)) || null;
  return null;
}

async function contactRowSet(pid: number, peerPubB64: string, json: string): Promise<void> {
  await kvSetSecret(profileScopedKey(pid, `${PREFIX}${peerPubB64}`), json);
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
  /** Фото контакта: обычный CID или `nb:`-дескриптор вложения. */
  avatarCid?: string;
  /** Метка времени применённого конверта — отбрасываем устаревшие. */
  profileTs?: number;
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
 *   • чистый base64 raw public key (32 байта) — исторический формат ChatListScreen
 *   • строка с любыми пробелами/переносами вокруг
 *
 * Возвращает Uint8Array длиной 32 (Ed25519 public key), либо null если парс неудачен.
 */
export function parseContactId(input: string): Uint8Array | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;

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
    const existing = await contactRowGet(pid, b64);
    await contactRowSet(
      pid,
      b64,
      mergeExplicitContactRow(existing, {
        displayName: name,
        symKeyB64: Buffer.from(sym).toString('base64'),
        profileCid,
      })
    );
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
  const pre = await contactRowGet(pid, b64);
  if (pre) return false;
  const [kA, kB] = [myB64, b64].sort();
  const shared = ecdhSharedSecret(pair.secretKey, peerPublicKey);
  const salt = new TextEncoder().encode(`airchat-dm:${kA}:${kB}`);
  const sym = deriveSymmetricKey(shared, salt);
  // v4.32.115: serialize via withContactLock + re-check under lock to close TOCTOU window.
  const created = await withContactLock(pid, async () => {
    const existing = await contactRowGet(pid, b64);
    if (existing) return false;
    await contactRowSet(
      pid,
      b64,
      JSON.stringify({
        displayName: displayName?.trim() || '',
        symKey: Buffer.from(sym).toString('base64'),
        implicit: true,
      })
    );
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
  try {
    const pid = ownerProfileId;
    // v4.32.227 (PERF): serve from the short-TTL cache to avoid the N+1 SQLite
    // read storm on every render/sweep (see contactsListCache above).
    const cached = contactsListCache.get(pid);
    // v4.32.227: return a shallow copy so a caller doing in-place sort/splice
    // can't corrupt the shared cached array for everyone else.
    if (cached && Date.now() - cached.at < CONTACTS_LIST_TTL_MS) return cached.data.slice();
    let raw = await profileKvGet(pid, 'contacts_index');
    // v4.32.124 (AUDIT P0 #8): only the primary profile (pid=1) may inherit
    // legacy unscoped contacts. Previously every new profile fell back to
    // global `contacts_index` / `contact:<b64>`, which silently leaked
    // profile A's contact list into profile B on first open.
    if (!raw && pid === 1) {
      raw = await kvGet('contacts_index');
      if (raw) {
        await profileKvSet(pid, 'contacts_index', raw);
        log.info('contacts_index_migrated', { pid });
      }
    }
    if (!raw) return [];
    // v4.32.115: Array.isArray guard against corrupted index.
    const parsed = JSON.parse(raw);
    // v4.32.198 (Round-28 #6): filter non-string / wrong-length IDs and cap
    // count. A corrupt/imported contacts_index with 100k entries stalls
    // listContacts and breaks SQL param binding in profileKvGet.
    const ids = (Array.isArray(parsed) ? (parsed as unknown[]) : [])
      // v4.32.368: форма ключа общая (crypto/pubKeyFormat), не только длина.
      .filter(isPubKeyB64)
      .slice(0, 5000);
    const out: Contact[] = [];
    // v4.32.124 (AUDIT P1 Block 7): collect IDs whose row is missing OR
    // unparseable — heal the index persistently instead of re-warning on
    // every listContacts() call.
    const badIds: string[] = [];
    for (const id of ids) {
      const row = await contactRowGet(pid, id);
      // v4.32.71: skip empty-string rows (legacy artefact of old deleteContact
      // which wrote '' instead of DELETE'ing the row); JSON.parse('') would throw.
      if (!row || !row.trim()) {
        badIds.push(id);
        continue;
      }
      try {
        const j = JSON.parse(row) as {
          displayName?: unknown; profileCid?: unknown; implicit?: unknown;
          peerName?: unknown; bio?: unknown; avatarCid?: unknown; profileTs?: unknown;
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
          ...(bio ? { bio } : {}),
          ...(typeof j.avatarCid === 'string' && j.avatarCid ? { avatarCid: j.avatarCid } : {}),
          ...(typeof j.profileTs === 'number' && Number.isFinite(j.profileTs) ? { profileTs: j.profileTs } : {}),
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
    return [];
  }
}

export async function rememberContactId(peerPublicKeyB64: string): Promise<void> {
  const pid = activeProfileId();
  await withContactLock(pid, () => rememberContactIdUnlocked(pid, peerPublicKeyB64));
}

/** v4.32.115: unlocked inner — callers already holding withContactLock use this. */
async function rememberContactIdUnlocked(pid: number, peerPublicKeyB64: string): Promise<void> {
  let raw = await profileKvGet(pid, 'contacts_index');
  // v4.32.124 (AUDIT P0 #8): legacy fallback only for primary profile.
  if (!raw) raw = pid === 1 ? ((await kvGet('contacts_index')) ?? '[]') : '[]';
  try {
    const parsed = JSON.parse(raw);
    // v4.32.115: guard against corrupted index (e.g. `{}` instead of `[]`).
    const arr = Array.isArray(parsed) ? (parsed as string[]) : [];
    const ids = new Set(arr);
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
  profile: { name: string | null; username?: string | null; bio: string | null; avatarCid: string | null; ts: number }
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
export async function setPeerProfileFor(
  pid: number,
  peerPublicKeyB64: string,
  profile: { name: string | null; username?: string | null; bio: string | null; avatarCid: string | null; ts: number }
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
        avatarCid: profile.avatarCid ?? '',
        profileTs: profile.ts,
      };
      const same =
        (j.peerName ?? '') === next.peerName &&
        (profile.username === undefined || (j.peerUsername ?? '') === next.peerUsername) &&
        (j.bio ?? '') === next.bio &&
        (j.avatarCid ?? '') === next.avatarCid;
      await contactRowSet(pid, peerPublicKeyB64, JSON.stringify({ ...j, ...next }));
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
    if (!row) return;
    // v4.32.115: preserve `implicit` flag across renames.
    const j = JSON.parse(row) as { displayName: string; symKey: string; profileCid?: string; implicit?: boolean };
    // v4.32.192 (Round-22 #7): strip control chars + cap name at 64 chars so
    // a malicious profile-card or deep-link can't bloat contacts_index JSON.
    j.displayName = (sanitizeDisplayName(newName, 64) ?? '').trim();
    await contactRowSet(pid, peerPublicKeyB64, JSON.stringify(j));
  });
  notifyChatStorageChanged();
  emitContactsChanged();
}

/** Remove a contact. The sym key is gone; the peer can no longer send readable DMs. */
export async function deleteContact(peerPublicKeyB64: string): Promise<void> {
  const pid = activeProfileId();
  await withContactLock(pid, async () => {
    // Remove from index
    // v4.32.124 (AUDIT P0 #8): legacy fallback only for primary profile.
    const raw =
      (await profileKvGet(pid, 'contacts_index')) ??
      (pid === 1 ? (await kvGet('contacts_index')) ?? '[]' : '[]');
    let ids: Set<string>;
    try {
      const parsed = JSON.parse(raw);
      ids = new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
    } catch {
      ids = new Set();
    }
    ids.delete(peerPublicKeyB64);
    await profileKvSet(pid, 'contacts_index', JSON.stringify([...ids]));
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
    symKeyCache.set(cacheKey, new Uint8Array(sym));
    return sym;
  } catch (e) {
    log.warn('contact_symkey_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
