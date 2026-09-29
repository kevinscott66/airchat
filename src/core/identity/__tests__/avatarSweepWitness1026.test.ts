/**
 * Несостоявшаяся уборка аватаров больше не выдаётся за удалённое лицо
 * (v4.32.1026).
 *
 * ДЕФЕКТ. `sweepOrphanedAvatars` звала `sweepAvatarFiles(keep)`, ответ
 * выбрасывала и отвечала `true`. А `sweepAvatarFiles` не бросает никогда:
 * непрочитанный каталог у неё `return 0`, неудавшееся удаление файла — строка
 * в журнале и следующий файл. То есть «убрал» значило ровно «дошёл до конца
 * цикла».
 *
 * ЦЕНА. `'avatars'` не попадал в `leftovers`, и ProfileSelector печатал
 * зелёное «Профиль удалён» вместо своей же честной фразы «Профиль удалён, но
 * часть его файлов стереть не вышло — они остались на устройстве». А в
 * documentDirectory оставался `avatar_<время>.jpg` — снимок лица удалённого
 * аккаунта, незашифрованный. Повторить удаление нечем: строки профиля больше
 * нет, зайти в него нельзя, фоновой уборки для таких файлов не существует.
 * Профиль удаляют ровно затем, чтобы этого на телефоне не осталось, — и
 * телефон отдают, продают, теряют.
 *
 * ПРАВКА. После уборки спрашивается честный свидетель `survivingAvatarFiles`
 * (v4.32.1018) — тот самый, что уже стоит на сбросе кошелька. Он отличает
 * непрочитанный каталог от пустого: первый отвечает «осталось». Осталось хоть
 * что-то — уборка считается несостоявшейся.
 *
 * ГРАНИЦЫ. Аватары живых профилей остатком не считаются: свидетеля спрашивают
 * тем же списком `keep`, что и уборку. Укороченный снимок профилей по-прежнему
 * не пускает уборку вовсе (v4.32.741), и это по-прежнему остаток.
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

jest.mock('../usernameRegistry', () => ({
  releaseOwnUsernameGlobally: jest.fn(async () => undefined),
}));
jest.mock('../../storage/local', () => ({
  deleteProfileDataFromLocalDb: jest.fn(async () => undefined),
  kvSet: jest.fn(async () => undefined),
}));
jest.mock('../../social/composeDraft', () => ({
  deleteLegacyComposeDraft: jest.fn(async () => undefined),
}));
jest.mock('../../social/feedService', () => ({
  cleanupFeedStorageForProfile: jest.fn(async () => undefined),
}));
jest.mock('../../storage/dialogBackup', () => ({
  deleteDialogBackupForProfile: jest.fn(async () => undefined),
}));
jest.mock('../../social/storyAlbums', () => ({
  sweepOrphanAlbumFiles: jest.fn(async () => true),
}));
jest.mock('../../social/liveLocationService', () => ({ stopAllLiveLocSessions: jest.fn() }));

/** Что сохранить: сюда кладёт ответ collectAvatarsToKeep. */
const mockKeep = new Set<string>(['avatar_2.jpg']);
jest.mock('../avatarKeep', () => ({ collectAvatarsToKeep: jest.fn(async () => mockKeep) }));

/** Что осталось на диске после уборки — ответ честного свидетеля. */
let mockSurviving: string[] = [];
/** Списки, которыми звали уборку и свидетеля: сверяются между собой. */
const mockSweptWith: unknown[] = [];
const mockVerifiedWith: unknown[] = [];

jest.mock('../../media/avatarFiles', () => ({
  // Уборка отвечает числом и не бросает НИКОГДА — ни на непрочитанном
  // каталоге, ни на неудавшемся удалении. В этом и была беда.
  sweepAvatarFiles: jest.fn(async (keep: unknown) => {
    mockSweptWith.push(keep);
    return 0;
  }),
  survivingAvatarFiles: jest.fn(async (keep: unknown) => {
    mockVerifiedWith.push(keep);
    return mockSurviving;
  }),
}));

import fs from 'fs';
import path from 'path';

import { profileManager } from '../profileManager';

const STATE_KEY = 'airchat_profiles_state_v1';
const secure = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string>;
};
const avatarKeep = jest.requireMock('../avatarKeep') as { collectAvatarsToKeep: jest.Mock };

const rows = [
  { id: 1, derivationIndex: 0, name: 'Личный', createdAt: 1, lastUsed: 2 },
  { id: 2, derivationIndex: 1, name: 'Рабочий', createdAt: 3, lastUsed: 4 },
];

const GOOD = JSON.stringify({
  v: 1,
  activeProfileId: 2,
  nextProfileId: 3,
  nextDerivationIndex: 2,
  profiles: rows,
});

/** Тот же снимок, но одна строка испорчена: список профилей короче настоящего. */
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
  mockSurviving = [];
  mockSweptWith.length = 0;
  mockVerifiedWith.length = 0;
  avatarKeep.collectAvatarsToKeep.mockClear();
  avatarKeep.collectAvatarsToKeep.mockImplementation(async () => mockKeep);
});

