/**
 * Переименование профиля отвечает, ЧТО именно не вышло, и не оставляет имени,
 * которого нет на диске.
 *
 * v4.32.743. `renameProfile` отвечала одним `boolean` на четыре разные беды:
 * менеджер не поднялся, строки с таким номером нет, имя пустое, имя уже носит
 * соседний профиль. Экран, получивший «нет», выбирал одну фразу на все случаи
 * («Имя пустое или уже занято другим профилем») — а окно правки профиля ответ
 * вовсе выбрасывало и говорило «Профиль сохранён» поверх несостоявшегося
 * переименования.
 *
 * Отдельно — беда внутри самой функции: имя в памяти менялось ДО записи
 * состояния, и отказ записи уходил наверх исключением. Список профилей после
 * этого показывал новое имя, которого на диске нет: до ближайшего запуска
 * приложения — новое, после — прежнее, и ни слова о том, что переименование не
 * состоялось.
 */
jest.mock('../../storage/secureStoreQueued', () => {
  const store: Record<string, string> = {};
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store[key] ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      delete store[key];
    }),
  };
});

jest.mock('../../crypto/keyManager', () => ({
  loadKeyPair: jest.fn(async () => null),
  persistKeyPair: jest.fn(async () => undefined),
}));

jest.mock('../../backup/seedPhrase', () => ({
  getStoredMnemonic: jest.fn(async () => 'слово '.repeat(12).trim()),
  deriveKeyPairFromMnemonicForProfile: jest.fn((_m: string, idx: number) => ({
    publicKey: Uint8Array.from([idx, 200, 201]),
    secretKey: Uint8Array.from([idx, 100, 101]),
  })),
}));

jest.mock('../did', () => ({ publicKeyToDidKey: (pub: Uint8Array) => `did:key:z${pub[0]}` }));

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../storage/dekDerivation', () => ({
  bytesEqualConstTime: (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]),
}));

jest.mock('../../social/liveLocationService', () => ({ stopAllLiveLocSessions: jest.fn() }));

import { profileManager } from '../profileManager';

const STATE_KEY = 'airchat_profiles_state_v1';
const secure = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string>;
  setItemAsync: jest.Mock;
};

/** Два профиля, активен первый. */
const GOOD = JSON.stringify({
  v: 1,
  activeProfileId: 1,
  nextProfileId: 3,
  nextDerivationIndex: 2,
  profiles: [
    { id: 1, derivationIndex: 0, name: 'Личный', createdAt: 1, lastUsed: 2 },
    { id: 2, derivationIndex: 1, name: 'Рабочий', createdAt: 3, lastUsed: 4 },
  ],
});

async function boot(): Promise<void> {
  await profileManager.clearForWalletWipe();
  for (const k of Object.keys(secure.__store)) delete secure.__store[k];
  secure.__store[STATE_KEY] = GOOD;
  await profileManager.init();
}

/** Имя профиля так, как его увидит следующий запуск приложения. */
function nameOnDisk(id: number): string | undefined {
  const raw = secure.__store[STATE_KEY];
  const rows = JSON.parse(raw).profiles as Array<{ id: number; name: string }>;
  return rows.find((p) => p.id === id)?.name;
}

beforeEach(async () => {
  secure.setItemAsync.mockClear();
  await boot();
});

describe('отказ назван по имени, а не сведён к одному «нет»', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: обычное переименование доходит до диска', async () => {
    await profileManager.renameProfile(1, 'Основной');
    expect(nameOnDisk(1)).toBe('Основной');
    // И новое имя видно сразу, а не через пять секунд жизни снимка.
    expect(profileManager.getActiveProfile()?.name).toBe('Основной');
  });

  it('удачное переименование отвечает исходом, а не «да»', async () => {
    expect(await profileManager.renameProfile(1, 'Основной')).toEqual({ renamed: true });
  });

  it('пустое имя — это «пустое», а не «занято»', async () => {
    expect(await profileManager.renameProfile(1, '   ')).toEqual({ renamed: false, reason: 'empty' });
    expect(nameOnDisk(1)).toBe('Личный');
  });

  it('имя соседнего профиля — «занято», даже в другом регистре', async () => {
    expect(await profileManager.renameProfile(1, 'рАбОчИй')).toEqual({
      renamed: false,
      reason: 'name_taken',
    });
    expect(nameOnDisk(1)).toBe('Личный');
  });

  it('своё же имя занятым не считается', async () => {
    await profileManager.renameProfile(1, 'Личный');
    expect(nameOnDisk(1)).toBe('Личный');
  });

  it('строки с таким номером нет — «не найдено»', async () => {
    expect(await profileManager.renameProfile(77, 'Хоть какое')).toEqual({
      renamed: false,
      reason: 'not_found',
    });
  });
});

describe('имени, которого нет на диске, не остаётся и в памяти', () => {
  it('отказ записи возвращает прежнее имя и называет причину', async () => {
    secure.setItemAsync.mockRejectedValueOnce(new Error('keystore busy'));
    const res = await profileManager.renameProfile(1, 'Основной');
    expect(res).toEqual({ renamed: false, reason: 'save_failed', err: 'keystore busy' });
    // Ни в списке, ни на диске нового имени нет: разойтись им не на чем.
    expect(profileManager.getProfileName(1)).toBe('Личный');
    expect(nameOnDisk(1)).toBe('Личный');
  });

  it('после отказа записи переименование повторяется тем же именем и проходит', async () => {
    secure.setItemAsync.mockRejectedValueOnce(new Error('keystore busy'));
    expect((await profileManager.renameProfile(1, 'Основной')).renamed).toBe(false);
    expect(await profileManager.renameProfile(1, 'Основной')).toEqual({ renamed: true });
    expect(nameOnDisk(1)).toBe('Основной');
  });

  it('отказ записи не бросает: окно правки профиля ловило его общим текстом', async () => {
    secure.setItemAsync.mockRejectedValueOnce(new Error('keystore busy'));
    await expect(profileManager.renameProfile(1, 'Основной')).resolves.toBeDefined();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('отказ не показывает нового имени ни в списке, ни под таб-баром', async () => {
    await profileManager.renameProfile(1, 'рАбОчИй');
    expect(profileManager.getActiveProfile()?.name).toBe('Личный');
    expect(profileManager.getProfileName(1)).toBe('Личный');
  });

  it('имя длиннее предела по-прежнему обрезается, а не отвергается', async () => {
    await profileManager.renameProfile(1, 'я'.repeat(200));
    expect(nameOnDisk(1)).toBe('я'.repeat(64));
  });

  it('соседний профиль переименование не задевает', async () => {
    await profileManager.renameProfile(1, 'Основной');
    expect(nameOnDisk(2)).toBe('Рабочий');
  });
});
