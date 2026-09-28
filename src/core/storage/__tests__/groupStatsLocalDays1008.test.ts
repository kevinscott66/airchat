/**
 * Столбики «Активность за 7 дней» считали сутки по Гринвичу (v4.32.1008).
 *
 * Дефект. Столбики собирала база: `strftime('%Y-%m-%d', datetime(created_at /
 * 1000, 'unixepoch'))` — это сутки по UTC. Подписи к столбикам строил тот же
 * `getGroupStats` из местного календаря, а рисовал их экран через
 * `dayMonthShortFromYmd`, которая разбирает строку как местную дату
 * (v4.32.926). Ключи не сходились ни у кого, кроме Гринвича.
 *
 * Цена. К востоку от Гринвича начало суток уезжало на вчерашний столбик: в
 * Москве всё, написанное до трёх ночи, рисовалось под вчерашним числом, а
 * написанное до трёх ночи самого давнего из семи дней не рисовалось вовсе —
 * его ключ уходил за левый край. К западу так же пропадал вечер: в Нью-Йорке
 * всё после восьми вечера уходило на завтрашний ключ, которого в семёрке
 * нет. Плитка «Сообщений» при этом считала правильно, и сводка спорила сама
 * с собой: семь столбиков в сумме давали меньше, чем число над ними.
 *
 * Правка. Столбики раскладывает не база, а тот же код, что строит подписи, —
 * одним ключом `localDayKey`. Окно сузилось с «последних 168 часов» до ровно
 * тех семи суток, что нарисованы.
 *
 * Границы. Служебные строки в столбики по-прежнему не идут (v4.32.1007).
 * Сообщение старше семидневки в столбики не попадает — оно и не нарисовано.
 *
 * Часовой пояс здесь задаёт машина: из теста его не переставить — V8 читает
 * TZ один раз на процесс, и присваивание `process.env.TZ` внутри jest ничего
 * не меняет (проверено). Поэтому сутки проверяются по краям: первая минута и
 * последняя. Восточнее Гринвича расходилась первая, западнее — последняя,
 * так что на любой машине, кроме стоящей ровно на Гринвиче, хотя бы одна из
 * проверок ниже держит правку. На самом Гринвиче числа совпадают и эти
 * проверки вырождаются — там за правку отвечает запрет на `strftime`.
 *
 * База поддельная, но запросы разбирает по-настоящему: и прежний `strftime`,
 * и нынешний отбор по `created_at`, — поэтому прежняя редакция получает
 * ровно то, что получала от SQLite.
 */
type Row = {
  sender_pub_b64: string;
  sender_name: string | null;
  text: string;
  media_cids: string | null;
  created_at: number;
};

