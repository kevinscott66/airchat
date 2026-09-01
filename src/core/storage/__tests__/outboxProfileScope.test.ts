/**
 * Очередь отправки принадлежит профилю, а не телефону (v4.32.522).
 *
 * Строки `outbox` несут `owner_profile_id` с v4.32.49, и разбор очереди чужие
 * конверты пропускает — но узнаёт он о них уже после того, как поднял их в
 * память и расшифровал. Три следствия, и все три чинятся в одном месте: в
 * самом запросе.
 *
 * Разбор. Очередь читается окнами, и число окон за один заход ограничено. Пока
 * чужие строки попадали в выборку, они занимали места в окне — и накопленная
 * неактивным аккаунтом очередь просто не давала дойти до конвертов активного.
 * Его сообщения не уходили вовсе, и чем длиннее была соседская очередь, тем
 * надёжнее.
 *
 * Счётчик. Баннер «В очереди на отправку: N» считал чужие строки, которые под
 * этим профилем не уйдут никогда. И не просто показывал неверное число: пока
 * оно больше нуля, OfflineStatus каждые шесть секунд запускает полную
 * синхронизацию — то есть второй профиль с непустой очередью означал вечный
 * фоновый опрос сети.
 *
 * Выталкивание. Потолок очереди общий (он про место на диске), а выталкивались
 * самые старые строки по всей таблице. Разошедшийся профиль стирал не
 * отправленные сообщения СОСЕДНЕГО аккаунта — беззвучно: отправитель давно
 * увидел «отправлено», кнопки повтора у него нет.
 *
 * Набор поведенческий: local.ts работает с подставной базой, а проверяется то,
 * какой запрос и с какими параметрами ушёл в SQLite.
 */
type Run = { sql: string; params: unknown[] };
const mockRuns: Run[] = [];
const mockQueries: Run[] = [];
/** Ответ на `SELECT COUNT(*) as n FROM outbox` — размер очереди при вставке. */
let mockQueueSize = 0;
/** Сколько строк «удалил» очередной DELETE. */
let mockDeleteChanges = 1;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      mockRuns.push({ sql, params });
      return { changes: sql.includes('DELETE') ? mockDeleteChanges : 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      mockQueries.push({ sql, params });
      return [];
    }),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      mockQueries.push({ sql, params });
      if (sql.includes('FROM outbox')) return { n: mockQueueSize };
      return null;
    }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
  encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
  decryptAtRestString: jest.fn((v: string) => v.replace('enc2:', '')),
  decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : v.replace('enc2:', ''))),
  isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { outboxCount, outboxDrain, outboxEnqueue, OUTBOX_DRAIN_LIMIT } from '../local';

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');
const SYNC = read('core/storage/sync.ts');
const BANNER = read('ui/components/OfflineStatus.tsx');

/** Последний запрос к таблице очереди — тот, что нас интересует. */
function lastOutboxQuery(): Run {
  const q = [...mockQueries].reverse().find((r) => r.sql.includes('FROM outbox'));
  if (!q) throw new Error('запроса к outbox не было');
  return q;
}
function outboxDeletes(): Run[] {
  return mockRuns.filter((r) => r.sql.includes('DELETE FROM outbox'));
}

beforeEach(() => {
  mockRuns.length = 0;
  mockQueries.length = 0;
  mockQueueSize = 0;
  mockDeleteChanges = 1;
});

describe('проверка не пустая', () => {
  it('подставная база и вправду получает запросы', async () => {
    await outboxCount(null);
    expect(lastOutboxQuery().sql).toContain('COUNT(*)');
  });

  it('исходники читаются', () => {
    expect(SYNC.length).toBeGreaterThan(1000);
    expect(BANNER.length).toBeGreaterThan(500);
  });
});

