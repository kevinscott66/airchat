/**
 * Отказ записи состояния профилей не должен оставлять устройство и память
 * говорящими разное.
 *
 * Дефект. v4.32.637 закрыла отказ записи КЛЮЧА: переключение и создание
 * профиля откатывают номер, если persistKeyPair не лёг. Но сама запись
 * состояния — `persistState()`, поход в SecureStore — звалась без try в
 * четырёх местах, и всегда ПОСЛЕ того, как память уже переписана.
 *
 * Цена. SecureStore отказывает не в теории: заблокированное устройство при
 * фоновом переключении на iOS, сорвавшийся keystore на Android, кончившееся
 * место — на обоих.
 *   • switchProfile: в памяти новый профиль, на диске старый, ключ старый.
 *     Всё написанное до перезапуска ложится под чужим owner_profile_id и
 *     чужим префиксом `p<id>:` — в переписку другого аккаунта.
 *   • addProfile: человеку говорят «Ошибка создания», а приложение работает
 *     под номером, которого на диске нет; уборка сирот сносит его файлы.
 *   • deleteProfile, увод активности: человек читает «Не удалось удалить» и
 *     остаётся ПОД ДРУГИМ аккаунтом — invalidateProfileCache сюда даже не
 *     доходил.
 *   • deleteProfile, вычёркивание строки: данные уже стёрты, а строка на
 *     диске цела — профиль вернётся в список пустым после перезапуска, и
 *     сказано об этом не было.
 *
 * Правка. Все четыре места откатывают память и отвечают тем, что вызывающий
 * умеет показать: null, исключение, `switch_failed`, остаток `row`.
 */
jest.mock('../../storage/secureStoreQueued', () => {
  const store: Record<string, string> = {};
  let fail = false;
  return {
    __store: store,
    __setStateFail: (v: boolean) => { fail = v; },
    getItemAsync: jest.fn(async (key: string) => store[key] ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      if (fail && key === 'airchat_profiles_state_v1') throw new Error('secure store full');
      store[key] = value;
    }),
    deleteItemAsync: jest.fn(async (key: string) => { delete store[key]; }),
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

/** Какие уборки удаления вообще позвали: ими проверяется «ничего не стёрто». */
const mockCalls: string[] = [];
const mockStep = (name: string): void => { mockCalls.push(name); };

jest.mock('../usernameRegistry', () => ({
  releaseOwnUsernameGlobally: jest.fn(async () => undefined),
}));
jest.mock('../../storage/local', () => ({
  deleteProfileDataFromLocalDb: jest.fn(async () => mockStep('localDb')),
  kvSet: jest.fn(async () => undefined),
}));
jest.mock('../../social/composeDraft', () => ({
  deleteLegacyComposeDraft: jest.fn(async () => mockStep('composeDraft')),
}));
jest.mock('../../social/feedService', () => ({
  cleanupFeedStorageForProfile: jest.fn(async () => mockStep('feed')),
}));
jest.mock('../../storage/dialogBackup', () => ({
  deleteDialogBackupForProfile: jest.fn(async () => mockStep('dialogBackup')),
}));
jest.mock('../avatarKeep', () => ({ collectAvatarsToKeep: jest.fn(async () => new Set<string>()) }));
jest.mock('../../media/avatarFiles', () => ({
  sweepAvatarFiles: jest.fn(async () => mockStep('avatars')),
}));
jest.mock('../../social/storyAlbums', () => ({
  // v4.32.991: уборка отвечает «да/нет». Отказ этот стенд изображает броском
  // из mockStep — как и у остальных шагов.
  sweepOrphanAlbumFiles: jest.fn(async () => {
    mockStep('albums');
    return true;
  }),
}));
jest.mock('../../social/liveLocationService', () => ({ stopAllLiveLocSessions: jest.fn() }));

import { readFileSync } from 'fs';
import { join } from 'path';

import { profileManager } from '../profileManager';

const STATE_KEY = 'airchat_profiles_state_v1';
const secure = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string>;
  __setStateFail: (v: boolean) => void;
  setItemAsync: jest.Mock;
};
const keys = jest.requireMock('../../crypto/keyManager') as { persistKeyPair: jest.Mock };

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

/** Что записано на диск прямо сейчас. */
function persisted(): { activeProfileId: number; profiles: { id: number }[] } {
  return JSON.parse(secure.__store[STATE_KEY]);
}

async function boot(): Promise<void> {
  await profileManager.clearForWalletWipe();
  for (const k of Object.keys(secure.__store)) delete secure.__store[k];
  secure.__setStateFail(false);
  mockCalls.length = 0;
  keys.persistKeyPair.mockClear();
  secure.__store[STATE_KEY] = GOOD;
  await profileManager.init();
}

beforeEach(boot);
afterEach(() => { secure.__setStateFail(false); });

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('подсунутый отказ действительно рушит запись состояния', async () => {
    secure.__setStateFail(true);
    await expect(secure.setItemAsync(STATE_KEY, '{}')).rejects.toThrow('secure store full');
  });

  it('и не трогает записи по другим ключам', async () => {
    secure.__setStateFail(true);
    await expect(secure.setItemAsync('другой_ключ', 'x')).resolves.toBeUndefined();
  });
});

