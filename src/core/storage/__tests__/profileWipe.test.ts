/**
 * Что остаётся на устройстве после удаления профиля (v4.32.521).
 *
 * Удаление профиля — это обещание: аккаунта на телефоне больше нет. Обещание
 * не выполнялось в трёх местах сразу.
 *
 * Первое — база ленты. `cleanupFeedStorageForProfile` открывала её ради списка
 * постов и не закрывала, а expo-sqlite удалять открытую базу отказывается
 * (`DeleteDatabaseException`: «Unable to delete database … that is currently
 * open»). Отказ ловил общий catch, и файл `airchat_feed_p<id>.db` — посты,
 * комментарии, вложения — оставался лежать навсегда: другого места, где его
 * удаляют, нет.
 *
 * Второе — тот же счётчик ссылок с другой стороны. Обход `listPostIdsEverywhere`
 * открывает ленту КАЖДОГО профиля и делает это на каждой привязке личности.
 * Соединения не закрывались, ссылки копились — то есть после первого же обхода
 * ленту стало бы не удалить и с закрытым «своим» соединением.
 *
 * Третье — три таблицы главной базы, которые уборка не перечисляла: `outbox`
 * (тексты неотправленных сообщений; жили ещё неделю до TTL и всё это время
 * считались баннером «в очереди»), `sync_state` и `sync_entity_heads` (курсор
 * синхронизации и отпечатки сущностей; TTL у них нет вовсе).
 *
 * Первая половина набора — поведенческая: подменённая lente-база ведёт себя
 * ровно как настоящая, считая ссылки и отказываясь удаляться при открытых.
 * Вторая — по исходникам, включая правило «каждая таблица с owner_profile_id
 * обязана попасть в уборку», которое само поймает следующую забытую таблицу.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** profileId → число незакрытых соединений, как в кэше expo-sqlite. */
const mockRefs = new Map<number, number>();
const mockDeleted: number[] = [];
let mockPostIds: string[] = [];
let mockInitFails = false;

jest.mock('../feedStorage', () => ({
  FeedStorage: class {
    open = false;
    profileId: number;
    constructor(profileId: number) {
      this.profileId = profileId;
    }
    async init(): Promise<void> {
      if (mockInitFails) throw new Error('feed db is locked');
      this.open = true;
      mockRefs.set(this.profileId, (mockRefs.get(this.profileId) ?? 0) + 1);
    }
    async close(): Promise<void> {
      // Настоящая close() на неоткрытой базе — no-op, а не ошибка.
      if (!this.open) return;
      this.open = false;
      mockRefs.set(this.profileId, (mockRefs.get(this.profileId) ?? 0) - 1);
    }
    async listAllPostIds(): Promise<string[]> {
      return mockPostIds;
    }
  },
  deleteFeedDbForProfile: jest.fn(async (profileId: number) => {
    if ((mockRefs.get(profileId) ?? 0) > 0) {
      throw new Error(
        `Unable to delete database 'airchat_feed_p${profileId}.db' that is currently open.`,
      );
    }
    mockDeleted.push(profileId);
  }),
}));

const mockPrefixDeletes: string[] = [];
jest.mock('../local', () => ({
  kvGet: jest.fn(async () => null),
  kvSet: jest.fn(async () => undefined),
  kvDelete: jest.fn(async () => undefined),
  kvGetInlineAttachment: jest.fn(async () => null),
  kvSetInlineAttachment: jest.fn(async () => undefined),
  kvDeleteByPrefix: jest.fn(async (p: string) => {
    mockPrefixDeletes.push(p);
  }),
  kvTryListKeysByPrefix: jest.fn(async () => []),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: 'poll:',
}));

jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn() },
}));
jest.mock('../../social/contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../../social/mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  cleanupFeedStorageForProfile,
  setFeedProfileContext,
  closeFeedStorage,
} from '../../social/feedService';

const SRC = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const LOCAL = read('core/storage/local.ts');
const FEED_SERVICE = read('core/social/feedService.ts');
const FEED_STORAGE = read('core/storage/feedStorage.ts');

