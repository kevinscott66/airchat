/**
 * Публичная копия публикации на сервере (v4.32.612).
 *
 * Зачем она вообще есть. Ссылку вида `.../l/post/<id>` открывает человек, у
 * которого этой публикации на устройстве нет и взяться ей неоткуда: лента
 * ходит по контактам, а получатель ссылки автору не контакт. До этой версии
 * ссылка честно писала «публикация не найдена» — и писала так ВСЕГДА, кроме
 * случая, когда пост у открывшего уже был. То есть ссылка не работала.
 *
 * Чем за это платят. Конверт ленты подписан, но не зашифрован: у ссылки нет
 * получателя, чьим ключом её можно было бы закрыть. Значит, копию читает и
 * сервер, и любой, кому ссылка попала. Поэтому копия уходит не при публикации,
 * а только когда автор сам скопировал ссылку или нажал «поделиться»: человек
 * в этот момент и так отдаёт запись наружу.
 *
 * Подпись при этом остаётся единственным основанием доверять содержимому.
 * Сервер её проверяет у себя, но получатель ссылки проверяет её ещё раз сам —
 * кадр приходит на общий приёмный путь ленты, тот же, что и у сети.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { cloudBaseUrl } from '../backup/cloudVault';
import { signJson } from '../crypto/signature';
import { ED25519_SIGNATURE_BYTES, publicKeyFromB64, publicKeyToB64 } from '../crypto/pubKeyFormat';
import { FEED_ENVELOPE_MAGIC, FEED_ENVELOPE_MAX_BYTES } from './feedTransport';
import { log } from '../logger';
import type { KeyPairBytes } from '../crypto/keyManager';
import type { FeedEnvelopePayload } from './feedTransport';

/** Тот же набор символов, что проверяет сервер: id поста уходит в путь URL. */
const POST_ID_RE = /^[A-Za-z0-9_\-.:]{1,128}$/;
const PUBLIC_POST_TIMEOUT_MS = 20_000;

export function isPublicPostId(postId: string): boolean {
  return typeof postId === 'string' && POST_ID_RE.test(postId);
}

/** Настроено ли облако вообще. Без него ссылка остаётся местной. */
export function publicPostStoreAvailable(): boolean {
  return cloudBaseUrl() !== null;
}

async function fetchPublicPost(url: string, init: RequestInit): Promise<Response> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timeout = setTimeout(() => controller?.abort(), PUBLIC_POST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Положить копию. `payload` — ровно тот конверт, который ушёл бы контактам:
 * один и тот же postId, один и тот же ts, одна и та же подпись. Ничего
 * специально «для ссылки» не собирается — иначе открывший ссылку и получивший
 * пост по сети видели бы разные записи.
 */
export async function putPublicPostCopy(
  pair: KeyPairBytes,
  payload: FeedEnvelopePayload,
): Promise<boolean> {
  const base = cloudBaseUrl();
  if (!base) return false;
  if (!isPublicPostId(payload.postId)) return false;
  try {
    const signed = await signJson(pair, payload as unknown as Record<string, unknown>);
    if (signed.payload.length > FEED_ENVELOPE_MAX_BYTES) {
      log.warn('public_post_too_large', { postId: payload.postId.slice(0, 24), bytes: signed.payload.length });
      return false;
    }
    const response = await fetchPublicPost(`${base}/v1/post/${encodeURIComponent(payload.postId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: signed.payload,
        signature: signed.signature,
        authorPublicKeyB64: publicKeyToB64(pair.publicKey),
      }),
    });
    if (!response.ok) {
      log.warn('public_post_put_failed', { postId: payload.postId.slice(0, 24), status: response.status });
      return false;
    }
    log.info('public_post_put_ok', { postId: payload.postId.slice(0, 24) });
    return true;
  } catch (e) {
    log.warn('public_post_put_error', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Забрать копию и собрать из неё обычный кадр ленты.
 *
 * Подпись проверяется здесь, до того как кадр куда-либо уйдёт: ключ автора
 * сервер прислал вместе с записью, и верить ему на слово нельзя — но и не
 * нужно, потому что дальше приёмный путь ленты сверит DID из подписанного
 * тела с этим же ключом. Здесь мы отсекаем испорченное сразу, чтобы в общий
 * путь не попадал заведомый мусор.
 */
export async function getPublicPostFrame(postId: string): Promise<Uint8Array | null> {
  const base = cloudBaseUrl();
  if (!base) return null;
  if (!isPublicPostId(postId)) return null;
  try {
    const response = await fetchPublicPost(`${base}/v1/post/${encodeURIComponent(postId)}`, { method: 'GET' });
    if (!response.ok) {
      if (response.status !== 404) log.warn('public_post_get_failed', { postId: postId.slice(0, 24), status: response.status });
      return null;
    }
    const body = await response.json() as { payload?: unknown; signature?: unknown; authorPublicKeyB64?: unknown };
    if (typeof body.payload !== 'string' || typeof body.signature !== 'string' || typeof body.authorPublicKeyB64 !== 'string') return null;
    if (body.payload.length > FEED_ENVELOPE_MAX_BYTES) return null;
    const pk = publicKeyFromB64(body.authorPublicKeyB64);
    if (!pk) return null;
    const sig = new Uint8Array(Buffer.from(body.signature, 'base64'));
    if (sig.length !== ED25519_SIGNATURE_BYTES) return null;
    if (!ed25519.verify(sig, new TextEncoder().encode(body.payload), pk)) {
      log.warn('public_post_signature_invalid', { postId: postId.slice(0, 24) });
      return null;
    }
    const json = JSON.stringify({ payload: body.payload, signature: body.signature });
    const jsonBytes = new TextEncoder().encode(json);
    if (jsonBytes.length + 1 > FEED_ENVELOPE_MAX_BYTES) return null;
    const frame = new Uint8Array(jsonBytes.length + 1);
    frame[0] = FEED_ENVELOPE_MAGIC;
    frame.set(jsonBytes, 1);
    return frame;
  } catch (e) {
    log.warn('public_post_get_error', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Снять копию. Зовётся из удаления поста: пока копия лежит, ссылка открывает
 * то, что автор уже стёр у себя и у контактов.
 */
export async function deletePublicPostCopy(
  pair: KeyPairBytes,
  payload: FeedEnvelopePayload,
): Promise<boolean> {
  const base = cloudBaseUrl();
  if (!base) return false;
  if (!isPublicPostId(payload.postId)) return false;
  try {
    const signed = await signJson(pair, payload as unknown as Record<string, unknown>);
    const response = await fetchPublicPost(`${base}/v1/post/${encodeURIComponent(payload.postId)}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: signed.payload,
        signature: signed.signature,
        authorPublicKeyB64: publicKeyToB64(pair.publicKey),
      }),
    });
    return response.ok;
  } catch (e) {
    log.warn('public_post_delete_error', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