describe('переключение профиля', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: исправная запись переключает и в памяти, и на диске', async () => {
    const got = await profileManager.switchProfile(2);
    expect(got?.id).toBe(2);
    expect(profileManager.getActiveProfile()?.id).toBe(2);
    expect(persisted().activeProfileId).toBe(2);
  });

  it('состояние не записалось — в памяти остался прежний профиль', async () => {
    secure.__setStateFail(true);
    await expect(profileManager.switchProfile(2)).resolves.toBeNull();
    expect(profileManager.getActiveProfile()?.id).toBe(1);
    expect(persisted().activeProfileId).toBe(1);
  });

  it('и ключ устройства к новому профилю не приводился', async () => {
    secure.__setStateFail(true);
    await profileManager.switchProfile(2);
    // Иначе на диске один профиль, а подписывает другой.
    expect(keys.persistKeyPair).not.toHaveBeenCalled();
    expect(profileManager.getActiveKeyPair().publicKey[0]).toBe(0);
  });
});

describe('создание профиля', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: исправная запись заводит профиль и делает активным', async () => {
    const p = await profileManager.addProfile('Третий');
    expect(p.id).toBe(3);
    expect(profileManager.getActiveProfile()?.id).toBe(3);
    expect(persisted().profiles.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('состояние не записалось — профиля нет ни в списке, ни активным', async () => {
    secure.__setStateFail(true);
    await expect(profileManager.addProfile('Третий')).rejects.toThrow(/сохранить список профилей/);
    expect(profileManager.getProfileIds()).toEqual([1, 2]);
    expect(profileManager.getActiveProfile()?.id).toBe(1);
  });

  it('и ключ несуществующего профиля на устройство не лёг', async () => {
    secure.__setStateFail(true);
    await expect(profileManager.addProfile('Третий')).rejects.toThrow();
    expect(keys.persistKeyPair).not.toHaveBeenCalled();
  });
});

describe('удаление активного профиля', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: исправная запись уводит активность и стирает данные', async () => {
    const res = await profileManager.deleteProfile(1);
    expect(res).toEqual({ removed: true, leftovers: [] });
    expect(profileManager.getActiveProfile()?.id).toBe(2);
    expect(mockCalls).toContain('localDb');
  });

  it('увод активности не записался — не стёрто ничего и человек остался у себя', async () => {
    secure.__setStateFail(true);
    const res = await profileManager.deleteProfile(1);
    expect(res).toEqual({ removed: false, reason: 'switch_failed', err: 'secure store full' });
    expect(profileManager.getActiveProfile()?.id).toBe(1);
    expect(mockCalls).toEqual([]);
  });
});

describe('вычёркивание строки после уборок', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: исправная запись уносит строку и с диска', async () => {
    expect(await profileManager.deleteProfile(2)).toEqual({ removed: true, leftovers: [] });
    expect(persisted().profiles.map((r) => r.id)).toEqual([1]);
  });

  it('строка не записалась — данные всё равно стёрты, и об этом сказано', async () => {
    await profileManager.switchProfile(1);
    secure.__setStateFail(true);
    const res = await profileManager.deleteProfile(2);
    // Данные ушли: вернуть строку значило бы показать профиль, за которым пусто.
    expect(mockCalls).toContain('localDb');
    expect(res).toEqual({ removed: true, leftovers: ['row'] });
    expect(profileManager.getProfileIds()).toEqual([1]);
    // А на диске строка цела — потому и остаток, а не тихий успех.
    expect(persisted().profiles.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('форма исходников', () => {
  const mgr = readFileSync(join(__dirname, '..', 'profileManager.ts'), 'utf8');
  const sel = readFileSync(
    join(__dirname, '..', '..', '..', 'ui', 'components', 'ProfileSelector.tsx'),
    'utf8',
  );

  it('у каждого из четырёх мест свой разбор отказа', () => {
    for (const tag of [
      'switch_profile_persist_failed',
      'add_profile_persist_failed',
      'delete_profile_switch_failed',
      'delete_profile_row_persist_failed',
    ]) {
      expect(mgr).toContain(tag);
    }
  });

  it('строка профиля названа остатком наравне с файлами', () => {
    expect(mgr).toContain("'avatars' | 'albums' | 'row'");
    expect(mgr).toContain("reason: 'switch_failed'");
  });

  it('экран различает оба новых исхода', () => {
    expect(sel).toContain("result.leftovers.includes('row')");
    expect(sel).toContain("reason === 'switch_failed'");
  });
});
