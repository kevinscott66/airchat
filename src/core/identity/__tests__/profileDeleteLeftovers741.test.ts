/**
 * «Профиль удалён» не говорится, пока его данные лежат на устройстве.
 *
 * v4.32.741. Строка профиля вычёркивалась из списка и записывалась на диск
 * ПЕРВОЙ, а шесть уборок шли следом, и каждая была обёрнута в
 * `try/catch { log.warn }`. Функция после этого отвечала `true` безусловно, и
 * экран говорил «Профиль удалён».
 *
 * Отказ любой уборки — заблокированная база (SQLite lock от живого запроса
 * UI), нехватка места, сбой файловой системы — означал, что переписка, копия
 * диалогов, лента, файлы историй и снимок лица остаются на устройстве. Узнать
 * об этом было нельзя ничем: из списка профиль исчез, зайти в него нечем,
 * повторить удаление невозможно (строки нет, `idx === -1`), фоновой уборки для
 * таких остатков не существует. Удаляют профиль ровно затем, чтобы этого на
 * телефоне не осталось, — и телефон отдают, продают, теряют.
 *
 * Теперь уборки, бьющие по номеру профиля, идут ДО вычёркивания строки и гасят
 * удаление; две уборки «от живых» (аватары, копии историй) иначе не умеют —
 * они идут следом и об отказе сообщают отдельно.
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

/**
 * Какая уборка на этом прогоне откажет, и что каждая успела увидеть.
 *
 * `mockSawProfiles` — список профилей на момент вызова уборки: им проверяется
 * главное, порядок. Уборка, которую позвали после вычёркивания строки, работает
 * с номером, которого в списке уже нет, и отменить ничего не может.
 */
const mockFailing = new Set<string>();
const mockCalls: string[] = [];
const mockSawProfiles: Record<string, number[]> = {};

function mockStep(name: string): void {
  mockCalls.push(name);
  mockSawProfiles[name] = mockMgrRef.mgr?.getProfileIds() ?? [];
  if (mockFailing.has(name)) throw new Error(`${name}_failed`);
}

/** Ссылка на менеджер: уборки зовут его же, а импорт ниже — после jest.mock. */
const mockMgrRef: { mgr: { getProfileIds(): number[] } | null } = { mgr: null };

const mockReleased: number[] = [];
jest.mock('../usernameRegistry', () => ({
  releaseOwnUsernameGlobally: jest.fn(async (profileId: number) => {
    mockReleased.push(profileId);
  }),
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

import { profileManager } from '../profileManager';

mockMgrRef.mgr = profileManager;

const STATE_KEY = 'airchat_profiles_state_v1';
const secure = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string>;
};
const avatarFiles = jest.requireMock('../../media/avatarFiles') as { sweepAvatarFiles: jest.Mock };

const rows = [
  { id: 1, derivationIndex: 0, name: 'Личный', createdAt: 1, lastUsed: 2 },
  { id: 2, derivationIndex: 1, name: 'Рабочий', createdAt: 3, lastUsed: 4 },
];

/** Исправный снимок из двух профилей, активен второй. */
const GOOD = JSON.stringify({
  v: 1,
  activeProfileId: 2,
  nextProfileId: 3,
  nextDerivationIndex: 2,
  profiles: rows,
});

/**
 * Тот же снимок, но одна строка испорчена: разбор её отбрасывает и поднимает
 * `snapshotIncomplete`. Список профилей после этого короче настоящего.
 */
const TRUNCATED = JSON.stringify({
  v: 1,
  activeProfileId: 2,
  nextProfileId: 4,
  nextDerivationIndex: 3,
  profiles: [...rows, { id: 3, name: 'Третий', createdAt: 5, lastUsed: 6 }],
});

async function bootWith(raw: string): Promise<void> {
  await profileManager.clearForWalletWipe();
  for (const k of Object.keys(secure.__store)) delete secure.__store[k];
  secure.__store[STATE_KEY] = raw;
  await profileManager.init();
}

beforeEach(() => {
  mockFailing.clear();
  mockCalls.length = 0;
  mockReleased.length = 0;
  for (const k of Object.keys(mockSawProfiles)) delete mockSawProfiles[k];
  avatarFiles.sweepAvatarFiles.mockClear();
});

describe('уборки идут до вычёркивания строки', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: обычное удаление уносит строку и зовёт все уборки', async () => {
    await bootWith(GOOD);
    await profileManager.deleteProfile(1);
    expect(profileManager.getProfileIds()).toEqual([2]);
    expect(mockCalls).toEqual(['localDb', 'composeDraft', 'feed', 'dialogBackup', 'avatars', 'albums']);
  });

  it('каждая уборка по номеру профиля видит его ещё в списке', async () => {
    await bootWith(GOOD);
    await profileManager.deleteProfile(1);
    // Иначе отменять нечего: уборка не удалась, а строки уже нет.
    for (const name of ['localDb', 'composeDraft', 'feed', 'dialogBackup']) {
      expect(mockSawProfiles[name]).toContain(1);
    }
  });

  it('уборки «от живых» идут уже без него: свои файлы иначе выглядели бы нужными', async () => {
    await bootWith(GOOD);
    await profileManager.deleteProfile(1);
    expect(mockSawProfiles.avatars).toEqual([2]);
    expect(mockSawProfiles.albums).toEqual([2]);
  });
});

