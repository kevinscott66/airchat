// v4.32.612: ссылка на публикацию обязана открываться у того, у кого записи нет.
//
// До этой версии переход по `.../l/post/<id>` искал пост только в местной базе
// и всегда отвечал «не найдена» — то есть работал ровно у того, кому ссылка
// была не нужна. Здесь проверяется вторая половина: копия конверта уходит на
// сервер, приходит обратно, подпись сверяется заново, а недельный срок
// годности сетевых конвертов на этот путь не распространяется — иначе ссылка
// на публикацию месячной давности не открылась бы никогда.
jest.mock('../../backup/cloudVault', () => ({ cloudBaseUrl: () => 'https://vault.example' }));
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn() },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
const mockWarns: Array<{ event: string; data: Record<string, unknown> }> = [];
jest.mock('../../logger', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn((event: string, data: Record<string, unknown>) => {
      mockWarns.push({ event, data: data ?? {} });
    }),
  },
}));

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { signJson } from '../../crypto/signature';
import {
  parseAndVerifyRelayedFeedEnvelope,
  FEED_ENVELOPE_MAX_AGE_MS,
  type FeedEnvelopePayload,
} from '../feedTransport';
import {
  deletePublicPostCopy,
  getPublicPostFrame,
  publicPostCopyExists,
  putPublicPostCopy,
  isPublicPostId,
} from '../publicPost';

function identity(): { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, did: publicKeyToDidKey(publicKey) };
}

/**
 * Публикация заведомо старше окна приёма.
 *
 * v4.32.614: было ровно тридцать суток — ровно столько же, сколько стало окно,
 * и разница держалась на паре миллисекунд между вызовами `Date.now()`. Теперь
 * возраст берётся с запасом от самого окна, а не от переписанного числа.
 */