describe('уборка отчитывается по диску, а не по концу цикла', () => {
  it('каталог не перечитался — это не «лицо стёрто»', async () => {
    await bootWith(GOOD);
    // Ровно то, чем отвечает survivingAvatarFiles на отказ readDirectoryAsync.
    mockSurviving = ['<каталог не перечитан>'];

    expect(await profileManager.deleteProfile(1)).toEqual({
      removed: true,
      leftovers: ['avatars'],
    });
  });

  it('файл не удалился — остаток назван, хотя уборка дошла до конца', async () => {
    await bootWith(GOOD);
    mockSurviving = ['avatar_1700000000000.jpg'];

    expect(await profileManager.deleteProfile(1)).toEqual({
      removed: true,
      leftovers: ['avatars'],
    });
  });

  it('свидетеля спрашивают после уборки, а не вместо неё', async () => {
    await bootWith(GOOD);
    mockSurviving = ['avatar_1700000000000.jpg'];
    await profileManager.deleteProfile(1);

    expect(mockSweptWith).toHaveLength(1);
    expect(mockVerifiedWith).toHaveLength(1);
  });

  it('ГРАНИЦА: спрашивают тем же списком — лицо живого профиля не остаток', async () => {
    await bootWith(GOOD);
    await profileManager.deleteProfile(1);

    expect(mockVerifiedWith[0]).toBe(mockSweptWith[0]);
    expect(mockVerifiedWith[0]).toBe(mockKeep);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: чистая уборка остаётся чистой', () => {
  it('на диске не осталось ничего — профиль просто удалён', async () => {
    await bootWith(GOOD);

    expect(await profileManager.deleteProfile(1)).toEqual({ removed: true, leftovers: [] });
    expect(profileManager.getProfileIds()).toEqual([2]);
  });

  it('список «оставить» не собрался — остаток, как и до правки', async () => {
    await bootWith(GOOD);
    avatarKeep.collectAvatarsToKeep.mockImplementation(async () => {
      throw new Error('keychain_locked');
    });

    expect(await profileManager.deleteProfile(1)).toEqual({
      removed: true,
      leftovers: ['avatars'],
    });
    expect(mockSweptWith).toHaveLength(0);
  });

  it('снимок недосчитался строки — уборки нет, свидетеля тоже нет', async () => {
    await bootWith(TRUNCATED);

    expect(await profileManager.deleteProfile(1)).toEqual({
      removed: true,
      leftovers: ['avatars'],
    });
    expect(mockSweptWith).toHaveLength(0);
    expect(mockVerifiedWith).toHaveLength(0);
  });
});

const read = (...p: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...p), 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const FILES = codeOnly(read('core', 'media', 'avatarFiles.ts'));
const MANAGER = codeOnly(read('core', 'identity', 'profileManager.ts'));
const SELECTOR = codeOnly(read('ui', 'components', 'ProfileSelector.tsx'));
const WIPE = codeOnly(read('core', 'wallet', 'wipeLocalWallet.ts'));

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('уборка молчит по замыслу: отказ каталога — ноль, отказ удаления — журнал', () => {
    const at = FILES.indexOf('export async function sweepAvatarFiles(');
    expect(at).toBeGreaterThan(0);
    const body = FILES.slice(at, FILES.indexOf('\n}', at));
    expect(body).toContain("log.warn('avatar_sweep_scan_failed'");
    expect(body).toContain('return 0;');
    expect(body).toContain("log.warn('avatar_delete_failed'");
    // Ни одного `throw`: узнать об отказе по броску нельзя в принципе.
    expect(body).not.toContain('throw');
  });

  it('честный свидетель уже есть и непрочитанный каталог считает остатком', () => {
    const at = FILES.indexOf('export async function survivingAvatarFiles(');
    expect(at).toBeGreaterThan(0);
    const body = FILES.slice(at, FILES.indexOf('\n}', at));
    expect(body).toContain("return ['<каталог не перечитан>'];");
  });

  it('образец рядом: сброс кошелька спрашивает того же свидетеля', () => {
    expect(WIPE).toContain("{ name: 'avatars', left: () => survivingAvatarFiles([])");
  });

  it('экран различает «удалён» и «удалён, но файлы остались»', () => {
    const at = SELECTOR.indexOf('if (result.leftovers.length > 0) {');
    expect(at).toBeGreaterThan(0);
    const body = SELECTOR.slice(at, at + 400);
    expect(body).toContain(
      "showError('Профиль удалён, но часть его файлов стереть не вышло — они остались на устройстве');",
    );
    expect(SELECTOR.indexOf("showSuccess('Профиль удалён');")).toBeGreaterThan(at);
  });

  it('соседняя уборка отвечает «да/нет», и её ответ читают', () => {
    // v4.32.991 закрыл ровно это у копий историй; аватары остались.
    expect(MANAGER).toContain('if (!(await sweepOrphanAlbumFiles())) leftovers.push(');
    expect(MANAGER).toContain("if (!(await this.sweepOrphanedAvatars())) leftovers.push('avatars');");
  });
});

describe('ЗАКРЕПКА: ответ уборки аватаров не выбрасывается', () => {
  it('sweepOrphanedAvatars перечитывает диск и отвечает по нему', () => {
    const at = MANAGER.indexOf('private async sweepOrphanedAvatars(');
    expect(at).toBeGreaterThan(0);
    const body = MANAGER.slice(at, MANAGER.indexOf('\n  }', at));
    expect(body).toContain('survivingAvatarFiles');
    expect(body).not.toContain('await sweepAvatarFiles(keep);\n      return true;');
  });
});
