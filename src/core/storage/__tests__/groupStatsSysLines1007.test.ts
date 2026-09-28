/**
 * Сводка группы считала служебные строки сообщениями (v4.32.1007).
 *
 * Дефект. Служебные строки лежат в `group_messages` рядом с сообщениями и
 * отличаются одним префиксом в тексте. `getGroupStats` считал всё подряд:
 * «Сообщение закреплено», «Группа переименована», «X вступил(а) в группу»,
 * «создал(а) группу» попадали и в плитку «Сообщений», и в столбики
 * «Активность за 7 дней», и в список «Самые активные».
 *
 * Цена. Служебные строки пишет тот, кто распоряжается группой, и пишет их
 * много. Наверх «Самых активных» поднимался администратор, не написавший в
 * группу ни слова: сводка отвечала на вопрос «кто больше всех говорит»
 * списком тех, кто больше всех нажимал кнопки. У строк из управляющего
 * конверта ключа отправителя нет вовсе — в пятёрку они вставали безымянной
 * строкой, подписанной сокращением пустого ключа. «Первое сообщение»
 * показывало день создания группы, потому что строку «создал(а) группу»
 * кладут на миллисекунду раньше первого приветствия.
 *
 * Правка. Отличить служебную строку можно только по тексту, а текст лежит
 * шифртекстом. Расшифровывать всю историю ради счётчика не нужно: у
 * служебной строки `sender_name` всегда `null`, поэтому разбирать текст
 * приходится только безымянным строкам.
 *
 * Границы. Безымянная строка, чей текст не открылся, считается обычным
 * сообщением: служебная ли она, знать нечем, а спрятать чужое сообщение
 * хуже, чем показать лишнюю единицу.
 *
 * База здесь поддельная, но запросы она разбирает по-настоящему: и условие
 * `sender_name IS NOT NULL`, и `LIMIT 5` читаются из самого текста запроса,
 * поэтому прежняя редакция получает ровно то, что получала от SQLite.
 */
type Row = {
  sender_pub_b64: string;
  sender_name: string | null;
  text: string;
  media_cids: string | null;
  created_at: number;
};

let mockRows: Row[] = [];

/** Ключ дня ровно так, как его строит strftime(..., 'unixepoch'): сутки по UTC. */
function mockUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

jest.mock('expo-sqlite', () => {
  const named = () => mockRows.filter((r) => r.sender_name !== null);
  const pick = (sql: string) => (sql.includes('sender_name IS NOT NULL') ? named() : mockRows);
  return {
    openDatabaseAsync: jest.fn(async () => ({
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
      withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
      closeAsync: jest.fn(async () => undefined),
      getFirstAsync: jest.fn(async (sql: string) => {
        if (!sql.includes('first_at')) return null;
        const rs = pick(sql);
        return {
          total: rs.length,
          media: rs.filter((r) => r.media_cids !== null).length,
          first_at: rs.length ? Math.min(...rs.map((r) => r.created_at)) : null,
        };
      }),
      getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('MAX(sender_name)')) {
          const by = new Map<string, { sender_pub_b64: string; sender_name: string | null; cnt: number }>();
          for (const r of pick(sql)) {
            const cur = by.get(r.sender_pub_b64) ?? { sender_pub_b64: r.sender_pub_b64, sender_name: null, cnt: 0 };
            cur.cnt += 1;
            if (r.sender_name !== null && (cur.sender_name === null || r.sender_name > cur.sender_name)) {
              cur.sender_name = r.sender_name;
            }
            by.set(r.sender_pub_b64, cur);
          }
          const out = [...by.values()].sort((a, b) => b.cnt - a.cnt);
          return sql.includes('LIMIT 5') ? out.slice(0, 5) : out;
        }
        if (sql.includes('strftime')) {
          const since = Number(params[2] ?? 0);
          const days = new Map<string, number>();
          for (const r of pick(sql)) {
            if (r.created_at < since) continue;
            const d = mockUtcDay(r.created_at);
            days.set(d, (days.get(d) ?? 0) + 1);
          }
          return [...days.entries()].sort().map(([day, cnt]) => ({ day, cnt }));
        }
        if (sql.includes('sender_name IS NULL')) {
          return mockRows.filter((r) => r.sender_name === null);
        }
        return [];
      }),
    })),
    deleteDatabaseAsync: jest.fn(async () => undefined),
  };
});

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

/** Шифрование настоящее — подменён только ключ, чтобы не ходить в хранилище. */
jest.mock('../localEncryption', () => {
  const actual = jest.requireActual('../localEncryption');
  return { ...actual, getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32).fill(7)) };
});

import { readFileSync } from 'fs';
import { join } from 'path';

import { GROUP_SYS_PREFIX } from '../../social/groupSysLine';
import { getGroupStats } from '../local';
import { AT_REST_PREFIX, encryptAtRestString } from '../localEncryption';

const DEK = new Uint8Array(32).fill(7);
const enc = (v: string) => encryptAtRestString(v, DEK);

/** Полдень по местному времени: в этот час местные сутки и сутки UTC совпадают. */
function noonAgo(days: number): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime() - days * 24 * 3600 * 1000;
}

/** Обычное сообщение: имя отправителя есть всегда. */
function said(pub: string, name: string, at: number, media: string | null = null): Row {
  return { sender_pub_b64: pub, sender_name: enc(name), text: enc('привет'), media_cids: media, created_at: at };
}

/** Своя служебная строка: имени нет, текст с префиксом (см. insertGroupSysMessage). */
function sys(pub: string, event: string, at: number): Row {
  return { sender_pub_b64: pub, sender_name: null, text: enc(GROUP_SYS_PREFIX + event), media_cids: null, created_at: at };
}

