/**
 * Заявка на вступление не будила экран (v4.32.1006).
 *
 * Дефект. Счётчик ждущих заявок читался ровно один раз — при монтировании
 * экрана группы, и больше никогда (`useEffect(..., [amAdmin, group.id, pid])`).
 * Заявка, пришедшая пока администратор сидит в этой самой группе, не оставляла
 * на экране ни следа: метка на кнопке участников нарисована по «счётчик больше
 * нуля», а нуль так и оставался нулём до ухода с экрана и возврата. То же и в
 * открытом окне «Запросы на вступление»: список читается при входе на экран
 * участников, и новая заявка в нём не появлялась вовсе.
 *
 * Цена. Ни уведомления, ни строки в истории у заявки нет — метка единственный
 * признак того, что кто-то стоит у двери. Заявитель при этом получает «заявка
 * ждёт одобрения» (v4.32.266) и молча ждёт. Ровно та беда, которую v4.32.1003
 * назвала для НЕЧИТАЕМОГО списка; разница в том, что там база не отдала
 * строку, а здесь строка записана и лежит рядом — и всё равно невидима.
 *
 * Правка. Запись заявки и ответ на неё будят тот же сигнал, которым в приложении
 * расходятся все прочие записи вне `chat_messages` (`notifyChatStorageChanged`),
 * а оба экрана на него пересчитывают. Отдельной подписки ради одного счётчика
 * нет намеренно: второе такое место — это второе место, где о нём забудут.
 *
 * Границы. Ответ, не изменивший ни одной строки (`changes === 0` — ответил
 * другой администратор), не будит никого: будить там нечего, а лишний сигнал
 * тянет за собой перечитывание списка переписок и запись резервной копии.
 */
let mockChanges = 1;
/** Строка ждущей заявки, если она уже есть; null — заявка новая. */
let mockExisting: { id: string } | null = null;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: mockChanges, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => mockExisting),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('uuid', () => ({ v4: () => 'req-uuid' }));

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

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  insertGroupJoinRequest,
  notifyChatStorageChanged,
  subscribeChatWrites,
  updateGroupJoinRequestStatus,
} from '../local';

const SCREEN = readFileSync(
  join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
  'utf8'
);

/** Сигнал схлопнут микро-задержкой в 100 мс — ждём чуть дольше. */
const WOKE_MS = 160;

/** Сколько раз экран разбудили за этот отрезок. */
async function wakeups(act: () => Promise<unknown>): Promise<number> {
  let n = 0;
  const off = subscribeChatWrites(() => { n += 1; });
  try {
    await act();
    await new Promise((r) => setTimeout(r, WOKE_MS));
  } finally {
    off();
  }
  return n;
}

beforeEach(() => {
  mockChanges = 1;
  mockExisting = null;
});

describe('заявка будит экран', () => {
  it('новая заявка — сигнал ушёл', async () => {
    expect(await wakeups(() => insertGroupJoinRequest('g1', 'PUB', 'Аня', 'пустите', 1))).toBe(1);
  });

  it('повторное открытие ссылки — тоже: имя и сопроводительный текст новые', async () => {
    mockExisting = { id: 'r1' };

    expect(await wakeups(() => insertGroupJoinRequest('g1', 'PUB', 'Аня Б.', 'это снова я', 1))).toBe(1);
  });

  it('ответ на заявку убирает её из ждущих — сигнал ушёл и тут', async () => {
    expect(await wakeups(() => updateGroupJoinRequestStatus('r1', 'approved'))).toBe(1);
  });
});

describe('ГРАНИЦА: будить нечего — не будим', () => {
  it('ответил другой администратор (ни одной строки) — сигнала нет', async () => {
    mockChanges = 0;

    expect(await wakeups(() => updateGroupJoinRequestStatus('r1', 'rejected'))).toBe(0);
  });
});

describe('оба экрана пересчитывают по сигналу', () => {
  it('метка в чате — своим именем, и оно же зовётся из подписки', () => {
    expect(SCREEN).toContain('const reloadPendingJoin = useCallback(async () => {');
    const sub = SCREEN.indexOf('const unsub = subscribeChatWrites(() => {');
    expect(sub).toBeGreaterThan(-1);
    expect(SCREEN.slice(sub, SCREEN.indexOf('return unsub;', sub))).toContain('void reloadPendingJoin();');
  });

  it('список заявок на экране участников — тоже по сигналу', () => {
    expect(SCREEN).toContain('useEffect(() => subscribeChatWrites(() => { void loadJoinRequests(); }), [loadJoinRequests]);');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: сам сигнал работает', () => {
  it('подписчик слышит запись вне chat_messages', async () => {
    expect(await wakeups(async () => { notifyChatStorageChanged(); })).toBe(1);
  });

  it('отписавшийся не слышит ничего', async () => {
    let n = 0;
    const off = subscribeChatWrites(() => { n += 1; });
    off();
    notifyChatStorageChanged();
    await new Promise((r) => setTimeout(r, WOKE_MS));

    expect(n).toBe(0);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('метка по-прежнему нарисована по «больше нуля»: нуль значит пусто', () => {
    // Не будь этого условия, устаревший счётчик показывал бы хотя бы ноль —
    // а так он не показывает ничего, и заявка пропадает с экрана целиком.
    expect(SCREEN).toContain('{amAdmin && (pendingJoinUnknown || pendingJoinCount > 0) ? (');
  });

  it('второго пути узнать о заявке нет: ни уведомления, ни строки в истории', () => {
    const messaging = readFileSync(
      join(__dirname, '..', '..', 'social', 'groupMessaging.ts'),
      'utf8'
    );
    const at = messaging.indexOf('const queued = await insertGroupJoinRequest(');
    expect(at).toBeGreaterThan(-1);
    const around = messaging.slice(at, at + 600);
    expect(around).not.toContain('insertGroupSysMessage');
    expect(around).not.toContain('scheduleNotificationAsync');
  });
});
