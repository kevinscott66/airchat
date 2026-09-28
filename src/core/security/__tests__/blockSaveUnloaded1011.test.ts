/**
 * Одна блокировка стирала все прежние (v4.32.1011).
 *
 * Дефект. Блок-лист поднимается с диска один раз, при загрузке модуля, и
 * ложится в множество в памяти. Записывается он тоже целиком: `persistBlocked`
 * выкладывает это множество поверх записи. Если чтение сорвалось — база ещё
 * открывалась, ключ шифрования не поднялся при переключении профиля, — в
 * памяти остаётся ПУСТОЕ множество, неотличимое от «никого не блокировали».
 * Первая же блокировка или разблокировка выкладывала его на диск.
 *
 * Цена. Все прежние запреты исчезали разом и молча: человеку в это время
 * говорили «Заблокировано». Восстановить их нечем — на диске лежит новый
 * список из одной строки, а в интерфейсе больше нигде не записано, кого он
 * блокировал. Разблокировка ещё дороже: она не добавляет даже одной строки, и
 * на диск уходил пустой список.
 *
 * Отдельная проверка на нечитаемый шифртекст (v4.32.635) здесь не
 * срабатывала: она смотрит, открылась ли ЗАПИСЬ, а запись открывается
 * прекрасно — не открылась она минутами раньше, когда база была занята.
 *
 * Правка. Блокировка и разблокировка сперва дожидаются списка (`whenReady`
 * заодно перезапускает сорвавшееся чтение), а запись отказывается ложиться
 * поверх неподнятого списка — тем же значением `false`, по которому экраны
 * уже говорят BLOCK_NOT_SAVED_ON и BLOCK_NOT_SAVED_OFF.
 *
 * Границы. Запрет по-прежнему действует в памяти до перезапуска: «применить и
 * промолчать» хуже, чем «применить и честно сказать, что не записали».
 */
let mockReadThrows = false;
let mockUnreadable: Set<string> = new Set();

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const PREFIX = 'enc2:';
  const cell = (k: string) => {
    // Занятая база отвечает отказом на ЛЮБОЕ чтение, а не только на чтение
    // списка: именно так это и выглядит при переключении профиля.
    if (mockReadThrows) throw new Error('database is locked');
    const stored = kv[k];
    if (stored == null) return { state: 'absent' };
    if (mockUnreadable.has(k)) return { state: 'unreadable' };
    return { state: 'plain', text: stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored };
  };
  return {
    __kv: kv,
    __prefix: PREFIX,
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvGetSecretCell: jest.fn(async (k: string) => cell(k)),
    kvGetSecretCellUpgrading: jest.fn(async (k: string) => cell(k)),
    kvSetSecret: jest.fn(async (k: string, v: string) => { kv[k] = PREFIX + v; return true; }),
    notifyChatStorageChanged: jest.fn(),
  };
});

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../crypto/keyManager', () => ({ publicKeyHash4: () => new Uint8Array([1, 2, 3, 4]) }));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { RateLimiter } from '../rateLimiter';

type MockLocal = { __kv: Record<string, string>; __prefix: string };
const mockLocal = jest.requireMock('../../storage/local') as MockLocal;

const KEY = 'p1:airchat_blocked_peer_pub_b64';
const ANNA = 'A'.repeat(43);
const BORIS = 'B'.repeat(43);
const VERA = 'V'.repeat(43);

function put(list: string[]): void {
  mockLocal.__kv[KEY] = `${mockLocal.__prefix}${JSON.stringify(list)}`;
}

/** Что сейчас записано на диске. */
function onDisk(): string[] | null {
  const raw = mockLocal.__kv[KEY];
  return raw == null ? null : (JSON.parse(raw.slice(mockLocal.__prefix.length)) as string[]);
}

/** Список не поднялся: база была занята, когда его читали. */
async function startWithBusyDb(): Promise<RateLimiter> {
  mockReadThrows = true;
  const rl = new RateLimiter();
  await rl.whenReady();
  expect(rl.blockedListReadable()).toBe(false);
  return rl;
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockReadThrows = false;
  mockUnreadable = new Set();
});

