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
import { Buffer } from 'buffer';
import { randomBytes } from '@noble/hashes/utils.js';
import { cloudBaseUrl } from '../backup/cloudVault';
import { signJson, verifySignedJson } from '../crypto/signature';
import { publicKeyFromB64, publicKeyToB64 } from '../crypto/pubKeyFormat';
import { bytesToBase64Url } from '../utils/base64url';
import { FEED_ENVELOPE_MAGIC, FEED_ENVELOPE_MAX_BYTES } from './feedTransport';
import { log } from '../logger';
import { fetchWithDeadline } from '../net/timedFetch';
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

/** Запрос со сроком на весь обмен, включая чтение тела (см. timedFetch). */
function fetchPublicPost<T>(
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  return fetchWithDeadline(url, init, { timeoutMs: PUBLIC_POST_TIMEOUT_MS }, read);
}

/**
 * Слово сервера об отказе рядом с кодом ответа (v4.32.614).
 *
 * Раньше любой неуспех сворачивался здесь в `false`, а снятие копии и проверка
 * её наличия не оставляли в журнале и того. Отличить «сервер отверг подпись»
 * от «нет связи» и от «копии там и не было» было нечем — а от этого зависит,
 * имеет ли смысл повторять запрос. Тело ответа сервер пишет одним словом в
 * поле `error`; оно и кладётся рядом с кодом.
 */
async function refusalCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body?.error === 'string' ? body.error.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Намерение записи — вторая, короткая подпись рядом с конвертом (v4.32.614).
 *
 * Сам конверт подписан, но он в неизменном виде есть у всех, кому пост дошёл
 * по ленте, и отдаётся всякому, кто открыл ссылку. Значит, его подпись говорит
 * только «это написал такой-то», но не «такой-то хочет положить это сюда
 * сейчас». Без второй подписи чужую публикацию мог выложить любой получатель,
 * сохранённый ответ сервера можно было отправить обратно и воскресить уже
 * удалённую копию, а старую редакцию — положить поверх новой.
 *
 * Разовое число сервер гасит у себя, поэтому повторить тот же запрос нельзя
 * даже в пределах окна расхождения часов.
 */
async function buildPostIntent(
  pair: KeyPairBytes,
  postId: string,
  act: 'put' | 'del',
): Promise<{ payload: string; signature: string }> {
  return signJson(pair, {
    v: 1,
    act,
    postId,
    ts: Date.now(),
    nonce: bytesToBase64Url(randomBytes(16)),
    publicKeyB64: publicKeyToB64(pair.publicKey),
  });
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
    // v4.32.614: потолок сервера считается в БАЙТАХ (Buffer.byteLength), а
    // `.length` у строки — в единицах UTF-16. На русском тексте это ровно
    // вдвое меньше настоящего размера, так что проверка пропускала конверт,
    // который сервер затем молча отвергал как слишком большой.
    const payloadBytes = Buffer.byteLength(signed.payload, 'utf8');
    if (payloadBytes > FEED_ENVELOPE_MAX_BYTES) {
      log.warn('public_post_too_large', { postId: payload.postId.slice(0, 24), bytes: payloadBytes });
      return false;
    }
    const intent = await buildPostIntent(pair, payload.postId, 'put');
    const ok = await fetchPublicPost(
      `${base}/v1/post/${encodeURIComponent(payload.postId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: signed.payload,
          signature: signed.signature,
          authorPublicKeyB64: publicKeyToB64(pair.publicKey),
          intent,
        }),
      },
      async (response) => {
        if (!response.ok) {
          log.warn('public_post_put_failed', {
            postId: payload.postId.slice(0, 24),
            status: response.status,
            code: await refusalCode(response),
          });
          return false;
        }
        return true;
      },
    );
    if (ok) log.info('public_post_put_ok', { postId: payload.postId.slice(0, 24) });
    return ok;
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
    const body = await fetchPublicPost(
      `${base}/v1/post/${encodeURIComponent(postId)}`,
      { method: 'GET' },
      async (response) => {
        if (!response.ok) {
          if (response.status !== 404) {
            log.warn('public_post_get_failed', {
              postId: postId.slice(0, 24),
              status: response.status,
              code: await refusalCode(response),
            });
          }
          return null;
        }
        return await response.json() as { payload?: unknown; signature?: unknown; authorPublicKeyB64?: unknown };
      },
    );
    if (!body) return null;
    if (typeof body.payload !== 'string' || typeof body.signature !== 'string' || typeof body.authorPublicKeyB64 !== 'string') return null;
    if (Buffer.byteLength(body.payload, 'utf8') > FEED_ENVELOPE_MAX_BYTES) return null;
    const pk = publicKeyFromB64(body.authorPublicKeyB64);
    if (!pk) return null;
    // v4.32.614: общая проверка подписи вместо своей копии ed25519.verify —
    // она же сама считает длину подписи и разбирает нагрузку.
    const parsed = await verifySignedJson(
      pk,
      { payload: body.payload, signature: body.signature },
      FEED_ENVELOPE_MAX_BYTES,
    );
    if (!parsed) {
      log.warn('public_post_signature_invalid', { postId: postId.slice(0, 24) });
      return null;
    }
    // v4.32.614: подпись подтверждает авторство, но не то, что нам отдали
    // именно запрошенное. Без этой сверки сервер (или посредник) мог подменить
    // ответ другой, настоящей и правильно подписанной публикацией того же
    // автора — а открывший ссылку увидел бы её как содержимое своей ссылки.
    if (parsed.postId !== postId) {
      log.warn('public_post_id_mismatch', { postId: postId.slice(0, 24) });
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
 * Лежит ли копия на сервере — не скачивая саму копию (v4.32.614).
 *
 * Нужна правке. Обновлять копию можно только у той записи, которую автор уже
 * отдал наружу сам: положить её по правке записи, ссылку на которую никто не
 * копировал, значит выложить наружу то, чего человек не выкладывал.
 *
 * HEAD, а не GET: ответ нужен один — есть или нет, — а тело копии доходит до
 * двух мегабайт. Ничего нового о владельце это не сообщает: копия и так
 * открыта всякому, у кого есть ссылка, ради чего она и лежит.
 */
export async function publicPostCopyExists(postId: string): Promise<boolean> {
  const base = cloudBaseUrl();
  if (!base) return false;
  if (!isPublicPostId(postId)) return false;
  try {
    return await fetchPublicPost(
      `${base}/v1/post/${encodeURIComponent(postId)}`,
      { method: 'HEAD' },
      async (response) => {
        // 404 — это не отказ, а ответ: копии на сервере нет. Всё остальное
        // означает, что мы про копию так ничего и не узнали.
        if (!response.ok && response.status !== 404) {
          log.warn('public_post_head_failed', { postId: postId.slice(0, 24), status: response.status });
        }
        return response.ok;
      },
    );
  } catch (e) {
    log.warn('public_post_head_error', { err: e instanceof Error ? e.message : String(e) });
    return false;
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
    const intent = await buildPostIntent(pair, payload.postId, 'del');
    return await fetchPublicPost(
      `${base}/v1/post/${encodeURIComponent(payload.postId)}/delete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: signed.payload,
          signature: signed.signature,
          authorPublicKeyB64: publicKeyToB64(pair.publicKey),
          intent,
        }),
      },
      async (response) => {
        if (!response.ok) {
          log.warn('public_post_delete_failed', {
            postId: payload.postId.slice(0, 24),
            status: response.status,
            code: await refusalCode(response),
          });
        }
        return response.ok;
      },
    );
  } catch (e) {
    log.warn('public_post_delete_error', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
