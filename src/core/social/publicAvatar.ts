/**
 * Фото профиля «для всех» — через сервер, а не через переписку (v4.32.722).
 *
 * Фотография до сих пор доезжала только конвертом профиля: её видели те, с кем
 * идёт переписка. Незнакомец, открывший карточку по @имени, автор в ленте,
 * участник группы, с которым не переписывались, видели букву в кружке — даже
 * когда владелец выбрал «Кто видит фото: все». Вложение ntfy, которым едет
 * фото в конверте, живёт около трёх часов, и выставить его «для всех» нельзя.
 *
 * Поэтому при положении «все» снимок кладётся на сервер под ключом профиля,
 * подписанный этим же ключом (см. /v1/avatar в server/cloud-vault). При
 * «контакты» и «никто» — снимается оттуда. Показывающая сторона спрашивает
 * сервер пачкой по ключам тех, чьего фото у неё нет, и рисует картинку по
 * адресу с версией.
 *
 * Фото контакта из конверта главнее серверного: его прислал сам владелец
 * именно этому человеку (см. avatarRegistry).
 */
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { cloudBaseUrl } from '../backup/cloudVault';
import { signJson, verifySignedJson } from '../crypto/signature';
import { publicKeyFromB64, publicKeyToB64 } from '../crypto/pubKeyFormat';
import { bytesToBase64Url } from '../utils/base64url';
import { fetchWithDeadline } from '../net/timedFetch';
import { ownFieldGetFor } from '../identity/ownProfile';
import { ownAvatarUriFor } from '../identity/ownAvatar';
import { profileManager } from '../identity/profileManager';
import { avatarVisibilityTryFor } from '../settings/avatarVisibility';
import * as FileSystem from 'expo-file-system/legacy';
import { log } from '../logger';
import type { KeyPairBytes } from '../crypto/keyManager';

const TIMEOUT_MS = 20_000;
/** Потолок сервера на снимок; больше не шлём — всё равно откажет. */
const MAX_IMAGE_BYTES = 400 * 1024;
/** Сколько ключей в одном запросе справки — столько же принимает сервер. */
const LOOKUP_BATCH = 64;
/** Сколько помнить ответ «фото есть/нет», прежде чем спросить снова. */
const LOOKUP_TTL_MS = 30 * 60 * 1000;
/** Пауза, за которую набирается пачка: экран рисует десяток лиц разом. */
const LOOKUP_DEBOUNCE_MS = 60;
/**
 * Потолок на подписанную справку о фото (v4.32.940).
 *
 * Снимок в ней едет base64: 400 КиБ байтов — это около 533 КиБ строки, плюс
 * обвязка. Умолчание `verifySignedJson` — 64 КиБ, и с ним ни одно настоящее
 * фото проверку бы не прошло.
 */
const MAX_SIGNED_PAYLOAD = 600 * 1024;

/* ------------------------------------------------------------------ */
/* Своё фото: выставить или снять.                                     */
/* ------------------------------------------------------------------ */

/** Что уже ушло на сервер от этого профиля за запуск: `put:<hash>` или `del`. */
const published = new Map<number, string>();

/**
 * Байты своего снимка. Сначала — путь: снимок, выбранный до v4.32.556, лежит
 * только файлом, и в базу его переносит именно ownAvatarUriFor.
 */
async function ownAvatarB64(pid: number): Promise<string | null> {
  if (!(await ownAvatarUriFor(pid))) return null;
  const stored = await ownFieldGetFor(pid, 'user_avatar_img');
  return stored && stored.length > 0 ? stored : null;
}

async function sendAvatarRequest(pair: KeyPairBytes, body: Record<string, unknown>): Promise<boolean> {
  const base = cloudBaseUrl();
  if (!base) return false;
  const signed = await signJson(pair, {
    v: 1,
    ts: Date.now(),
    nonce: bytesToBase64Url(randomBytes(16)),
    publicKeyB64: publicKeyToB64(pair.publicKey),
    ...body,
  });
  return fetchWithDeadline(
    `${base}/v1/avatar`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    },
    { timeoutMs: TIMEOUT_MS },
    async (response) => {
      if (!response.ok) {
        log.warn('public_avatar_write_failed', { status: response.status, act: String(body.act) });
        return false;
      }
      return true;
    },
  );
}

