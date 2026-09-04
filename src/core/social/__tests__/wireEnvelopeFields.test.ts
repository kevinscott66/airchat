/**
 * v4.32.581 — рэтчет: у разбора конверта не осталось непроверенных полей.
 *
 * `deserializeEnvelope` с v4.32.197 приводит по типу и режет по потолку восемь
 * полей из девяти: идентификатор, отправителя, получателя, метку времени,
 * хвост переписки, ответ, список медиа и счётчик пересылок. Девятое —
 * `encryptedContent` — уходило прямо в `Buffer.from`, полагаясь на объявленный
 * тип параметра. Тип этот описывает НАШИ намерения, а не то, что прислали:
 * конверт, подписанный настоящим ключом контакта, вправе нести там число.
 * Buffer.from на числе бросает, и вместо честного «конверт не годен, отбросить»
 * разбор уходил в исключение.
 *
 * Проверка идёт через `parseEnvelopeFromWire` — тот самый вход, куда попадает
 * байтовый кадр из сети.
 */
jest.mock('../../transport/ipfs/heliaNode', () => ({ getHeliaUnixfs: async () => null }));
jest.mock('../../transport/ipfs/node', () => ({ addToIpfs: async () => '', catFromIpfs: async () => null }));
jest.mock('../../transport/ipfs/blockstore', () => ({ cacheGet: async () => null, cachePut: async () => undefined }));
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: async () => true, pubsubSubscribe: async () => undefined }));
jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { parseEnvelopeFromWire } from '../messageStore';

const wire = (env: Record<string, unknown>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(env));

const base = {
  messageId: 'm1',
  senderDid: 'did:key:zSender',
  recipientDid: 'did:key:zRecipient',
  encryptedContent: Buffer.from('привет').toString('base64'),
  timestamp: 1_700_000_000_000,
};

describe('поля кадра приводятся, а не принимаются на слово', () => {
  it('нормальный кадр разбирается', () => {
    const env = parseEnvelopeFromWire(wire(base));
    expect(env).not.toBeNull();
    expect(Buffer.from(env!.encryptedContent).toString('utf8')).toBe('привет');
  });

  it.each([
    ['число', 123],
    ['null', null],
    ['объект', { a: 1 }],
    ['массив', ['AA==']],
    ['отсутствует', undefined],
  ])('шифротекст-%s не роняет разбор', (_name, value) => {
    const env = parseEnvelopeFromWire(wire({ ...base, encryptedContent: value }));
    // Разбор обязан вернуть результат, а не бросить: пустой шифротекст
    // отсеется дальше, на расшифровке, по общему правилу.
    expect(env).not.toBeNull();
    expect(env!.encryptedContent).toHaveLength(0);
  });

  it('остальные поля по-прежнему приводятся по типу', () => {
    const env = parseEnvelopeFromWire(wire({
      ...base, messageId: 42, senderDid: null, timestamp: 'вчера', hops: 99,
    }));
    expect(env).not.toBeNull();
    expect(env!.messageId).toBe('');
    expect(env!.senderDid).toBe('');
    expect(typeof env!.timestamp).toBe('number');
    expect(env!.hops).toBe(3);
  });
});