let mockRows: Row[] = [];

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
          // Прежний запрос: сутки по UTC, ровно как их считает SQLite.
          const since = Number(params[2] ?? 0);
          const days = new Map<string, number>();
          for (const r of pick(sql)) {
            if (r.created_at < since) continue;
            const day = new Date(r.created_at).toISOString().slice(0, 10);
            days.set(day, (days.get(day) ?? 0) + 1);
          }
          return [...days.entries()].sort().map(([day, cnt]) => ({ day, cnt }));
        }
        if (sql.includes('SELECT created_at')) {
          const since = Number(params[2] ?? 0);
          return pick(sql)
            .filter((r) => r.created_at >= since)
            .map((r) => ({ created_at: r.created_at }));
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
import { encryptAtRestString } from '../localEncryption';

const DEK = new Uint8Array(32).fill(7);
const enc = (v: string) => encryptAtRestString(v, DEK);

/** Полночь местных суток, отстоящих на `daysAgo` дней назад. */
function midnight(daysAgo: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/** Первая минута тех суток: восточнее Гринвича она лежит во вчерашнем UTC. */
function dawn(daysAgo: number): number {
  return midnight(daysAgo).getTime() + 60_000;
}

/** Последняя минута тех суток: западнее Гринвича она лежит в завтрашнем UTC. */
function dusk(daysAgo: number): number {
  return midnight(daysAgo).getTime() + 23 * 3600_000 + 59 * 60_000;
}

/** Полдень тех суток: этот час у местных суток и суток UTC общий везде. */
function noon(daysAgo: number): number {
  return midnight(daysAgo).getTime() + 12 * 3600_000;
}

/** Ключ столбика — тот же, что подпишет экран: местная дата. */
function key(daysAgo: number): string {
  const d = midnight(daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function said(pub: string, name: string, ts: number): Row {
  return { sender_pub_b64: pub, sender_name: enc(name), text: enc('привет'), media_cids: null, created_at: ts };
}

/** Столбик по местной дате — или `undefined`, если такого столбика не нарисовали. */
async function bar(daysAgo: number): Promise<number | undefined> {
  const daily = (await getGroupStats('g1', 1)).dailyActivity;
  return daily.find((d) => d.date === key(daysAgo))?.count;
}

beforeEach(() => {
  mockRows = [];
});

describe('край суток остаётся в своих сутках', () => {
  it('первая минута суток — на сегодняшнем столбике, а не на вчерашнем', async () => {
    mockRows = [said('A', 'Аня', dawn(0))];

    expect(await bar(0)).toBe(1);
    expect(await bar(1)).toBe(0);
  });

  it('последняя минута суток — на вчерашнем столбике, а не на сегодняшнем', async () => {
    mockRows = [said('A', 'Аня', dusk(1))];

    expect(await bar(1)).toBe(1);
    expect(await bar(0)).toBe(0);
  });

  it('самый левый столбик своего края не теряет', async () => {
    mockRows = [said('A', 'Аня', dawn(6)), said('B', 'Боря', dusk(6))];

    expect(await bar(6)).toBe(2);
  });

  it('плитка и столбики сходятся: в сумме по семи дням столько же, сколько сообщений', async () => {
    // По сообщению у каждого края семидневки: восточнее Гринвича за левый
    // край уходило первое, западнее за правый — второе.
    mockRows = [said('A', 'Аня', dawn(6)), said('A', 'Аня', noon(3)), said('B', 'Боря', dusk(0))];
    const s = await getGroupStats('g1', 1);

    expect(s.totalMessages).toBe(3);
    expect(s.dailyActivity.reduce((a, d) => a + d.count, 0)).toBe(3);
  });

  it('сообщение без имени отправителя раскладывают по тому же календарю', async () => {
    // Безымянные строки считает отдельная ветка — у неё был свой ключ по UTC.
    mockRows = [
      { sender_pub_b64: 'C', sender_name: null, text: enc('привет'), media_cids: null, created_at: dawn(0) },
      { sender_pub_b64: 'C', sender_name: null, text: enc('и ещё'), media_cids: null, created_at: dusk(1) },
    ];

    expect(await bar(0)).toBe(1);
    expect(await bar(1)).toBe(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: столбиков по-прежнему семь и считают они как считали', () => {
  it('полдень — на своём дне: так было и до правки', async () => {
    mockRows = [said('A', 'Аня', noon(1)), said('A', 'Аня', noon(1) + 1)];

    expect(await bar(1)).toBe(2);
  });

  it('семь столбиков, от давнего к сегодняшнему, последний — сегодня', async () => {
    const daily = (await getGroupStats('g1', 1)).dailyActivity;

    expect(daily).toHaveLength(7);
    expect(daily.map((d) => d.date)).toEqual([key(6), key(5), key(4), key(3), key(2), key(1), key(0)]);
  });

  it('пустая группа — семь нулей, а не отказ', async () => {
    const daily = (await getGroupStats('g1', 1)).dailyActivity;

    expect(daily.map((d) => d.count)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('ГРАНИЦА', () => {
  it('сообщение старше семидневки в столбики не идёт, но в плитке остаётся', async () => {
    mockRows = [said('A', 'Аня', noon(8))];
    const s = await getGroupStats('g1', 1);

    expect(s.totalMessages).toBe(1);
    expect(s.dailyActivity.reduce((a, d) => a + d.count, 0)).toBe(0);
  });

  it('служебная строка не встаёт на столбик и в свой местный день (v4.32.1007)', async () => {
    mockRows = [
      {
        sender_pub_b64: 'A',
        sender_name: null,
        text: enc(`${GROUP_SYS_PREFIX}Сообщение закреплено`),
        media_cids: null,
        created_at: dawn(0),
      },
    ];

    expect(await bar(0)).toBe(0);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf8');

  it('подпись столбика разбирает дату как местную, а не как полночь по Гринвичу', () => {
    // v4.32.926: строка целиком в конструктор `Date` — это полночь UTC, и
    // подпись съезжала на день. Раз подпись местная, местным должен быть и
    // счёт под ней.
    const ru = src('time', 'ruDateTime.ts');
    const from = ru.indexOf('export function dayMonthShortFromYmd(');
    expect(from).toBeGreaterThan(-1);
    const body = ru.slice(from, ru.indexOf('export function', from + 10));
    expect(body).toContain('new Date(Number(m[1]), month - 1, day)');
    expect(body).not.toContain('new Date(ymd)');
  });

  it('экран по-прежнему подписывает столбики строкой даты, а последний считает сегодняшним', () => {
    const modal = src('..', 'ui', 'components', 'modals', 'groups', 'GroupStatsModal.tsx');
    expect(modal).toContain('dayMonthShortFromYmd(d.date)');
    expect(modal).toContain('const isToday = i === grpStats.dailyActivity.length - 1;');
  });

  it('раскладку по дням по-прежнему не поручают базе', () => {
    // Вернётся `strftime(... 'unixepoch')` — вернётся и расхождение.
    const body = src('storage', 'local.ts');
    expect(body).not.toContain("datetime(created_at/1000, 'unixepoch')");
  });
});
