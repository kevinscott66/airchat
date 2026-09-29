/**
 * «Не сосчитали» приходило нулём — и полоска непрочитанного гасла (v4.32.1021).
 *
 * Дефект. `getUnreadFeedCount` накрывала чтение немым `catch { return 0 }`.
 * Ноль тут не ответ, а отсутствие ответа: полоска «N непрочитанных —
 * обновить» стоит под условием `unread > 0`, то есть ноль её снимает. Сам
 * счётчик в хранилище отказ не глотает — складывала два разных исхода в один
 * именно служба.
 *
 * Цена. Счёт идёт в конце `loadFeed` — на минутном тике и на каждом
 * обновлении, то есть в ту же занятую секунду, когда идёт разбор очереди и
 * запись просмотров. Один отказ гасит полоску, которая только что стояла с
 * живым числом, и следующего счёта не будет до следующего обновления ленты.
 * На экране это читается как «всё прочитано»: человек не пойдёт обновлять
 * то, о чём ему сказали, что нового там нет.
 *
 * Правка. Ответ `null` — «не сосчитали», — и экран на `null` оставляет
 * прежнее число: оно устарело на одно обращение, но не врёт про пустоту. Так
 * же, как кружку непрочитанных в шапке в v4.32.1013.
 *
 * Границы. Настоящий ноль остаётся нулём, и полоска с него снимается. Раз
 * «не сосчитали» больше не затирает число, обнуление при смене профиля
 * обязано быть явным — иначе в чужой ленте висело бы прежнее число; оно
 * уехало в тот же сброс, где с v4.32.47 чистится остальное чужое.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => true) },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));
jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: { whenReady: async () => {}, isBlocked: () => false },
}));

/** Сколько непрочитанного в базе. */
let mockUnread = 0;
/** Сколько ближайших счётов провалить. */
let mockCountFailures = 0;

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getUnreadCount(): Promise<number> {
      if (mockCountFailures > 0) {
        mockCountFailures -= 1;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return mockUnread;
    }
  },
}));

const mockKv = new Map<string, string>();

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvGetSecretCell: jest.fn(async () => ({ state: 'absent' })),
  kvSetSecret: jest.fn(async () => true),
  kvGetInlineAttachment: jest.fn(async () => null),
  kvTryGetInlineAttachment: jest.fn(async () => ({ value: null })),
  kvSetInlineAttachment: jest.fn(async () => true),
  kvTryListKeysByPrefix: jest.fn(async () => []),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => false,
  isPublicPostId: () => false,
  publicPostCopyExists: jest.fn(async () => false),
  putPublicPostCopy: jest.fn(async () => true),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import * as fs from 'fs';
import * as path from 'path';

import { getUnreadFeedCount, setFeedProfileContext } from '../feedService';

/** Только код: докблок пересказывает дефект и закрепку удовлетворять не должен. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const UI = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx');
const SCREEN = codeOnly(fs.readFileSync(UI, 'utf8'));
const STORAGE = codeOnly(
  fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'feedStorage.ts'), 'utf8')
);
const APP = codeOnly(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'App.tsx'), 'utf8'));

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockUnread = 0;
  mockCountFailures = 0;
});

describe('«не сосчитали» — это не ноль', () => {
  it('база занята — ответ не число', async () => {
    mockCountFailures = 1;

    await expect(getUnreadFeedCount()).resolves.toBeNull();
  });

  it('следующий счёт после отказа снова считает', async () => {
    mockCountFailures = 1;
    mockUnread = 12;

    await expect(getUnreadFeedCount()).resolves.toBeNull();
    await expect(getUnreadFeedCount()).resolves.toBe(12);
  });
});

describe('экран не принимает «не сосчитали» за ноль', () => {
  it('оба счёта ставят число только тогда, когда оно есть', () => {
    // Мест два: конец loadFeed и досчёт после пометки прочитанным.
    const guarded = SCREEN.match(/if \(\s*(?:freshUnread|n)\s*!== null\)|!== null && |&& n !== null/g) ?? [];
    expect(guarded.length).toBeGreaterThan(0);
    expect(SCREEN).not.toContain('setUnread(await getUnreadFeedCount())');
  });

  it('досчёт после пометки прочитанным тоже спрашивает про null', () => {
    const at = SCREEN.indexOf('void getUnreadFeedCount().then(');
    expect(at).toBeGreaterThan(0);
    expect(SCREEN.slice(at, at + 220)).toContain('null');
  });

  it('смена профиля обнуляет число явно — чужого в ленте не висит', () => {
    const at = SCREEN.indexOf('setOptimisticPosts([]);');
    expect(at).toBeGreaterThan(0);
    expect(SCREEN.slice(at, at + 400)).toContain('setUnread(0);');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('сосчитали — отдаём число', async () => {
    mockUnread = 7;

    await expect(getUnreadFeedCount()).resolves.toBe(7);
  });

  it('ГРАНИЦА: настоящий ноль остаётся нулём', async () => {
    await expect(getUnreadFeedCount()).resolves.toBe(0);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('полоска стоит под «больше нуля» — ноль её снимает', () => {
    expect(SCREEN).toContain('{unread > 0 ? (');
    expect(SCREEN).toContain('непрочитанных — обновить');
  });

  it('счётчик в хранилище отказ не глотает — складывала служба', () => {
    const at = STORAGE.indexOf('async getUnreadCount(): Promise<number> {');
    expect(at).toBeGreaterThan(0);
    const body = STORAGE.slice(at, at + 320);
    expect(body).toContain('FROM feed WHERE read = 0');
    expect(body).not.toContain('catch');
  });

  it('образец рядом: кружок в шапке уже отличает «не сосчитали»', () => {
    expect(APP).toContain('if (chat !== null) setChatUnread(chat);');
    expect(APP).toContain('if (groups !== null) setGroupUnread(groups);');
  });
});
