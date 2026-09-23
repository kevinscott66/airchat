/**
 * Заметка о недоотпущенном имени не легла на диск — имя всё равно отпустят (v4.32.785).
 *
 * Дефект. При удалении профиля `releaseOwnUsernameGlobally` сперва кладёт на
 * диск заметку, и только потом идёт в реестр. Заметка — весь смысл v4.32.742:
 * профили удаляют и в самолёте, и на неоплаченном интернете, и без заметки
 * повторять было бы нечем. Разбирает её `retryPendingUsernameReleases`, и
 * другого списка у неё нет.
 *
 * Писалась заметка гасящей `kvSet`: та глотает отказ базы внутри себя и
 * отвечает `void`. Занятой на долю секунды базы хватало, чтобы заметки не
 * стало, — а профиль удалялся дальше как ни в чём не бывало. Имя оставалось в
 * реестре НАВСЕГДА: оно указывало на ключ, которым больше никто не
 * пользуется, письма на `@имя` уходили в никуда, и вернуть его не мог ни этот
 * человек, ни любой другой. Само оно не освобождается — сервер снимает запись
 * профиля только когда тот же номер займёт другое имя, а номера растут
 * монотонно.
 *
 * Правка. Пишем проверяемой `kvSetChecked`. Не легло — профиль попадает в
 * список памяти процесса, и `retryPendingUsernameReleases` разбирает сперва
 * его: пробует записать заметку заново (база могла освободиться — тогда
 * попытка переживёт перезапуск) и в любом случае идёт в реестр.
 */
jest.mock('../../backup/seedPhrase', () => ({
  getStoredMnemonic: jest.fn(async () => 'word '.repeat(11) + 'word'),
  deriveKeyPairFromMnemonic: jest.fn(() => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  })),
}));
jest.mock('../../sync/syncApi', () => ({
  claimSyncUsername: jest.fn(),
  releaseSyncUsername: jest.fn(),
}));
jest.mock('../ownProfile', () => ({
  getOwnDisplayNameFor: jest.fn(),
  getOwnUsernameFor: jest.fn(),
  isUsernameTakenByAnotherProfile: jest.fn(),
  setOwnUsername: jest.fn(),
}));
jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: jest.fn(() => ({ id: 0 })),
    getActiveKeyPair: jest.fn(() => null),
  },
}));
jest.mock('../ownBadge', () => ({ ownBadgeGrantFor: jest.fn() }));

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const state = { failSet: false };
  return {
    __kv: kv,
    __state: state,
    // Гасящая форма подделана так же, как она устроена в local.ts: отказ базы
    // не виден снаружи ничем. Без неё встречная проверка (файл до правки) шла
    // бы не по настоящему коду, а спотыкалась о невыставленную заглушку.
    kvSet: jest.fn(async (k: string, v: string) => {
      if (state.failSet) return;
      kv[k] = v;
    }),
    // Ровно так отказывает настоящая проверяемая запись: строка не легла, и об
    // этом сказано ответом, а не исключением.
    kvSetChecked: jest.fn(async (k: string, v: string) => {
      if (state.failSet) return false;
      kv[k] = v;
      return true;
    }),
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvTryListKeysByPrefix: jest.fn(async (p: string) => Object.keys(kv).filter((k) => k.startsWith(p))),
  };
});

import * as fs from 'fs';
import * as path from 'path';

import { releaseSyncUsername } from '../../sync/syncApi';
import { releaseOwnUsernameGlobally, retryPendingUsernameReleases } from '../usernameRegistry';

const release = releaseSyncUsername as jest.MockedFunction<typeof releaseSyncUsername>;
const local = jest.requireMock('../../storage/local') as {
  __kv: Record<string, string>;
  __state: { failSet: boolean };
};
const PENDING = 'airchat_username_release_pending:';

/** Номера профилей, о которых заметка лежит на диске. */
const notedOnDisk = (): number[] =>
  Object.keys(local.__kv)
    .filter((k) => k.startsWith(PENDING))
    .map((k) => Number(k.slice(PENDING.length)))
    .sort((a, b) => a - b);

/** Номера профилей, с которыми ходили в реестр. */
const asked = (): number[] => release.mock.calls.map((c) => c[2] as number);