describe('список не поднялся — прежние запреты не стираем', () => {
  it('база отпустила: новая блокировка добавляется к прежним, а не заменяет их', async () => {
    put([ANNA, BORIS]);
    const rl = await startWithBusyDb();

    mockReadThrows = false;
    await rl.blockContact(VERA);

    expect(onDisk()).toEqual([ANNA, BORIS, VERA]);
  });

  it('и сама блокировка при этом записана: ответ «да», а не «не вышло»', async () => {
    put([ANNA, BORIS]);
    const rl = await startWithBusyDb();

    mockReadThrows = false;

    await expect(rl.blockContact(VERA)).resolves.toBe(true);
    expect(rl.isBlocked(ANNA)).toBe(true);
  });

  it('база всё ещё занята: на диск не пишем ничего и честно отвечаем «не вышло»', async () => {
    put([ANNA, BORIS]);
    const rl = await startWithBusyDb();

    await expect(rl.blockContact(VERA)).resolves.toBe(false);
    expect(onDisk()).toEqual([ANNA, BORIS]);
  });

  it('разблокировка из неподнятого списка не вычищает диск', async () => {
    // Дороже всего: снятие не добавляет даже одной строки — на диск уходил бы
    // пустой список, то есть «никто не заблокирован».
    put([ANNA, BORIS]);
    const rl = await startWithBusyDb();

    await expect(rl.unblockContact(ANNA)).resolves.toBe(false);
    expect(onDisk()).toEqual([ANNA, BORIS]);
  });

  it('база отпустила: снимается один запрет, остальные остаются', async () => {
    put([ANNA, BORIS]);
    const rl = await startWithBusyDb();

    mockReadThrows = false;
    await expect(rl.unblockContact(ANNA)).resolves.toBe(true);

    expect(onDisk()).toEqual([BORIS]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный день', () => {
  it('поднятый список принимает и блокировку, и снятие', async () => {
    put([ANNA]);
    const rl = new RateLimiter();
    await rl.whenReady();

    await expect(rl.blockContact(BORIS)).resolves.toBe(true);
    expect(onDisk()).toEqual([ANNA, BORIS]);

    await expect(rl.unblockContact(ANNA)).resolves.toBe(true);
    expect(onDisk()).toEqual([BORIS]);
    expect(rl.isBlocked(ANNA)).toBe(false);
    expect(rl.isBlocked(BORIS)).toBe(true);
  });

  it('первая в жизни блокировка ложится на пустое место', async () => {
    const rl = new RateLimiter();
    await rl.whenReady();

    await expect(rl.blockContact(ANNA)).resolves.toBe(true);
    expect(onDisk()).toEqual([ANNA]);
  });

  it('нечитаемый шифртекст по-прежнему не переписывается (v4.32.635)', async () => {
    put([ANNA]);
    mockUnreadable.add(KEY);
    const rl = new RateLimiter();
    await rl.whenReady();

    await expect(rl.blockContact(BORIS)).resolves.toBe(false);
    expect(onDisk()).toEqual([ANNA]);
  });
});

describe('ГРАНИЦА', () => {
  it('запрет действует в памяти до перезапуска, хотя записать его не вышло', async () => {
    // Иначе правка стоила бы дороже дефекта: не записали — и не применили.
    put([ANNA]);
    const rl = await startWithBusyDb();

    await expect(rl.blockContact(VERA)).resolves.toBe(false);
    expect(rl.isBlocked(VERA)).toBe(true);
    expect(rl.canSendMessage(VERA)).toBe(false);
  });

  it('ключ неверной формы отвергается раньше всякого чтения', async () => {
    put([ANNA]);
    const rl = await startWithBusyDb();

    await expect(rl.blockContact('не ключ')).resolves.toBe(false);
    expect(onDisk()).toEqual([ANNA]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const src = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf8');

  it('список по-прежнему записывается целиком, а не по одной строке', () => {
    // Из-за этого неподнятый список и стоит всех запретов: запись — это
    // замена, а не добавление.
    expect(src('security', 'rateLimiter.ts')).toContain('JSON.stringify([...this.blocked])');
  });

  it('у isBlocked по-прежнему нет ответа «не знаю»', () => {
    const rl = new RateLimiter();
    // Именно поэтому пустое множество в памяти неотличимо от пустого списка:
    // спросить множество, читали ли его, нельзя.
    expect(rl.isBlocked(ANNA)).toBe(false);
  });

  it('экраны по-прежнему говорят человеку про незаписанный запрет', () => {
    for (const path of [
      ['..', 'ui', 'screens', 'ContactsScreen.tsx'],
      ['..', 'ui', 'screens', 'ChatScreen.tsx'],
      ['..', 'ui', 'components', 'UserProfilePeek.tsx'],
    ]) {
      const body = src(...path);
      expect(body).toContain('BLOCK_NOT_SAVED_ON');
      expect(body).toContain('BLOCK_NOT_SAVED_OFF');
    }
  });
});