describe('неубранные данные не выдаются за удалённый профиль', () => {
  it('отказ уборки оставляет профиль на месте и говорит об этом', async () => {
    await bootWith(GOOD);
    mockFailing.add('dialogBackup');
    const res = await profileManager.deleteProfile(1);
    expect(res).toEqual({ removed: false, reason: 'cleanup_failed', err: 'dialogBackup_failed' });
    expect(profileManager.getProfileIds()).toEqual([1, 2]);
  });

  it('после отказа удаление можно повторить — и оно доводится до конца', async () => {
    await bootWith(GOOD);
    mockFailing.add('localDb');
    expect((await profileManager.deleteProfile(1)).removed).toBe(false);
    mockFailing.clear();
    expect(await profileManager.deleteProfile(1)).toEqual({ removed: true, leftovers: [] });
    expect(profileManager.getProfileIds()).toEqual([2]);
  });

  it('отказ первой уборки не запускает следующие: строка ещё нужна целой', async () => {
    await bootWith(GOOD);
    mockFailing.add('localDb');
    await profileManager.deleteProfile(1);
    expect(mockCalls).toEqual(['localDb']);
  });

  it('удаляют активный профиль — при отказе он тоже остаётся в списке', async () => {
    await bootWith(GOOD);
    mockFailing.add('feed');
    const res = await profileManager.deleteProfile(2);
    expect(res).toEqual({ removed: false, reason: 'cleanup_failed', err: 'feed_failed' });
    expect(profileManager.getProfileIds()).toEqual([1, 2]);
    // Активность увести пришлось: пока профиль активен, его базу держат
    // открытой и уборка упрётся в замок. Данные при этом на месте.
    expect(profileManager.getActiveProfile()?.id).toBe(1);
  });

  it('«такой строки нет» — это не «не убралось»: причины разные', async () => {
    await bootWith(GOOD);
    expect(await profileManager.deleteProfile(77)).toEqual({ removed: false, reason: 'not_found' });
    expect(mockCalls).toEqual([]);
  });
});

describe('оставшиеся файлы названы, а не проглочены', () => {
  it('не убрались аватары — профиль удалён, но об остатке сказано', async () => {
    await bootWith(GOOD);
    mockFailing.add('avatars');
    expect(await profileManager.deleteProfile(1)).toEqual({ removed: true, leftovers: ['avatars'] });
    expect(profileManager.getProfileIds()).toEqual([2]);
  });

  it('не убрались копии историй — то же самое, и одно другому не мешает', async () => {
    await bootWith(GOOD);
    mockFailing.add('avatars');
    mockFailing.add('albums');
    expect(await profileManager.deleteProfile(1)).toEqual({
      removed: true,
      leftovers: ['avatars', 'albums'],
    });
  });
});

describe('уборка аватаров не идёт по укороченному списку', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: на целом снимке уборка файлов вызывается', async () => {
    await bootWith(GOOD);
    await profileManager.deleteProfile(1);
    expect(avatarFiles.sweepAvatarFiles).toHaveBeenCalled();
  });

  it('снимок недосчитался строки — ни один файл не трогается', async () => {
    await bootWith(TRUNCATED);
    // Урезанный список неотличим от «этих аватаров больше нет»: уборка снесла
    // бы лицо живого профиля, которого разбор не досчитался.
    const res = await profileManager.deleteProfile(1);
    expect(avatarFiles.sweepAvatarFiles).not.toHaveBeenCalled();
    expect(res).toEqual({ removed: true, leftovers: ['avatars'] });
  });
});
