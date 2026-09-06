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

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { signJson } from '../../crypto/signature';
import {
  parseAndVerifyRelayedFeedEnvelope,
  FEED_ENVELOPE_MAX_AGE_MS,
  type FeedEnvelopePayload,
} from '../feedTransport';
import { getPublicPostFrame, putPublicPostCopy, isPublicPostId } from '../publicPost';

function identity(): { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, did: publicKeyToDidKey(publicKey) };
}

function monthOldPost(did: string): FeedEnvelopePayload {
  return {
    type: 'feed_post',
    postId: 'f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246',
    authorDid: did,
    ts: Date.now() - 30 * 24 * 60 * 60 * 1000,
    data: { kind: 'post', text: 'месяц назад', authorName: 'Автор' },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('публикация по ссылке', () => {
  it('приходит с сервера кадром, который проходит обычную проверку подписи', async () => {
    const { pair, did } = identity();
    const payload = monthOldPost(did);
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

    // Тот самый месячный возраст: по умолчанию конверт отвергается — эта
    // защита от повторного вброса из сети остаётся на месте.
    expect(await parseAndVerifyRelayedFeedEnvelope(frame!)).toBeNull();
    expect(FEED_ENVELOPE_MAX_AGE_MS).toBeLessThan(30 * 24 * 60 * 60 * 1000);

    // А по названному вслух адресу — открывается.
    const got = await parseAndVerifyRelayedFeedEnvelope(frame!, { maxAgeMs: Infinity });
    expect(got?.postId).toBe(payload.postId);
    expect((got?.data as { text?: string }).text).toBe('месяц назад');
  });

  it('подменённое сервером тело до приёмного пути не доходит', async () => {
    const { pair, did } = identity();
    const payload = monthOldPost(did);
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
    const payload = monthOldPost(did);
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

  it('id поста, который не уложить в путь URL, наружу не уходит', async () => {
    const { pair, did } = identity();
    expect(isPublicPostId('f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246')).toBe(true);
    expect(isPublicPostId('../../etc/passwd')).toBe(false);
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const bad = { ...monthOldPost(did), postId: '../../etc/passwd' };
    expect(await putPublicPostCopy(pair, bad)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
