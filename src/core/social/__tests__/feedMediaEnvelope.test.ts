// v4.32.612: рэтчет на дефект «публикация с фотографией не доходит».
//
// Отправитель подписывал конверт и укладывался в свой предел (2 МБ), а
// получатель отбрасывал его на общем потолке verifySignedJson — 64 КиБ.
// Фотография внутри конверта лежит как base64, то есть любая, кроме совсем
// крошечной, переваливала за этот потолок. Ни ошибки у автора, ни записи у
// получателя: пост с текстом доходил, пост с фотографией исчезал.
//
// Тест держит обе стороны предела: конверт с фотографией проверяется, конверт
// заведомо больше кадрового лимита — нет.
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn() },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));

import { ed25519 } from '@noble/curves/ed25519.js';

import { verifySignedJson, SIGNED_JSON_DEFAULT_MAX_LEN } from '../../crypto/signature';
import { publicKeyToDidKey } from '../../identity/did';
import {
  serializeFeedEnvelope,
  parseAndVerifyFeedEnvelope,
  FEED_ENVELOPE_MAX_BYTES,
  type FeedEnvelopePayload,
} from '../feedTransport';

function identity(): { pair: { secretKey: Uint8Array; publicKey: Uint8Array }; did: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, did: publicKeyToDidKey(publicKey) };
}

function postWithPhoto(did: string, base64Len: number): FeedEnvelopePayload {
  return {
    type: 'feed_post',
    postId: 'f_1_photo',
    authorDid: did,
    ts: Date.now(),
    data: {
      kind: 'post',
      text: 'снимок',
      authorName: 'Автор',
      media: ['A'.repeat(base64Len)],
      mediaMime: ['image/jpeg'],
    },
  };
}

describe('конверт ленты с фотографией', () => {
  it('доходит до получателя, а не отбрасывается по общему потолку', async () => {
    const { pair, did } = identity();
    const frame = await serializeFeedEnvelope(pair, postWithPhoto(did, 200 * 1024));
    expect(frame).not.toBeNull();
    expect(frame!.length).toBeGreaterThan(SIGNED_JSON_DEFAULT_MAX_LEN);
    const got = await parseAndVerifyFeedEnvelope(frame!, did);
    expect(got?.type).toBe('feed_post');
    expect((got?.data as { media?: string[] }).media?.[0]).toHaveLength(200 * 1024);
  });

  it('предел никуда не делся: конверт больше кадрового лимита не собирается', async () => {
    const { pair, did } = identity();
    const frame = await serializeFeedEnvelope(pair, postWithPhoto(did, FEED_ENVELOPE_MAX_BYTES + 1));
    expect(frame).toBeNull();
  });

  it('общий потолок для остальных конвертов остался прежним', async () => {
    const { pair, did } = identity();
    void did;
    const payload = JSON.stringify({ x: 'y'.repeat(SIGNED_JSON_DEFAULT_MAX_LEN) });
    const signature = Buffer.from(
      ed25519.sign(new TextEncoder().encode(payload), pair.secretKey),
    ).toString('base64');
    expect(await verifySignedJson(pair.publicKey, { payload, signature })).toBeNull();
    expect(await verifySignedJson(pair.publicKey, { payload, signature }, payload.length)).not.toBeNull();
  });
});