/**
 * Привести серверную копию фото в соответствие с решением владельца.
 *
 * Вызывается из рассылки профиля (broadcastMyProfile) — то есть при запуске,
 * после смены фото и после смены «Кто видит фото». Один запрос на изменение:
 * то, что уже ушло за этот запуск, второй раз не шлётся.
 *
 * Непрочитанная настройка — ничего не делаем: ни выставить фото тому, кто его
 * прятал, ни снять его у того, кто показывал, по сбою базы нельзя.
 */
export async function publishOwnAvatarToDirectory(pid: number): Promise<void> {
  if (!cloudBaseUrl()) return;
  let marker: string | null = null;
  try {
    const visibility = await avatarVisibilityTryFor(pid);
    if (visibility === null) return;
    const b64 = visibility === 'everybody' ? await ownAvatarB64(pid) : null;
    const bytes = b64 ? Buffer.from(b64, 'base64') : null;
    const share = bytes !== null && bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES;
    marker = share && bytes
      ? `put:${Buffer.from(sha256(bytes)).toString('hex').slice(0, 32)}`
      : 'del';
    if (published.get(pid) === marker) return;
    if (profileManager.getActiveProfile()?.id !== pid) return;
    const pair = profileManager.getActiveKeyPair();
    if (!pair) return;
    published.set(pid, marker);
    const ok = share
      ? await sendAvatarRequest(pair, { act: 'put', imageB64: b64 })
      : await sendAvatarRequest(pair, { act: 'del' });
    if (!ok && published.get(pid) === marker) published.delete(pid);
  } catch (e) {
    if (marker !== null && published.get(pid) === marker) published.delete(pid);
    log.info('public_avatar_publish_skipped', { err: e instanceof Error ? e.message : String(e) });
  }
}

/* ------------------------------------------------------------------ */
/* Чужие фото: справка пачкой и адрес картинки.                        */
/* ------------------------------------------------------------------ */

/**
 * Что известно про фото одного ключа.
 *
 * `ver` — свёртка, которую назвала справка. По ней видно, что лежащий на
 * устройстве проверенный файл отвечает сегодняшнему ответу сервера и
 * перекачивать нечего.
 */
type Known = { uri: string | null; ver: string | null; at: number };

const known = new Map<string, Known>();
const queued = new Set<string>();
const inFlight = new Set<string>();
/** Ключи, чьё фото прямо сейчас качается и проверяется: `<ключ>:<версия>`. */
const materializing = new Set<string>();
/**
 * Какую версию фото справка назвала последней для каждого ключа.
 *
 * Отдельно от `known.ver` (там лежит версия того, что уже проверено и
 * показывается): пока качается новое фото, старое остаётся на экране, и
 * различить «устарел ответ» от «устарела картинка» больше нечем.
 */
const wanted = new Map<string, string>();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Подписаться на появление новых фото. Возвращает отписку. */
export function subscribePublicAvatars(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** Адрес фото по ключу (base64), если сервер его уже назвал. Синхронная. */
export function publicAvatarUri(pubB64: string): string | null {
  return known.get(pubB64)?.uri ?? null;
}

function wake(): void {
  for (const cb of subs) {
    try { cb(); } catch { /* подписчик отвалился — остальных это не касается */ }
  }
}

function urlKeyOf(pubB64: string): string | null {
  const bytes = publicKeyFromB64(pubB64);
  return bytes ? bytesToBase64Url(bytes) : null;
}

/**
 * Попросить фото этого человека. Только ставит ключ в очередь: вызывается из
 * отрисовки, поэтому ни ждать, ни будить подписчиков синхронно нельзя.
 */
export function requestPublicAvatar(pubB64: string): void {
  if (!cloudBaseUrl()) return;
  const prev = known.get(pubB64);
  if (prev && Date.now() - prev.at < LOOKUP_TTL_MS) return;
  if (queued.has(pubB64) || inFlight.has(pubB64)) return;
  if (!urlKeyOf(pubB64)) return;
  queued.add(pubB64);
  if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, LOOKUP_DEBOUNCE_MS);
}