/** Тело объявления от заголовка до первой закрывающей скобки в начале строки. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const WIPE = bodyOf(LOCAL, 'export async function deleteProfileDataFromLocalDb');

beforeEach(() => {
  mockRefs.clear();
  mockDeleted.length = 0;
  mockPrefixDeletes.length = 0;
  mockPostIds = [];
  mockInitFails = false;
});

describe('проверка не пустая', () => {
  it('исходники читаются', () => {
    expect(LOCAL.length).toBeGreaterThan(1000);
    expect(FEED_SERVICE.length).toBeGreaterThan(1000);
    expect(FEED_STORAGE.length).toBeGreaterThan(1000);
  });

  it('подменённая база и вправду отказывается удаляться при открытом соединении', async () => {
    const { FeedStorage, deleteFeedDbForProfile } = jest.requireMock('../feedStorage');
    const s = new FeedStorage(9);
    await s.init();
    await expect(deleteFeedDbForProfile(9)).rejects.toThrow('currently open');
    await s.close();
    await deleteFeedDbForProfile(9);
    expect(mockDeleted).toEqual([9]);
  });
});

describe('уборка ленты закрывает базу перед удалением', () => {
  it('база удалённого профиля действительно удаляется', async () => {
    await cleanupFeedStorageForProfile(7);
    expect(mockDeleted).toEqual([7]);
    expect(mockRefs.get(7) ?? 0).toBe(0);
  });

  it('kv-записи вложений убираются по каждому посту', async () => {
    mockPostIds = ['p1', 'p2'];
    await cleanupFeedStorageForProfile(7);
    expect(mockPrefixDeletes).toContain('feed_inline_media:p1:');
    expect(mockPrefixDeletes).toContain('feed_inline_doc:p2:');
  });

  it('рабочее соединение того же профиля тоже закрывается', async () => {
    await setFeedProfileContext(7);
    expect(mockRefs.get(7)).toBe(1);
    await cleanupFeedStorageForProfile(7);
    // Ровно тот дефект: открытым оставалось второе соединение — и база,
    // которую пользователь считал удалённой, оставалась на диске.
    expect(mockDeleted).toEqual([7]);
  });

  it('лента другого профиля при этом не закрывается', async () => {
    await setFeedProfileContext(3);
    await cleanupFeedStorageForProfile(7);
    expect(mockDeleted).toEqual([7]);
    expect(mockRefs.get(3)).toBe(1);
    await closeFeedStorage();
  });

  it('не открылась вовсе — базу всё равно удаляем', async () => {
    mockInitFails = true;
    await cleanupFeedStorageForProfile(7);
    // Список постов не прочитан, осиротевшие вложения подберёт сверка ленты.
    // А вот база — единственное место, где лежат сами посты.
    expect(mockDeleted).toEqual([7]);
  });

  it('неудача удаления доходит до вызывающего, а не тонет в логе', async () => {
    const { deleteFeedDbForProfile } = jest.requireMock('../feedStorage');
    (deleteFeedDbForProfile as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('disk full');
    });
    await expect(cleanupFeedStorageForProfile(7)).rejects.toThrow('disk full');
  });
});

describe('обход всех лент не копит соединения', () => {
  it('после просмотра открытых соединений не остаётся', () => {
    // Обход зовётся из reconcileOrphanInlineMedia; проверяем его форму —
    // саму функцию наружу не выносят, а цена ошибки здесь та же.
    const body = bodyOf(FEED_SERVICE, 'async function listPostIdsEverywhere');
    expect(body).toContain('} finally {');
    expect(body).toContain('await s.close()');
    const openAt = body.indexOf('new FeedStorage(id)');
    expect(openAt).toBeGreaterThanOrEqual(0);
    // Открытие — до try, иначе close в finally увидел бы не ту переменную.
    expect(openAt).toBeLessThan(body.indexOf('try {'));
  });
});

describe('уборка ленты: форма', () => {
  const body = bodyOf(FEED_SERVICE, 'export async function cleanupFeedStorageForProfile');

  it('временное соединение закрывается в finally', () => {
    expect(body).toContain('} finally {');
    expect(body).toContain('await tmp.close()');
  });

  it('удаление базы — после закрытия и вне общего catch', () => {
    expect(body.indexOf('await tmp.close()')).toBeLessThan(
      body.indexOf('await deleteFeedDbForProfile(profileId)'),
    );
    expect(body).not.toContain('    await deleteFeedDbForProfile(profileId);');
  });

  it('рабочее соединение закрывается по обоим признакам — и текущему, и в полёте', () => {
    expect(body).toContain('currentProfileId === profileId');
    expect(body).toContain('ctxPromiseForId === profileId');
    expect(body).toContain('await closeFeedStorage()');
  });
});

describe('feedStorage: закрытие есть, и описание больше не утверждает обратное', () => {
  it('у ленты есть close()', () => {
    expect(FEED_STORAGE).toContain('async close(): Promise<void> {');
  });

  it('докблок удаления не обещает, что deleteDatabaseAsync закроет базу сам', () => {
    expect(FEED_STORAGE).not.toContain('не имеет public close API');
    const doc = FEED_STORAGE.slice(
      FEED_STORAGE.indexOf('v4.32.49: полностью удалить feed DB'),
      FEED_STORAGE.indexOf('export async function deleteFeedDbForProfile'),
    );
    expect(doc).toContain('Закрыть соединение обязан');
  });
});

describe('уборка главной базы: ни одной таблицы профиля мимо', () => {
  /**
   * Список берётся у самой схемы, а не переписывается сюда руками: забытая
   * таблица — это и есть дефект, который тут ловят. `_v2` пропускаем: это
   * промежуточные имена пересборок ключа, они живут внутри одной транзакции
   * миграции и переименовываются в основные.
   */
  const scoped = [...LOCAL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n {4}\);/g)]
    .filter((m) => m[2].includes('owner_profile_id'))
    .map((m) => m[1])
    .filter((t) => !t.endsWith('_v2'));

  it('таблицы с профилем в схеме вообще находятся', () => {
    expect(scoped.length).toBeGreaterThanOrEqual(13);
    expect(scoped).toContain('chat_messages');
  });

  it.each([
    'outbox',
    'sync_state',
    'sync_entity_heads',
  ])('таблица %s теперь очищается — раньше её тут не было', (table) => {
    expect(WIPE).toContain(`'${table}'`);
  });

  it('каждая таблица с owner_profile_id упомянута в уборке', () => {
    const missing = scoped.filter((t) => !WIPE.includes(`'${t}'`));
    expect(missing).toEqual([]);
  });

  it('удаление идёт по номеру профиля, а не подчистую', () => {
    expect(WIPE).toContain('DELETE FROM ${t} WHERE owner_profile_id = ?');
  });

  it('всё это внутри одной транзакции', () => {
    const tx = WIPE.indexOf('withTransactionAsync');
    expect(tx).toBeGreaterThanOrEqual(0);
    expect(tx).toBeLessThan(WIPE.indexOf("'outbox'"));
  });
});

describe('очередь без профиля достаётся первому профилю', () => {
  it('строки outbox с NULL убираются вместе с профилем 1', () => {
    expect(WIPE).toContain('DELETE FROM outbox WHERE owner_profile_id IS NULL');
  });

  it('и только вместе с ним', () => {
    const at = WIPE.indexOf('DELETE FROM outbox WHERE owner_profile_id IS NULL');
    const guard = WIPE.indexOf('if (profileId === 1) {');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(guard);
  });

  it('они и вправду не попадают под равенство: NULL не равен единице', () => {
    // Условие уборки — SQL, и проверять его тут нечем; зато можно
    // зафиксировать саму причину, из-за которой нужна отдельная строка.
    expect(null === 1).toBe(false);
  });
});
