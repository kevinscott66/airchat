/**
 * «Сколько посмотрело» отвечало нулём, когда база не ответила (v4.32.1022).
 *
 * Дефект. `getFeedPostViewCountsMap` накрывала чтение немым `catch { return {} }`.
 * Пустая карта для экрана неотличима от «ни один пост не смотрели»: число
 * берётся как `viewCounts[id] ?? 0`. На удачном чтении такое отсутствие
 * законно — SQL группирует, и строки для поста без просмотров просто нет, —
 * а на отказе оно значит «не прочитали». Два разных ответа приходили одним.
 *
 * Цена. Счётчик стоит под своими постами, и в нём число людей. Ноль там —
 * утверждение о чужом поведении: «никто не открыл». Читается оно
 * однозначно — человек решает, что публикация не дошла. Карта читается в
 * конце `loadFeed` и на подгрузке страницы, то есть в ту же занятую секунду,
 * когда идёт разбор очереди и запись просмотров. Первый счёт после запуска и
 * первый после смены профиля идут по пустой карте: там отказ виден сразу
 * всеми своими постами разом, а повторить нечего — счёт придёт только со
 * следующим обновлением ленты.
 *
 * Правка. Служба отвечает `null` на отказ, а на удачном чтении проставляет
 * ноль каждому спрошенному посту явно. После этого отсутствие ключа значит
 * ровно одно — «не знаем», — и экран рисует на нём знак вопроса со словами,
 * как это с v4.32.948 делает счётчик под своей историей.
 *
 * Границы. Настоящий ноль остаётся нулём и показывается цифрой: «никто не
 * открыл» — законный ответ, если его действительно прочитали. Прежде
 * известные числа отказ не затирает: карта сливается по строкам, и без
 * свежего значения остаётся прежнее.
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

/** Что база знает о просмотрах: только посты, которые кто-то открывал. */
let mockCounts: Record<string, number> = {};
/** Сколько ближайших чтений провалить. */
let mockCountFailures = 0;
/** О чём спросили базу в последний раз. */
let mockAsked: string[] = [];

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getViewCountsForPosts(postIds: string[]): Promise<Record<string, number>> {
      mockAsked = postIds;
      if (mockCountFailures > 0) {
        mockCountFailures -= 1;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      // Как в хранилище: GROUP BY не даёт строки посту без просмотров.
      const out: Record<string, number> = {};
      for (const id of postIds) if (mockCounts[id] !== undefined) out[id] = mockCounts[id];
      return out;
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

import { getFeedPostViewCountsMap, setFeedProfileContext } from '../feedService';

/** Только код: докблок пересказывает дефект и закрепку удовлетворять не должен. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => codeOnly(fs.readFileSync(path.join(SRC, ...p), 'utf8'));
const SCREEN = read('ui', 'screens', 'FeedScreen.tsx');

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockCounts = {};
  mockCountFailures = 0;
  mockAsked = [];
});

describe('«не прочитали» — это не «никто не открыл»', () => {
  it('база занята — ответ не карта', async () => {
    mockCountFailures = 1;

    await expect(getFeedPostViewCountsMap(['p1', 'p2'])).resolves.toBeNull();
  });

  it('прочитали — у каждого спрошенного поста есть ответ, в том числе нулевой', async () => {
    mockCounts = { p1: 3 };

    await expect(getFeedPostViewCountsMap(['p1', 'p2'])).resolves.toEqual({ p1: 3, p2: 0 });
  });

  it('следующее чтение после отказа снова считает', async () => {
    mockCountFailures = 1;
    mockCounts = { p1: 5 };

    await expect(getFeedPostViewCountsMap(['p1'])).resolves.toBeNull();
    await expect(getFeedPostViewCountsMap(['p1'])).resolves.toEqual({ p1: 5 });
  });
});

describe('экран не выдаёт незнание за ноль', () => {
  it('под своим постом рисуется знак вопроса, и он назван словами', () => {
    expect(SCREEN).toContain("viewCount === null ? '?' : viewCount");
    expect(SCREEN).toContain('a11yViewsUnknown');
  });

  it('оба загрузчика спрашивают, прочиталось ли', () => {
    // Загрузчика два: конец loadFeed и подгрузка следующей страницы.
    const asks = SCREEN.match(/vc !== null/g) ?? [];
    expect(asks).toHaveLength(2);
  });

  it('«неизвестно» у счётчика — своё число, а не отсутствующий ключ', () => {
    expect(SCREEN).toContain('viewCount={viewCounts[item.id] ?? null}');
    expect(SCREEN).not.toContain('viewCount={viewCounts[item.id] ?? 0}');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('числа доходят как есть', async () => {
    mockCounts = { p1: 12, p2: 1 };

    await expect(getFeedPostViewCountsMap(['p1', 'p2'])).resolves.toEqual({ p1: 12, p2: 1 });
  });

  it('ГРАНИЦА: пустой список — база не тревожится', async () => {
    await expect(getFeedPostViewCountsMap([])).resolves.toEqual({});
    expect(mockAsked).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('хранилище группирует — посту без просмотров строки нет', () => {
    const storage = read('core', 'storage', 'feedStorage.ts');
    const at = storage.indexOf('async getViewCountsForPosts(');
    expect(at).toBeGreaterThan(0);
    const body = storage.slice(at, at + 600);
    expect(body).toContain('GROUP BY post_id');
    expect(body).not.toContain('catch');
  });

  it('без свежего значения в карте остаётся прежнее — отказ ничего не затирает', () => {
    expect(read('core', 'storage', 'listHeadMerge.ts')).toContain(
      "else if (Object.prototype.hasOwnProperty.call(prev, id)) out[id] = prev[id];",
    );
  });

  it('счётчик стоит только под своим постом — цифра говорит о чужих людях', () => {
    const at = SCREEN.indexOf('onPress={() => onViewersPress(item.id)}');
    expect(at).toBeGreaterThan(0);
    expect(SCREEN.slice(at - 400, at)).toContain('{isSelf ? (');
  });

  it('образец рядом: под своей историей незнание давно нарисовано знаком вопроса', () => {
    const stories = read('ui', 'components', 'StoriesRow.tsx');
    expect(stories).toContain('accessibilityLabel="Сколько человек посмотрело — неизвестно"');
  });
});