function expiredPost(did: string): FeedEnvelopePayload {
  return {
    type: 'feed_post',
    postId: 'f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246',
    authorDid: did,
    ts: Date.now() - FEED_ENVELOPE_MAX_AGE_MS - 24 * 60 * 60 * 1000,
    data: { kind: 'post', text: 'месяц назад', authorName: 'Автор' },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('публикация по ссылке', () => {
  it('приходит с сервера кадром, который проходит обычную проверку подписи', async () => {
    const { pair, did } = identity();
    const payload = expiredPost(did);
    const signed = await signJson(pair, payload as unknown as Record<string, unknown>);
    globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({
      postId: payload.postId,
      payload: signed.payload,
      signature: signed.signature,
      authorPublicKeyB64: Buffer.from(pair.publicKey).toString('base64'),
      updatedAt: Date.now(),
    }), { status: 200 })) as unknown as typeof fetch;

    const frame = await getPublicPostFrame(payload.postId);
    expect(frame).not.toBeNull();

    // Возраст заведомо за окном приёма: по умолчанию конверт отвергается —
    // эта защита от повторного вброса из сети остаётся на месте.
    expect(await parseAndVerifyRelayedFeedEnvelope(frame!)).toBeNull();
    expect(Number.isFinite(FEED_ENVELOPE_MAX_AGE_MS)).toBe(true);

    // А по названному вслух адресу — открывается.
    const got = await parseAndVerifyRelayedFeedEnvelope(frame!, { maxAgeMs: Infinity });
    expect(got?.postId).toBe(payload.postId);
    expect((got?.data as { text?: string }).text).toBe('месяц назад');
  });

  it('подменённое сервером тело до приёмного пути не доходит', async () => {
    const { pair, did } = identity();
    const payload = expiredPost(did);
    const signed = await signJson(pair, payload as unknown as Record<string, unknown>);
    globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({
      postId: payload.postId,
      payload: signed.payload.replace('месяц назад', 'подмена!!!!'),
      signature: signed.signature,
      authorPublicKeyB64: Buffer.from(pair.publicKey).toString('base64'),
      updatedAt: Date.now(),
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await getPublicPostFrame(payload.postId)).toBeNull();
  });

  it('чужой ключ вместо авторского тоже не проходит', async () => {
    const { pair, did } = identity();
    const stranger = identity();
    const payload = expiredPost(did);
    const signed = await signJson(pair, payload as unknown as Record<string, unknown>);
    globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({
      postId: payload.postId,
      payload: signed.payload,
      signature: signed.signature,
      authorPublicKeyB64: Buffer.from(stranger.pair.publicKey).toString('base64'),
      updatedAt: Date.now(),
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await getPublicPostFrame(payload.postId)).toBeNull();
  });

  it('другая публикация того же автора вместо запрошенной не принимается', async () => {
    // v4.32.614: подпись подтверждает только авторство. Сервер (или тот, кто
    // им притворился) мог отдать на любую ссылку настоящий, правильно
    // подписанный, но ЧУЖОЙ по номеру пост того же автора — и открывший
    // ссылку увидел бы его как содержимое своей ссылки. Проверяется сверка
    // номера внутри подписанного тела с тем, что просили.
    const { pair, did } = identity();
    const other = { ...expiredPost(did), postId: 'f_1788696219251_ffffffffffffffffffffffffffffffff' };
    const signed = await signJson(pair, other as unknown as Record<string, unknown>);
    globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({
      postId: 'f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246',
      payload: signed.payload,
      signature: signed.signature,
      authorPublicKeyB64: Buffer.from(pair.publicKey).toString('base64'),
      updatedAt: Date.now(),
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await getPublicPostFrame('f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246')).toBeNull();
  });

  it('запись и удаление копии подписаны разовым намерением', async () => {
    // v4.32.614: без второго, короткого и одноразового подписанного намерения
    // выложить чужую публикацию мог любой её получатель, а сохранённый ответ
    // сервера отправлялся обратно и воскрешал уже удалённую копию.
    const { pair, did } = identity();
    const payload = expiredPost(did);
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = jest.fn(async (_url: unknown, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    expect(await putPublicPostCopy(pair, payload)).toBe(true);
    expect(await putPublicPostCopy(pair, payload)).toBe(true);
    expect(await deletePublicPostCopy(pair, payload)).toBe(true);
    expect(bodies).toHaveLength(3);

    const intents = bodies.map((body) => {
      const intent = body.intent as { payload?: unknown; signature?: unknown } | undefined;
      expect(typeof intent?.payload).toBe('string');
      expect(typeof intent?.signature).toBe('string');
      const ok = ed25519.verify(
        Buffer.from(String(intent!.signature), 'base64'),
        Buffer.from(String(intent!.payload), 'utf8'),
        pair.publicKey,
      );
      expect(ok).toBe(true);
      return JSON.parse(String(intent!.payload)) as Record<string, unknown>;
    });

    expect(intents.map((i) => i.act)).toEqual(['put', 'put', 'del']);
    for (const intent of intents) {
      expect(intent.v).toBe(1);
      expect(intent.postId).toBe(payload.postId);
      expect(intent.publicKeyB64).toBe(Buffer.from(pair.publicKey).toString('base64'));
      expect(Math.abs(Date.now() - Number(intent.ts))).toBeLessThan(60_000);
    }
    // Разовое число у каждой записи своё — иначе сервер погасил бы первое и
    // отверг всё последующее, а повтор перестал бы отличаться от новой записи.
    expect(new Set(intents.map((i) => i.nonce)).size).toBe(3);
  });

  it('id поста, который не уложить в путь URL, наружу не уходит', async () => {
    const { pair, did } = identity();
    expect(isPublicPostId('f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246')).toBe(true);
    expect(isPublicPostId('../../etc/passwd')).toBe(false);
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const bad = { ...expiredPost(did), postId: '../../etc/passwd' };
    expect(await putPublicPostCopy(pair, bad)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * v4.32.614: отказ сервера перестал быть безымянным.
 *
 * Все четыре запроса возвращают наружу «да» или «нет», и на два из них — снятие
 * копии и проверку её наличия — журнал не отзывался вовсе. Между тем от причины
 * зависит поведение: отвергнутую подпись повторять бессмысленно, а разрыв связи
 * ложится в очередь повторов. Ниже проверяется, что причина доходит до журнала
 * и что «копии нет» отказом не считается.
 */
describe('причина отказа сервера', () => {
  beforeEach(() => { mockWarns.length = 0; });

  function refuse(status: number, error?: string): void {
    globalThis.fetch = jest.fn(async () => new Response(
      error === undefined ? null : JSON.stringify({ error }),
      { status, headers: error === undefined ? undefined : { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
  }

  it('снятие копии пишет код ответа и слово сервера', async () => {
    const { pair, did } = identity();
    refuse(400, 'invalid_post_intent');
    const payload: FeedEnvelopePayload = { ...expiredPost(did), type: 'feed_delete', data: { kind: 'delete' } };
    expect(await deletePublicPostCopy(pair, payload)).toBe(false);
    const note = mockWarns.find((w) => w.event === 'public_post_delete_failed');
    expect(note).toBeDefined();
    expect(note?.data.status).toBe(400);
    expect(note?.data.code).toBe('invalid_post_intent');
  });

  it('выкладка копии тоже называет причину', async () => {
    const { pair, did } = identity();
    refuse(429, 'rate_limited');
    expect(await putPublicPostCopy(pair, expiredPost(did))).toBe(false);
    const note = mockWarns.find((w) => w.event === 'public_post_put_failed');
    expect(note?.data.status).toBe(429);
    expect(note?.data.code).toBe('rate_limited');
  });

  it('«копии нет» — это ответ, а не отказ: журнал молчит', async () => {
    refuse(404);
    expect(await publicPostCopyExists('f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246')).toBe(false);
    expect(mockWarns.map((w) => w.event)).not.toContain('public_post_head_failed');
  });

  it('а вот молчание сервера про копию — отказ, и он записан', async () => {
    refuse(503);
    expect(await publicPostCopyExists('f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246')).toBe(false);
    const note = mockWarns.find((w) => w.event === 'public_post_head_failed');
    expect(note?.data.status).toBe(503);
  });
});

/**
 * v4.32.615: id поста из одних точек уводил запрос с адреса публикации.
 *
 * `encodeURIComponent` точку не экранирует, а разбор адреса сворачивает
 * сегменты «.» и «..» по правилам пути. Значит `airchat://l/post/..` от чужого
 * человека заставлял приложение обратиться не к `/v1/post/<id>`, а к соседней
 * точке входа — причём POST'ы несли туда подписанный конверт целиком.
 */
describe('id поста из одних точек', () => {
  it('адрес действительно сворачивается — вот почему это дыра', () => {
    const base = 'https://vault.example';
    expect(new URL(`${base}/v1/post/${encodeURIComponent('..')}`).pathname).toBe('/v1/');
    expect(new URL(`${base}/v1/post/${encodeURIComponent('.')}`).pathname).toBe('/v1/post/');
    expect(new URL(`${base}/v1/post/${encodeURIComponent('..')}/delete`).pathname).toBe('/v1/delete');
  });

  it('проверка id отвергает точки и оставляет годные id', () => {
    expect(isPublicPostId('.')).toBe(false);
    expect(isPublicPostId('..')).toBe(false);
    expect(isPublicPostId('...')).toBe(false);
    expect(isPublicPostId('f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246')).toBe(true);
    // Точка внутри id по-прежнему допустима: сворачивается только целый сегмент.
    expect(isPublicPostId('f_1.2')).toBe(true);
    expect(isPublicPostId('.a')).toBe(true);
  });

  it('ни один из четырёх запросов наружу не уходит', async () => {
    const { pair, did } = identity();
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    for (const bad of ['.', '..', '...']) {
      const payload = { ...expiredPost(did), postId: bad };
      expect(await putPublicPostCopy(pair, payload)).toBe(false);
      expect(await deletePublicPostCopy(pair, payload)).toBe(false);
      expect(await getPublicPostFrame(bad)).toBe(null);
      expect(await publicPostCopyExists(bad)).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('источник: правило живёт в одном месте и на обеих сторонах', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const client = fs.readFileSync(path.join(__dirname, '../publicPost.ts'), 'utf8');
    const server = fs.readFileSync(
      path.join(__dirname, '../../../../server/cloud-vault/index.js'),
      'utf8',
    );
    const code = (src: string) =>
      src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    expect(code(client)).toContain('POST_ID_ONLY_DOTS_RE');
    expect(code(client)).toContain('return !POST_ID_ONLY_DOTS_RE.test(postId);');
    expect(code(server)).toContain('POST_ID_ONLY_DOTS_RE');
    // Сервер обязан ходить через общую проверку, а не через голый набор символов.
    expect(code(server)).not.toContain('POST_ID_RE.test(postId)) return res');
    expect(code(server)).toContain('function isValidPostId(postId) {');
    expect((code(server).match(/!isValidPostId\(postId\)\)/g) ?? []).length).toBe(3);
  });
});