/**
 * Достать фото и убедиться, что его выложил владелец ключа (v4.32.940).
 *
 * До этой версии показывающая сторона верила серверу на слово. Владелец
 * подписывал снимок при выкладке, сервер подпись проверял — и выбрасывал; на
 * руках у смотрящего оставался адрес вида `/v1/avatar/<ключ>/img`, который
 * уходил прямо в `<Image>`. Любой, кто дотянулся до базы хранилища, подменял
 * человеку лицо, и заметить это было нечем: сервер сам себе свидетель.
 *
 * Здесь подмена ловится до показа. Ключ, по которому спрашивают фото, — это и
 * есть ключ, которым проверяется подпись: он у нас уже свой (из контакта, из
 * ленты, из группы), и подставить вместо него другой сервер не может. Поэтому
 * проверка тут не театр: сервер отдаёт ровно ту строку, которую подписывал
 * владелец, а мы сверяем подпись этим известным нам ключом.
 *
 * Не сошлось — фото нет. Показать «что-нибудь» здесь хуже, чем букву в
 * кружке: буква не врёт, а чужое лицо врёт.
 */
async function verifiedAvatarFile(
  base: string,
  pubB64: string,
  urlKey: string,
  version: string,
): Promise<string | null> {
  const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!dir) return null;
  // Версия в имени: сменил человек фото — сменилось и имя файла, и старое
  // никого не показывает, даже если сервер сейчас недоступен.
  const path = `${dir}pubavatar-${urlKey}-${version}.img`;
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) return path;
  } catch { /* файла нет или не прочесть — сходим на сервер */ }
  const publicKey = publicKeyFromB64(pubB64);
  if (!publicKey) return null;
  const envelope = await fetchWithDeadline(
    `${base}/v1/avatar/${urlKey}/signed`,
    {},
    { timeoutMs: TIMEOUT_MS },
    async (response) => {
      if (!response.ok) return null;
      const body = await response.json() as { payload?: unknown; signature?: unknown };
      return body && typeof body.payload === 'string' && typeof body.signature === 'string'
        ? { payload: body.payload, signature: body.signature }
        : null;
    },
  );
  if (!envelope) return null;
  const claim = await verifySignedJson(publicKey, envelope, MAX_SIGNED_PAYLOAD);
  if (!claim) {
    log.warn('public_avatar_proof_rejected', { reason: 'signature' });
    return null;
  }
  // Подпись сошлась — но подписать могли и снятие фото, и чужой ключ.
  if (claim.act !== 'put' || claim.publicKeyB64 !== publicKeyToB64(publicKey)) {
    log.warn('public_avatar_proof_rejected', { reason: 'subject' });
    return null;
  }
  const imageB64 = claim.imageB64;
  if (typeof imageB64 !== 'string' || imageB64.length === 0) return null;
  const bytes = Buffer.from(imageB64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  // Справка назвала свёртку — это те же байты или другие. Обе половины ответа
  // приходят с одного сервера, и сговориться им ничто не мешает; проверка
  // ловит не злой умысел, а расхождение справки с выдачей.
  if (Buffer.from(sha256(bytes)).toString('hex').slice(0, 32) !== version) {
    log.warn('public_avatar_proof_rejected', { reason: 'version' });
    return null;
  }
  try {
    await FileSystem.writeAsStringAsync(path, imageB64, { encoding: FileSystem.EncodingType.Base64 });
  } catch (e) {
    log.info('public_avatar_save_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
  return path;
}

/**
 * Проверить и положить фото тех, про кого справка назвала новую версию.
 *
 * По одному: пачка — это до шестидесяти четырёх снимков по 400 КиБ, и тянуть
 * их разом незачем. Лицо появляется по мере проверки, подписчики будятся
 * после каждого.
 */
async function materialize(
  base: string,
  pending: { pubB64: string; urlKey: string; version: string }[],
): Promise<void> {
  for (const { pubB64, urlKey, version } of pending) {
    const tag = `${pubB64}:${version}`;
    if (materializing.has(tag)) continue;
    materializing.add(tag);
    try {
      const uri = await verifiedAvatarFile(base, pubB64, urlKey, version);
      const prev = known.get(pubB64);
      // Пока качали, могли сменить аккаунт (resetPublicAvatars) или узнать
      // новую версию — тогда этот ответ уже не про то, что показывается.
      if (!prev || wanted.get(pubB64) !== version) continue;
      if (uri === null && prev.uri === null) continue;
      known.set(pubB64, { uri, ver: uri ? version : null, at: prev.at });
      wake();
    } catch (e) {
      log.info('public_avatar_fetch_failed', { err: e instanceof Error ? e.message : String(e) });
    } finally {
      materializing.delete(tag);
    }
  }
}

async function flush(): Promise<void> {
  const base = cloudBaseUrl();
  const batch = Array.from(queued).slice(0, LOOKUP_BATCH);
  for (const key of batch) {
    queued.delete(key);
    inFlight.add(key);
  }
  if (queued.size > 0 && !timer) timer = setTimeout(() => { timer = null; void flush(); }, LOOKUP_DEBOUNCE_MS);
  if (!base || batch.length === 0) {
    for (const key of batch) inFlight.delete(key);
    return;
  }
  const byUrlKey = new Map<string, string>();
  for (const key of batch) {
    const urlKey = urlKeyOf(key);
    if (urlKey) byUrlKey.set(urlKey, key);
  }
  let changed = false;
  const pending: { pubB64: string; urlKey: string; version: string }[] = [];
  try {
    const found = await fetchWithDeadline(
      `${base}/v1/avatars/lookup`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: Array.from(byUrlKey.keys()) }),
      },
      { timeoutMs: TIMEOUT_MS },
      async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { found?: unknown };
        return body && typeof body.found === 'object' && body.found !== null
          ? body.found as Record<string, unknown>
          : null;
      },
    );
    // Сбой справки не записываем как «фото нет»: спросим при следующей отрисовке.
    if (found) {
      const now = Date.now();
      for (const [urlKey, pubB64] of byUrlKey) {
        const v = found[urlKey];
        const version = typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null;
        const prev = known.get(pubB64);
        if (version === null) {
          // Фото нет или его сняли — показывать больше нечего.
          if (prev?.uri) changed = true;
          wanted.delete(pubB64);
          known.set(pubB64, { uri: null, ver: null, at: now });
          continue;
        }
        wanted.set(pubB64, version);
        if (prev && prev.ver === version && prev.uri) {
          known.set(pubB64, { ...prev, at: now });
          continue;
        }
        // Старое проверенное фото остаётся на экране, пока не проверено новое:
        // мигнуть буквой в кружке ради секунды ожидания незачем.
        known.set(pubB64, { uri: prev?.uri ?? null, ver: prev?.ver ?? null, at: now });
        pending.push({ pubB64, urlKey, version });
      }
    }
  } catch (e) {
    log.info('public_avatar_lookup_failed', { err: e instanceof Error ? e.message : String(e) });
  } finally {
    for (const key of batch) inFlight.delete(key);
  }
  if (changed) wake();
  if (pending.length > 0) await materialize(base, pending);
}

/** Смена аккаунта, выход, тесты: забыть всё, что спрашивали. */
export function resetPublicAvatars(): void {
  known.clear();
  queued.clear();
  published.clear();
  materializing.clear();
  wanted.clear();
  if (timer) { clearTimeout(timer); timer = null; }
}