beforeEach(async () => {
  jest.clearAllMocks();
  for (const k of Object.keys(local.__kv)) delete local.__kv[k];
  local.__state.failSet = false;
  release.mockResolvedValue({ ok: true });
  // Список памяти процесса переживает тесты — вычерпать его удачным заходом.
  await retryPendingUsernameReleases();
  jest.clearAllMocks();
});

describe('база отказала в заметке — имя не потеряно', () => {
  test('заходу на экран профиля есть что добирать', async () => {
    local.__state.failSet = true;
    release.mockRejectedValue(new Error('сети нет'));
    await releaseOwnUsernameGlobally(41);
    // Заметки на диске нет — база её не приняла.
    expect(notedOnDisk()).toEqual([]);

    // Считаем только повторные заходы: первый, неудачный, был внутри самого
    // удаления и о живучести списка ничего не говорит.
    release.mockClear();
    release.mockResolvedValue({ ok: true });
    await retryPendingUsernameReleases();
    // До правки здесь было пусто: заметка исчезла молча, разбирать стало
    // нечего, и имя @… осталось занятым навсегда.
    expect(asked()).toEqual([41]);
  });

  test('база ожила раньше сети — заметка ложится на диск и переживёт перезапуск', async () => {
    local.__state.failSet = true;
    release.mockRejectedValue(new Error('сети нет'));
    await releaseOwnUsernameGlobally(42);
    expect(notedOnDisk()).toEqual([]);

    local.__state.failSet = false;
    await retryPendingUsernameReleases();
    expect(notedOnDisk()).toEqual([42]);
  });

  test('имя отпущено — ни на диске, ни в памяти его больше нет', async () => {
    local.__state.failSet = true;
    release.mockRejectedValue(new Error('сети нет'));
    await releaseOwnUsernameGlobally(41);

    local.__state.failSet = false;
    release.mockClear();
    release.mockResolvedValue({ ok: true });
    await retryPendingUsernameReleases();
    expect(asked()).toEqual([41]);
    expect(notedOnDisk()).toEqual([]);

    // Второй заход по тому же профилю больше не ходит: список пуст.
    release.mockClear();
    await retryPendingUsernameReleases();
    expect(asked()).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный путь не изменился', () => {
  test('заметка ложится до запроса, а после ответа снимается', async () => {
    await releaseOwnUsernameGlobally(44);
    expect(asked()).toEqual([44]);
    expect(notedOnDisk()).toEqual([]);
  });

  test('сети нет — заметка остаётся на диске и добирается позже', async () => {
    release.mockRejectedValue(new Error('сети нет'));
    await releaseOwnUsernameGlobally(45);
    expect(notedOnDisk()).toEqual([45]);

    release.mockResolvedValue({ ok: true });
    await retryPendingUsernameReleases();
    expect(notedOnDisk()).toEqual([]);
  });

  test('связи нет — остальные заметки в этот раз не тратятся', async () => {
    release.mockRejectedValue(new Error('сети нет'));
    await releaseOwnUsernameGlobally(46);
    await releaseOwnUsernameGlobally(47);
    release.mockClear();
    await retryPendingUsernameReleases();
    // Первый отказ обрывает проход: заметки обеих остаются на месте.
    expect(release).toHaveBeenCalledTimes(1);
    expect(notedOnDisk()).toEqual([46, 47]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'usernameRegistry.ts'), 'utf8');
  const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

  test('заметка — единственный список, который разбирает добор', () => {
    expect(SRC).toContain("const RELEASE_PENDING_PREFIX = 'airchat_username_release_pending:';");
    expect(SRC).toContain('const keys = await kvTryListKeysByPrefix(RELEASE_PENDING_PREFIX);');
  });

  test('гасящая kvSet отвечает void и здесь больше не зовётся', () => {
    expect(LOCAL).toContain('export async function kvSet(key: string, value: string): Promise<void> {');
    expect(SRC).toContain(
      'if (!(await kvSetChecked(`${RELEASE_PENDING_PREFIX}${profileId}`, String(Date.now())))) {'
    );
    expect(SRC).not.toContain('await kvSet(`${RELEASE_PENDING_PREFIX}');
  });

  test('имя само собой в реестре не освобождается', () => {
    // Заявка на освобождение — единственный путь: сервер снимает запись
    // профиля только когда ТОТ ЖЕ номер займёт другое имя.
    expect(SRC).toContain('await releaseSyncUsername(mnemonic, deriveKeyPairFromMnemonic(mnemonic), profileId);');
  });
});
