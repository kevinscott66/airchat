/**
 * Отказ базы подменялся пустым списком просмотров (v4.32.1020).
 *
 * Дефект. `listFeedPostViewers` накрывала чтение немым `catch { return [] }`.
 * Экран этого ждать не мог: в v4.32.881 у модалки «Просмотры» завели
 * отдельную ветку отказа — «Не удалось прочитать список» с повтором по
 * нажатию, — и она ловит бросок. Броска не было ни одного: служба отвечала
 * пустым списком на любой отказ, и ветка отказа была мёртвым кодом с самого
 * дня, когда её написали.
 *
 * Цена. Человек читает «Пока никто не просмотрел» — вывод о чужом поведении
 * там, где база просто не ответила. Повторить нечем: экран считает, что
 * прочитал. В журнал не попадало ничего — `catch` был пуст даже от записи.
 * Модалка открывается чаще всего сразу после публикации, в занятую секунду:
 * идёт рассылка, разбор очереди, запись просмотров — то есть именно тогда,
 * когда SQLite и отвечает «занято». Тот же немой ответ приходил и до
 * привязки профиля (`feed_storage_profile_unset`).
 *
 * Правка. Служба отказ не ловит — как соседние `getFeedComments` и
 * `getFeedCommentCounts` в этом же файле. Дальше его разбирает экран: пишет в
 * журнал и показывает свою ветку с повтором.
 *
 * Границы. Настоящий пустой список остаётся пустым: «никто не просмотрел» —
 * законный ответ, и модалка показывает его по-прежнему. Хранилище здесь
 * подменено: проверяется служба, а не SQLite.
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

type Viewer = { viewerDid: string; viewerName: string | null; viewedAt: number };

/** Чем отвечает база на чтение просмотров — подменяется в каждой проверке. */
let mockViewers: Viewer[] = [];
/** Сколько ближайших чтений провалить. */
let mockViewerFailures = 0;
/** Сколько раз база ответила (успехом или отказом). */
let mockViewerReads = 0;

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getViewers(): Promise<Viewer[]> {
      mockViewerReads += 1;
      if (mockViewerFailures > 0) {
        mockViewerFailures -= 1;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return mockViewers;
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

import { listFeedPostViewers, setFeedProfileContext } from '../feedService';

/** Только код: докблок пересказывает дефект и закрепку удовлетворять не должен. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SERVICE = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8'));
const SCREEN = codeOnly(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'), 'utf8')
);

beforeAll(async () => { await setFeedProfileContext(1); });

beforeEach(() => {
  mockViewers = [];
  mockViewerFailures = 0;
  mockViewerReads = 0;
});

describe('отказ базы доходит до экрана', () => {
  it('база занята — это не «никто не просмотрел»', async () => {
    mockViewerFailures = 1;

    await expect(listFeedPostViewers('p-1')).rejects.toThrow('database is locked');
  });

  it('повтор из модалки читает заново — и дочитывает', async () => {
    // Ветка отказа в модалке — кнопка: по нажатию она зовёт openViewers тем же
    // постом. Без броска первого чтения нажимать было не на что.
    mockViewerFailures = 1;
    mockViewers = [{ viewerDid: 'did:key:z1', viewerName: 'Аня', viewedAt: 10 }];

    await expect(listFeedPostViewers('p-1')).rejects.toThrow('database is locked');
    await expect(listFeedPostViewers('p-1')).resolves.toEqual([
      { viewerDid: 'did:key:z1', viewerName: 'Аня', viewedAt: 10 },
    ]);
    expect(mockViewerReads).toBe(2);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('список читается и отдаётся как есть', async () => {
    mockViewers = [
      { viewerDid: 'did:key:z1', viewerName: 'Аня', viewedAt: 10 },
      { viewerDid: 'did:key:z2', viewerName: null, viewedAt: 20 },
    ];

    await expect(listFeedPostViewers('p-1')).resolves.toHaveLength(2);
  });

  it('ГРАНИЦА: настоящая пустота остаётся пустотой', async () => {
    // «Никто не просмотрел» — законный ответ, и модалка показывает его
    // отдельной веткой. Правка не имеет права превращать его в отказ.
    await expect(listFeedPostViewers('p-1')).resolves.toEqual([]);
    expect(mockViewerReads).toBe(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('экран ждёт бросок: у него своя ветка отказа с повтором', () => {
    const start = SCREEN.indexOf('const openViewers = useCallback');
    const end = SCREEN.indexOf('const closeViewers', start);
    expect(start).toBeGreaterThan(0);
    const body = SCREEN.slice(start, end);
    expect(body).toContain('} catch (e) {');
    expect(body).toContain("log.warn('feed_viewers_load_failed'");
    expect(body).toContain('setViewersFailed(true)');
    expect(SCREEN).toContain('viewersFailed ? (');
  });

  it('ветка отказа стоит раньше «никто не просмотрел» — иначе её не видно', () => {
    const failed = SCREEN.indexOf('viewersFailed ? (');
    const empty = SCREEN.indexOf('viewersList.length === 0 ? (');
    expect(failed).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(failed);
  });

  it('образец рядом: соседние чтения ленты отказ не ловят', () => {
    for (const head of [
      'export async function getFeedComments(postId: string): Promise<FeedCommentRow[]> {',
      'export async function getFeedCommentCounts(postIds: string[]): Promise<Record<string, number>> {',
    ]) {
      const at = SERVICE.indexOf(head);
      expect(at).toBeGreaterThan(0);
      expect(SERVICE.slice(at, at + 200)).toContain('const s = await ensureStorage();');
      expect(SERVICE.slice(at, at + 200)).not.toContain('catch');
    }
  });
});
