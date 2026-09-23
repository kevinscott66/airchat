/**
 * Список профилей не стирается своей же неудачей чтения, а удалённый профиль
 * отпускает своё `@имя`.
 *
 * v4.32.731. Два дефекта в одном месте — вокруг списка профилей, который
 * лежит одной записью в SecureStore и больше нигде:
 *
 *  1. Снимок на диске был, а состояние из него не собралось — не разобрался,
 *     оказался больше допустимого или пришёл от более новой сборки (`v !== 1`,
 *     то есть человек откатил установку). Дальше создавался профиль по
 *     умолчанию и записывался ПОВЕРХ снимка: имена профилей, их номера и то,
 *     какой был активен, исчезали навсегда. Для отката это особенно обидно —
 *     снимок целый, прочитать его не может именно эта сборка, и достаточно
 *     поставить обратно новую. Отметка `snapshotIncomplete` о беде знала, но
 *     запись не останавливала.
 *
 *  2. `releaseOwnUsernameGlobally` писалась для удаления профиля и не звалась
 *     ниоткуда. `@имя` удалённого аккаунта оставалось занятым в общем реестре
 *     и указывало на ключ, которым больше никто не пользуется: письма на него
 *     уходили в никуда, а вернуть имя себе было нельзя.
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

/** Уборки, которые deleteProfile зовёт через динамический import. */
const released: number[] = [];
jest.mock('../usernameRegistry', () => ({
  releaseOwnUsernameGlobally: jest.fn(async (profileId: number) => {
    released.push(profileId);
  }),
}));
jest.mock('../../storage/local', () => ({
  deleteProfileDataFromLocalDb: jest.fn(async () => undefined),
  kvSet: jest.fn(async () => undefined),
}));
jest.mock('../../social/composeDraft', () => ({ deleteLegacyComposeDraft: jest.fn(async () => undefined) }));
jest.mock('../../social/feedService', () => ({ cleanupFeedStorageForProfile: jest.fn(async () => undefined) }));
jest.mock('../../storage/dialogBackup', () => ({ deleteDialogBackupForProfile: jest.fn(async () => undefined) }));
jest.mock('../avatarKeep', () => ({ collectAvatarsToKeep: jest.fn(async () => new Set<string>()) }));
jest.mock('../../media/avatarFiles', () => ({ sweepAvatarFiles: jest.fn(async () => undefined) }));
jest.mock('../../social/storyAlbums', () => ({ sweepOrphanAlbumFiles: jest.fn(async () => undefined) }));
jest.mock('../../social/liveLocationService', () => ({ stopAllLiveLocSessions: jest.fn() }));

import { profileManager } from '../profileManager';

const STATE_KEY = 'airchat_profiles_state_v1';
const secure = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string>;
};

/** Исправный снимок из двух профилей. */
const GOOD = JSON.stringify({
  v: 1,
  activeProfileId: 2,
  nextProfileId: 3,
  nextDerivationIndex: 2,
  profiles: [
    { id: 1, derivationIndex: 0, name: 'Личный', createdAt: 1, lastUsed: 2 },
    { id: 2, derivationIndex: 1, name: 'Рабочий', createdAt: 3, lastUsed: 4 },
  ],
});

/** Тот же снимок, но записанный более новой сборкой: откат установки. */
const NEWER = JSON.stringify({
  v: 2,
  activeProfileId: 2,
  nextProfileId: 3,
  nextDerivationIndex: 2,
  profiles: [
    { id: 1, derivationIndex: 0, name: 'Личный', createdAt: 1, lastUsed: 2 },
    { id: 2, derivationIndex: 1, name: 'Рабочий', createdAt: 3, lastUsed: 4 },
  ],
});

/**
 * Поднять менеджер с нуля на заданном снимке.
 *
 * `clearForWalletWipe` — единственный способ вернуть модульный синглтон в
 * исходное состояние: он же сбрасывает отметку о неполном снимке.
 */
async function bootWith(raw: string | null): Promise<void> {
  await profileManager.clearForWalletWipe();
  for (const k of Object.keys(secure.__store)) delete secure.__store[k];
  if (raw !== null) secure.__store[STATE_KEY] = raw;
  await profileManager.init();
}

beforeEach(() => {
  released.length = 0;
});

describe('непрочитанный снимок профилей переживает запуск', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: исправный снимок читается и работает как прежде', async () => {
    await bootWith(GOOD);
    expect(profileManager.getActiveProfile()?.id).toBe(2);
    expect(profileManager.getProfileIds()).toEqual([1, 2]);
  });

  it('снимок более новой сборки остаётся на диске нетронутым', async () => {
    await bootWith(NEWER);
    // Работать при этом есть чем: профиль по умолчанию поднят в памяти.
    expect(profileManager.getActiveProfile()?.id).toBe(1);
    // А запись — ровно та, что была: поставить новую сборку обратно и всё
    // вернётся. Раньше здесь лежал профиль по умолчанию.
    expect(secure.__store[STATE_KEY]).toBe(NEWER);
  });

  it('и неразобравшийся снимок тоже', async () => {
    await bootWith('{это не json');
    expect(profileManager.getActiveProfile()?.id).toBe(1);
    expect(secure.__store[STATE_KEY]).toBe('{это не json');
  });

  it('слишком большое значение тоже не затирается', async () => {
    const huge = `{"v":1,"pad":"${'a'.repeat(256 * 1024)}"}`;
    await bootWith(huge);
    expect(secure.__store[STATE_KEY]).toBe(huge);
  });

  it('список профилей при этом честно назван неполным', async () => {
    await bootWith(NEWER);
    expect(profileManager.getProfileIdsComplete()).toEqual({ ids: [1], complete: false });
  });

  it('снимка не было вовсе — профиль по умолчанию записывается, как и раньше', async () => {
    await bootWith(null);
    expect(JSON.parse(secure.__store[STATE_KEY]).profiles).toHaveLength(1);
  });

  it('осознанная правка списка снимок всё-таки перезаписывает', async () => {
    await bootWith(NEWER);
    await profileManager.addProfile('Второй');
    // Человек уже действовал: хранить прежнее незачем, иначе новый профиль
    // пропал бы при следующем запуске.
    const now = JSON.parse(secure.__store[STATE_KEY]);
    expect(now.v).toBe(1);
    expect(now.profiles.map((p: { name: string }) => p.name)).toEqual(['Личный', 'Второй']);
  });
});

describe('удаление профиля отпускает его имя в реестре', () => {
  it('имя отпускают, и именно у удаляемого профиля', async () => {
    await bootWith(GOOD);
    // v4.32.741: ответ — исход, а не «да/нет»; здесь важно, что он успешный и
    // без остатков: уборки замоканы удачными.
    const res = await profileManager.deleteProfile(1);
    expect(res).toEqual({ removed: true, leftovers: [] });
    // Не активного (2), а того, кого удалили.
    expect(released).toEqual([1]);
  });

  it('несуществующий профиль ничего не отпускает', async () => {
    await bootWith(GOOD);
    const res = await profileManager.deleteProfile(77);
    expect(res).toEqual({ removed: false, reason: 'not_found' });
    expect(released).toEqual([]);
  });

  it('единственный профиль не удаляется — и имя остаётся за ним', async () => {
    await bootWith(null);
    await expect(profileManager.deleteProfile(1)).rejects.toThrow(/единственный/);
    expect(released).toEqual([]);
  });
});
