/**
 * Нечитаемый справочник контактов больше не выдаёт пост за «локальный»
 * (v4.32.752).
 *
 * Дефект. `broadcastFeedEnvelope` брала адресатов через `listContacts`, а тот
 * сводит «контактов нет» и «список не прочитался» в один пустой массив. Дальше
 * пустота шла прямым ходом: `total: 0` → `classifyBroadcast` → `no-recipients`
 * → `dispositionOf` → `local-only`, то есть «повторять нечего». Пост оставался
 * лежать в своей ленте, человеку показывалось «только у вас», а контакты, все
 * до одного живые, не узнавали о нём никогда: следующей попытки у записи не
 * было — очередь повторов её не принимала.
 *
 * Занятая база — обычное дело: в этот же момент идёт приём конвертов, чистка
 * старых записей, переключение профиля. Секунда невезения стоила поста.
 *
 * Правка. Рассылка читает справочник различающим чтением (`listContactsRead`,
 * тот же приём, что у сторис в v4.32.724) и отдельным полем сообщает наверх,
 * что адресаты неизвестны. Исход `unknown-recipients` судится как `queue-retry`
 * наравне с «нет сети»: запись идёт в очередь и будет отправлена, когда база
 * ответит. Комментарий, его удаление и реакция на него ходят другим путём — их
 * очередь называется outbox, и проверка «неполная доставка» при нулевом `total`
 * была ложной; теперь все три спрашивают `feedBroadcastNeedsRetry`.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => true) },
}));
jest.mock('../contacts', () => ({
  listContacts: jest.fn(async () => mockContacts ?? []),
  listContactsRead: jest.fn(async () => mockContacts),
  listContactsReadDetailed: jest.fn(async () =>
    mockContacts === null ? null : { contacts: mockContacts, missing: 0 },
  ),
}));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
}));

import fs from 'fs';
import path from 'path';

import { Buffer } from 'buffer';
import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import {
  classifyBroadcast,
  dispositionOf,
  needsRetryQueue,
  reportOf,
} from '../../sync/publishOutcome';
import {
  broadcastFeedEnvelope,
  feedBroadcastNeedsRetry,
  serializeFeedEnvelope,
  type FeedEnvelopePayload,
} from '../feedTransport';

/** Справочник, который вернёт различающее чтение: `null` — отказ базы. */
let mockContacts: { peerPublicKey: string }[] | null = [];

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/** Свежая пара ключей и её base64/DID — как у настоящего контакта. */
function newIdentity() {
  const { secretKey, publicKey } = ed25519.keygen();
  return {
    pair: { secretKey, publicKey },
    did: publicKeyToDidKey(publicKey),
    b64: Buffer.from(publicKey).toString('base64'),
  };
}

/** Подписанный кадр поста — то, что рассылка разносит по адресатам. */
async function frame(): Promise<Uint8Array> {
  const me = newIdentity();
  const payload = {
    type: 'feed_post',
    postId: 'p-752',
    authorDid: me.did,
    ts: Date.now(),
    data: { kind: 'post', text: 'привет' },
  } as unknown as FeedEnvelopePayload;
  const f = await serializeFeedEnvelope(me.pair, payload);
  if (!f) throw new Error('serializeFeedEnvelope вернул null');
  return f;
}

beforeEach(() => {
  mockContacts = [];
});

describe('справочник не прочитался', () => {
  it('рассылка называет это отдельно, а не нулём адресатов', async () => {
    mockContacts = null;

    const res = await broadcastFeedEnvelope(await frame());

    expect(res).toEqual({
      total: 0, success: 0, successDids: [], contactsUnreadable: true, contactsMissing: 0,
    });
  });

  it('исход — «адресаты неизвестны», и он идёт в очередь повторов', () => {
    const attempt = classifyBroadcast(true, 0, 0, true);

    expect(attempt).toBe('unknown-recipients');
    expect(dispositionOf(attempt)).toBe('queue-retry');
    expect(needsRetryQueue(attempt)).toBe(true);
    // Человеку про такой пост говорят «в очереди», а не «только у вас».
    expect(reportOf(attempt, true)).toBe('queued');
    expect(reportOf(attempt, false)).toBe('stranded');
  });

  it('комментарий тоже просится на повтор: 0 из 0 — не полная доставка', () => {
    const blind = {
      delivered: {
        total: 0, success: 0, successDids: [], contactsUnreadable: true, contactsMissing: 0,
      },
    };

    expect(feedBroadcastNeedsRetry(blind)).toBe(true);
    // Именно на этом месте старое условие и молчало.
    expect(blind.delivered.success < blind.delivered.total).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: пустой справочник остаётся пустым справочником', () => {
  it('контактов нет — рассылать действительно некому', async () => {
    mockContacts = [];

    const res = await broadcastFeedEnvelope(await frame());

    expect(res).toEqual({
      total: 0, success: 0, successDids: [], contactsUnreadable: false, contactsMissing: 0,
    });
    expect(classifyBroadcast(true, 0, 0, false)).toBe('no-recipients');
    expect(needsRetryQueue('no-recipients')).toBe(false);
    expect(reportOf('no-recipients', false)).toBe('local-only');
  });

  it('контакт есть — доставка считается по-прежнему', async () => {
    const peer = newIdentity();
    mockContacts = [{ peerPublicKey: peer.b64 }];

    const res = await broadcastFeedEnvelope(await frame());

    expect(res).toEqual({
      total: 1,
      success: 1,
      successDids: [peer.did],
      contactsUnreadable: false,
      contactsMissing: 0,
    });
    expect(feedBroadcastNeedsRetry(res && { delivered: res })).toBe(false);
  });

  it('кадр не собрался — повтор нужен, как и раньше', () => {
    expect(feedBroadcastNeedsRetry(null)).toBe(true);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('рассылка читает справочник различающим чтением', () => {
    const src = codeOnly(read('feedTransport.ts'));
    expect(src).toContain('const contactsRead = await listContactsReadDetailed();');
    expect(src).toContain('if (contactsRead === null) {');
    expect(src).toContain("log.warn('feed_broadcast_contacts_unreadable');");
    // Схлопывающего чтения в рассылке не осталось вовсе.
    expect(src).not.toContain('await listContacts()');
  });

  it('оба разбора исхода публикации спрашивают про нечитаемость', () => {
    const feed = codeOnly(read('feedService.ts'));
    const calls = feed.match(/classifyBroadcast\(/g) ?? [];
    expect(calls).toHaveLength(3);
    // Третий вызов — ветка «сети нет»: там рассылки не было вовсе и спрашивать
    // не о чем. Остальные два получают ответ рассылки.
    expect(feed.match(/result\.delivered\.contactsUnreadable,/g) ?? []).toHaveLength(2);
  });

  it('три outbox-ветки перешли на общую проверку', () => {
    const feed = codeOnly(read('feedService.ts'));
    expect(feed.match(/feedBroadcastNeedsRetry\(res\)/g) ?? []).toHaveLength(3);
    expect(feed).not.toContain('!res || res.delivered.success < res.delivered.total');
  });
});