describe('разбор очереди: чужие строки не доходят до расшифровки', () => {
  it('запрос сужен по профилю, и номер уходит параметром', async () => {
    await outboxDrain(OUTBOX_DRAIN_LIMIT, 0, 2);
    const q = lastOutboxQuery();
    expect(q.sql).toContain('owner_profile_id = ?');
    // Порядок параметров — часть смысла: попытки, профиль, окно, сдвиг.
    expect(q.params).toEqual([20, 2, OUTBOX_DRAIN_LIMIT, 0]);
  });

  it('строки без профиля остаются своими: они писались, когда профиль был один', async () => {
    await outboxDrain(OUTBOX_DRAIN_LIMIT, 0, 2);
    expect(lastOutboxQuery().sql).toContain('owner_profile_id IS NULL');
  });

  it('профилей ещё нет — выбирается всё, как раньше', async () => {
    await outboxDrain(OUTBOX_DRAIN_LIMIT, 0, null);
    const q = lastOutboxQuery();
    expect(q.sql).not.toContain('owner_profile_id = ?');
    expect(q.params).toEqual([20, OUTBOX_DRAIN_LIMIT, 0]);
  });

  it('окно и сдвиг по-прежнему в запросе, а не в памяти', async () => {
    await outboxDrain(50, 100, 2);
    const q = lastOutboxQuery();
    expect(q.sql).toContain('LIMIT ? OFFSET ?');
    expect(q.params).toEqual([20, 2, 50, 100]);
  });

  it('мусор в окне не превращается в выборку без потолка', async () => {
    await outboxDrain(Number.NaN, -5, 2);
    expect(lastOutboxQuery().params).toEqual([20, 2, OUTBOX_DRAIN_LIMIT, 0]);
  });

  it('исчерпавшие попытки по-прежнему не выдаются', async () => {
    await outboxDrain(OUTBOX_DRAIN_LIMIT, 0, 2);
    expect(lastOutboxQuery().sql).toContain('COALESCE(attempts, 0) < ?');
  });
});

describe('счётчик очереди: баннер про свой профиль', () => {
  it('считает только свои строки', async () => {
    await outboxCount(3);
    const q = lastOutboxQuery();
    expect(q.sql).toContain('owner_profile_id = ?');
    expect(q.params).toEqual([20, 3]);
  });

  it('без профиля считает всё', async () => {
    await outboxCount(null);
    expect(lastOutboxQuery().params).toEqual([20]);
  });

  it('мёртвые строки по-прежнему не в счёт', async () => {
    await outboxCount(3);
    expect(lastOutboxQuery().sql).toContain('COALESCE(attempts, 0) < ?');
  });
});

describe('выталкивание: профиль ест собственную очередь', () => {
  it('под потолком не выталкивается ничего', async () => {
    mockQueueSize = 10;
    expect(await outboxEnqueue('dm', 'привет', 0, 2)).toBe(true);
    expect(outboxDeletes()).toEqual([]);
  });

  it('на потолке уходят самые старые строки ТОГО ЖЕ профиля', async () => {
    mockQueueSize = 10_000;
    await outboxEnqueue('dm', 'привет', 0, 2);
    const dels = outboxDeletes();
    expect(dels.length).toBe(1);
    expect(dels[0].sql).toContain('owner_profile_id IS ?');
    expect(dels[0].params).toEqual([2, 1]);
  });

  it('своих строк не нашлось — потолок всё равно соблюдается', async () => {
    mockQueueSize = 10_000;
    mockDeleteChanges = 0;
    await outboxEnqueue('dm', 'привет', 0, 2);
    const dels = outboxDeletes();
    // Второй заход — уже по всей таблице: беззвучная потеря чужого конверта
    // плоха, переполненный диск хуже.
    expect(dels.length).toBe(2);
    expect(dels[1].sql).not.toContain('owner_profile_id');
    expect(dels[1].params).toEqual([1]);
  });

  it('свои строки нашлись — чужие не трогаются', async () => {
    mockQueueSize = 10_005;
    mockDeleteChanges = 6;
    await outboxEnqueue('dm', 'привет', 0, 2);
    expect(outboxDeletes().length).toBe(1);
  });

  it('строки без профиля выталкиваются вместе со своими: IS, а не =', async () => {
    mockQueueSize = 10_000;
    await outboxEnqueue('dm', 'привет', 0, null);
    const dels = outboxDeletes();
    expect(dels[0].sql).toContain('owner_profile_id IS ?');
    expect(dels[0].params).toEqual([null, 1]);
  });

  it('конверт всё равно кладётся в очередь', async () => {
    mockQueueSize = 10_000;
    expect(await outboxEnqueue('dm', 'привет', 0, 2)).toBe(true);
    expect(mockRuns.some((r) => r.sql.includes('INSERT INTO outbox'))).toBe(true);
  });
});

describe('вызывающие стороны передают профиль', () => {
  it('разбор очереди зовётся с активным профилем', () => {
    expect(SYNC).toContain('outboxDrain(OUTBOX_DRAIN_LIMIT, offset, activePid)');
  });

  it('проверка чужого профиля остаётся вторым рубежом', () => {
    // Запрос её теперь опережает, но убирать нельзя: вызов без профиля
    // отправлял бы чужие конверты нашим ключом, и это не видно ниоткуда.
    expect(SYNC).toContain('item.ownerProfileId !== activePid');
  });

  it('баннер спрашивает профиль на каждом подсчёте', () => {
    expect(BANNER).toContain('outboxCount(profileManager.getActiveProfile()?.id ?? null)');
  });

  it('мёртвой обёртки, которая считала очередь без профиля, больше нет', () => {
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'transport', 'offlineRouter.ts')))
      .toBe(false);
  });
});
