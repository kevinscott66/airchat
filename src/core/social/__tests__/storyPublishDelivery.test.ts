/**
 * Публикация сторис: кому конверт ушёл на самом деле.
 *
 * Дефект (v4.32.615). Рассылка считала доставкой любую попытку:
 * `await svc.sendMessage(...); delivered += 1;`. А `sendMessage` на отказ не
 * бросает исключение — он возвращает `null`: заблокированный получатель,
 * исчерпанный часовой лимит. Счётчик выходил равным числу контактов всегда, и
 * единственное предупреждение автору («сохранена, но не ушла никому»,
 * `storyPublishProblem`) не показывалось уже никогда.
 *
 * Вдобавок отказ по блокировке внутри `sendMessage` поднимает баннер «Контакт
 * заблокирован». Публикуя сторис, автор получал по такому баннеру за каждого,
 * кого сам же и заблокировал, — ни одному человеку при этом не написав.
 */

import fs from 'fs';
import path from 'path';

let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `story${++mockUuid}` }));

/** Кому позвали sendMessage и что он ответил. */
const mockSent: string[] = [];
/** Заблокированные — их sendMessage не должен увидеть вовсе. */
const mockBlocked = new Set<string>();
/** Кому sendMessage отвечает отказом (null), не бросая исключение. */
const mockRefuse = new Set<string>();
/** Кому sendMessage бросает исключение. */
const mockThrow = new Set<string>();
/** Контакты профиля. */
let mockContacts: { peerPublicKey: string }[] = [];
/** Топики pubsub, куда что-то опубликовали. */
const mockTopics: string[] = [];

jest.mock('../contacts', () => ({
  listContactsFor: async () => mockContacts,
}));

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async () => {},
    isBlocked: (k: string) => mockBlocked.has(k),
  },
}));

jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (peer: string) => {
      if (mockBlocked.has(peer)) throw new Error('sendMessage не должен звать заблокированного');
      mockSent.push(peer);
      if (mockThrow.has(peer)) throw new Error('сеть');
      return mockRefuse.has(peer) ? null : 'cid1';
    },
  }),
}));

jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubPublish: async (topic: string) => {
    mockTopics.push(topic);
  },
  pubsubSubscribe: async () => null,
}));

jest.mock('../../transport/ipfs/node', () => ({ catFromIpfs: async () => null }));

jest.mock('../../storage/local', () => ({
  insertStory: async () => {},
  deleteExpiredStories: async () => {},
  countActiveStoriesByAuthor: async () => 0,
  STORY_TTL_MS: 24 * 60 * 60 * 1000,
}));

jest.mock('../../identity/ownerPidLookup', () => ({ ownerPidForPublicKey: () => 1 }));
jest.mock('../../identity/did', () => ({ publicKeyToDidKey: () => 'did:key:zTest' }));
jest.mock('../../media/mediaUpload', () => ({ uploadMediaToCid: async () => ({ ok: true, cid: 'nb:x' }) }));
jest.mock('../../media/mediaBlob', () => ({
  isNbCid: () => false,
  parseNbCid: () => null,
  resolveBlobToLocalFile: async () => null,
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { publishStory } from '../storyService';
import { storyPublishProblem } from '../storyPublishOutcome';

const PAIR = { publicKey: new Uint8Array(32).fill(7), secretKey: new Uint8Array(64).fill(9) };

function contact(n: number): string {
  return Buffer.from(new Uint8Array(32).fill(n)).toString('base64');
}

beforeEach(() => {
  mockSent.length = 0;
  mockTopics.length = 0;
  mockBlocked.clear();
  mockRefuse.clear();
  mockThrow.clear();
  mockContacts = [];
});

describe('публикация сторис: счётчик доставки', () => {
  test('все получили — счётчик равен числу контактов', async () => {
    mockContacts = [1, 2, 3].map((n) => ({ peerPublicKey: contact(n) }));
    const res = await publishStory(PAIR, null, 'привет');
    expect(res.contacts).toBe(3);
    expect(res.delivered).toBe(3);
    expect(storyPublishProblem(res, 'image')).toBeNull();
  });

  test('отказ без исключения доставкой не считается', async () => {
    mockContacts = [1, 2, 3].map((n) => ({ peerPublicKey: contact(n) }));
    mockRefuse.add(contact(2));
    const res = await publishStory(PAIR, null, 'привет');
    expect(res.contacts).toBe(3);
    expect(res.delivered).toBe(2);
  });

  test('отказали всем — автор узнаёт об этом', async () => {
    mockContacts = [1, 2].map((n) => ({ peerPublicKey: contact(n) }));
    mockRefuse.add(contact(1));
    mockRefuse.add(contact(2));
    const res = await publishStory(PAIR, null, 'привет');
    expect(res.delivered).toBe(0);
    expect(storyPublishProblem(res, 'image')).toMatch(/не ушла ни одному контакту/);
  });

  test('исключение доставкой не считается — как и раньше', async () => {
    mockContacts = [1, 2].map((n) => ({ peerPublicKey: contact(n) }));
    mockThrow.add(contact(1));
    const res = await publishStory(PAIR, null, 'привет');
    expect(res.delivered).toBe(1);
  });

  test('контактов нет — молчим, а не жалуемся на связь', async () => {
    const res = await publishStory(PAIR, null, 'привет');
    expect(res.contacts).toBe(0);
    expect(res.delivered).toBe(0);
    expect(storyPublishProblem(res, 'image')).toBeNull();
  });
});

describe('публикация сторис: заблокированные', () => {
  test('заблокированному не пишут — ни личным сообщением, ни в топик', async () => {
    mockContacts = [1, 2].map((n) => ({ peerPublicKey: contact(n) }));
    mockBlocked.add(contact(1));
    const res = await publishStory(PAIR, null, 'привет');
    expect(mockSent).toEqual([contact(2)]);
    expect(mockTopics.some((t) => t.includes(contact(1)))).toBe(false);
    expect(res.delivered).toBe(1);
  });

  test('заблокированные не попадают в список рассылки', async () => {
    mockContacts = [1, 2, 3].map((n) => ({ peerPublicKey: contact(n) }));
    mockBlocked.add(contact(1));
    mockBlocked.add(contact(3));
    const res = await publishStory(PAIR, null, 'привет');
    expect(res.contacts).toBe(1);
  });

  test('все контакты заблокированы — это не сбой связи', async () => {
    mockContacts = [1, 2].map((n) => ({ peerPublicKey: contact(n) }));
    mockBlocked.add(contact(1));
    mockBlocked.add(contact(2));
    const res = await publishStory(PAIR, null, 'привет');
    expect(mockSent).toEqual([]);
    expect(res.contacts).toBe(0);
    expect(res.delivered).toBe(0);
    expect(storyPublishProblem(res, 'image')).toBeNull();
  });
});

describe('храповик: рассылка сторис', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'storyService.ts'), 'utf8') as string;
  const CODE = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  test('результат sendMessage проверяется, а не выбрасывается', () => {
    expect(CODE).not.toMatch(/await svc\.sendMessage\([^)]*\);\s*\n\s*delivered \+= 1;/);
    expect(CODE).toContain('await svc.sendMessage(c.peerPublicKey, text2))');
  });

  test('список рассылки отфильтрован по блок-листу', () => {
    expect(CODE).toContain('rateLimiter.isBlocked(c.peerPublicKey)');
    expect(CODE).toContain('await rateLimiter.whenReady()');
  });
});