beforeEach(() => {
  mockRows = [];
});

describe('служебные строки в счёт не идут', () => {
  beforeEach(() => {
    mockRows = [
      // Группу завели вчера — строка «создал(а) группу» стоит раньше всех.
      sys('A', 'Аня создал(а) группу «Двор»', noonAgo(2) - 1),
      said('B', 'Боря', noonAgo(1)),
      said('B', 'Боря', noonAgo(1) + 1),
      said('B', 'Боря', noonAgo(1) + 2),
      said('B', 'Боря', noonAgo(1) + 3),
      said('A', 'Аня', noonAgo(2)),
      said('A', 'Аня', noonAgo(2) + 1),
      said('A', 'Аня', noonAgo(2) + 2),
      // Администратор наводил порядок: шесть нажатий кнопок.
      sys('A', 'Сообщение закреплено', noonAgo(1)),
      sys('A', 'Сообщение откреплено', noonAgo(1)),
      sys('A', 'Группа переименована в «Двор»', noonAgo(1)),
      sys('A', 'Пригласительная ссылка сброшена: прежние больше не действуют', noonAgo(1)),
      sys('A', 'Аватар группы обновлён', noonAgo(1)),
      sys('A', 'Борис исключён(а) из группы', noonAgo(1)),
      // Строка из управляющего конверта: ключа отправителя у неё нет.
      sys('', 'Вера вступил(а) в группу', noonAgo(1)),
    ];
  });

  it('в плитке «Сообщений» — только сообщения', async () => {
    expect((await getGroupStats('g1', 1)).totalMessages).toBe(7);
  });

  it('«Первое сообщение» — первое сообщение, а не день создания группы', async () => {
    expect((await getGroupStats('g1', 1)).firstMessageAt).toBe(noonAgo(2));
  });

  it('самый активный — тот, кто больше писал, а не тот, кто больше нажимал', async () => {
    const top = (await getGroupStats('g1', 1)).topSenders;
    expect(top.map((s) => [s.pub, s.count])).toEqual([
      ['B', 4],
      ['A', 3],
    ]);
  });

  it('строка без ключа отправителя в пятёрку не встаёт', async () => {
    const top = (await getGroupStats('g1', 1)).topSenders;
    expect(top.some((s) => s.pub === '')).toBe(false);
  });

  it('столбики за 7 дней служебных строк не показывают', async () => {
    mockRows = mockRows.filter((r) => r.sender_name === null);
    const daily = (await getGroupStats('g1', 1)).dailyActivity;
    expect(daily.reduce((a, d) => a + d.count, 0)).toBe(0);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычные сообщения считаются как считались', () => {
  it('переписка без единой служебной строки сходится по всем числам', async () => {
    mockRows = [
      said('A', 'Аня', noonAgo(1), 'cid1'),
      said('A', 'Аня', noonAgo(1) + 1),
      said('B', 'Боря', noonAgo(1) + 2),
    ];
    const s = await getGroupStats('g1', 1);

    expect(s.totalMessages).toBe(3);
    expect(s.mediaCount).toBe(1);
    expect(s.firstMessageAt).toBe(noonAgo(1));
    expect(s.topSenders.map((x) => [x.pub, x.name, x.count])).toEqual([
      ['A', 'Аня', 2],
      ['B', 'Боря', 1],
    ]);
  });

  it('пустая группа — все нули, а не отказ', async () => {
    const s = await getGroupStats('g1', 1);

    expect(s).toEqual({
      totalMessages: 0,
      mediaCount: 0,
      firstMessageAt: null,
      topSenders: [],
      dailyActivity: expect.any(Array),
    });
  });
});

describe('ГРАНИЦА: безымянная строка — ещё не служебная', () => {
  it('обычное сообщение без имени отправителя из счёта не пропадает', async () => {
    mockRows = [
      { sender_pub_b64: 'C', sender_name: null, text: enc('привет'), media_cids: null, created_at: noonAgo(1) },
    ];
    const s = await getGroupStats('g1', 1);

    expect(s.totalMessages).toBe(1);
    expect(s.topSenders).toEqual([{ name: null, pub: 'C', unreadable: false, count: 1 }]);
  });

  it('не открывшийся текст считается сообщением: служебная ли строка — неизвестно', async () => {
    mockRows = [
      { sender_pub_b64: 'C', sender_name: null, text: `${AT_REST_PREFIX}порча`, media_cids: null, created_at: noonAgo(1) },
    ];

    expect((await getGroupStats('g1', 1)).totalMessages).toBe(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf8');

  it('служебную строку по-прежнему кладут без имени отправителя', () => {
    // На этом и держится отбор: будь у служебной строки имя, разбирать
    // пришлось бы текст каждого сообщения группы.
    expect(src('..', 'ui', 'utils', 'groupSysMessage.ts')).toContain('senderName: null,');
    const ctl = src('social', 'groupMessaging.ts');
    const at = ctl.indexOf('async function insertCtlSysMessage(');
    expect(at).toBeGreaterThan(-1);
    expect(ctl.slice(at, at + 1600)).toContain('senderName: null,');
  });

  it('строка «создал(а) группу» по-прежнему встаёт раньше первого сообщения', () => {
    expect(src('..', 'ui', 'components', 'modals', 'groups', 'GroupCreateModal.tsx')).toContain('Date.now() - 1);');
  });

  it('сводку по-прежнему показывают как есть: экран ничего не отфильтровывает', () => {
    const modal = src('..', 'ui', 'components', 'modals', 'groups', 'GroupStatsModal.tsx');
    expect(modal).toContain('value: grpStats.totalMessages');
    expect(modal).toContain('grpStats.topSenders.map((s, i) => (');
  });
});
