/**
 * Урезанный список профилей перестал выдаваться за полный (v4.32.1074).
 *
 * ДЕФЕКТ. Лист «Мои профили» строился одной строкой:
 * `setProfiles(profileManager.getAllProfiles())`. А `getAllProfiles` отдаёт
 * массив и тогда, когда снимок с диска принят НЕ ЦЕЛИКОМ: часть строк не
 * прошла проверку (v4.32.196) — они выброшены; снимок не разобрался вовсе —
 * на его месте один профиль по умолчанию. Ядро обе беды знает и называет
 * словом: `getProfileIdsComplete().complete === false` (v4.32.704), и четыре
 * места в ядре его уже спрашивают. Лист — единственное место, где по списку
 * действует человек, — не спрашивал.
 *
 * ЦЕНА. Пропавшая строка читается как «профиль удалён». Счётчик под списком
 * говорил «Занято 1 из 4» — то есть звал завести заново. Заведённый заново
 * профиль получает следующий `derivationIndex`, то есть ДРУГОЙ адрес: старые
 * переписки к нему не привяжутся. Сверх того, создание пишет состояние
 * целиком, и урезанный список ложится поверх снимка — после этого пропавшие
 * строки не вернутся и после перезапуска.
 *
 * ПРАВКА. Правило вынесено в модуль без импортов и говорит три вещи: что
 * сказать над списком, как подписать счётчик и звать ли заводить профиль.
 *
 * ГРАНИЦЫ. Запись в ядре не тронута: v4.32.731 осознанную правку списка
 * пишет как обычно, и отменять решение человека лист не берётся — он лишь
 * перестаёт звать к нему вслепую. Прежний предел в 4 профиля цел, кнопка
 * «Удалить» при единственной строке по-прежнему скрыта.
 */
jest.mock('../../storage/secureStoreQueued', () => {
  const store: Record<string, string> = {};
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store[key] ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { store[key] = value; }),
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
jest.mock('../avatarKeep', () => ({ collectAvatarsToKeep: jest.fn(async () => new Set<string>()) }));
jest.mock('../../media/avatarFiles', () => ({
  sweepAvatarFiles: jest.fn(async () => undefined),
  survivingAvatarFiles: jest.fn(async () => []),
}));
jest.mock('../../social/storyAlbums', () => ({
  sweepOrphanAlbumFiles: jest.fn(async () => true),
}));
jest.mock('../../social/liveLocationService', () => ({ stopAllLiveLocSessions: jest.fn() }));

import { readFileSync } from 'fs';
import { join } from 'path';

import { profileManager } from '../profileManager';
import {
  mayCreateProfile,
  profileCreateBlockedText,
  profileListNotice,
  profileSlotsText,
} from '../profileListNotice';

const STATE_KEY = 'airchat_profiles_state_v1';
const secure = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string>;
};

/** Оба профиля целы. */
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

/** Второй профиль не проходит проверку строки — снимок принят не целиком. */
const TRUNCATED = JSON.stringify({
  v: 1,
  activeProfileId: 1,
  nextProfileId: 3,
  nextDerivationIndex: 2,
  profiles: [
    { id: 1, derivationIndex: 0, name: 'Личный', createdAt: 1, lastUsed: 2 },
    { id: 2, derivationIndex: -1, name: 'Рабочий', createdAt: 3, lastUsed: 4 },
  ],
});

async function boot(raw: string): Promise<void> {
  await profileManager.clearForWalletWipe();
  for (const k of Object.keys(secure.__store)) delete secure.__store[k];
  secure.__store[STATE_KEY] = raw;
  await profileManager.init();
}

const SRC = join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
const SELECTOR = codeOnly(read('ui', 'components', 'ProfileSelector.tsx'));

describe('неполный список назван словами', () => {
  const short = { shown: 1, max: 4, complete: false };
  const full = { shown: 1, max: 4, complete: true };

  test('над списком появляется предупреждение, и только при неполном', () => {
    expect(profileListNotice(full)).toBeNull();
    const notice = profileListNotice(short);
    expect(notice).toContain('неполный');
    // Три вещи, ради которых он и написан.
    expect(notice).toContain('не удалены');
    expect(notice).toContain('не создавайте их заново');
    expect(notice).toContain('другой адрес');
  });

  test('счётчик слотов при неполном списке — нижняя граница, и сказано словом', () => {
    expect(profileSlotsText(full)).toBe('Занято 1 из 4');
    expect(profileSlotsText(short)).toContain('не меньше 1 из 4');
    expect(profileSlotsText(short)).toContain('список неполный');
  });

  test('заводить профиль вслепую лист не предлагает', () => {
    expect(mayCreateProfile(full)).toBe(true);
    expect(mayCreateProfile(short)).toBe(false);
    expect(profileCreateBlockedText(short)).toContain('стёрла бы');
  });

  test('ГРАНИЦА: прежний предел в 4 профиля цел и назван прежними словами', () => {
    const atLimit = { shown: 4, max: 4, complete: true };
    expect(mayCreateProfile(atLimit)).toBe(false);
    expect(profileCreateBlockedText(atLimit)).toBe(
      'Достигнут лимит профилей на устройстве: 4.\nУдалите один из существующих, чтобы создать новый.'
    );
    expect(profileCreateBlockedText({ shown: 3, max: 4, complete: true })).toBeNull();
  });

  test('ГРАНИЦА: неполнота перевешивает свободные слоты, а не наоборот', () => {
    expect(mayCreateProfile({ shown: 0, max: 4, complete: false })).toBe(false);
    expect(profileCreateBlockedText({ shown: 4, max: 4, complete: false })).toContain('неполный');
  });
});

describe('лист спрашивает ядро о полноте', () => {
  test('состояние полноты читается там же, где список', () => {
    expect(SELECTOR).toContain('setProfiles(profileManager.getAllProfiles());');
    expect(SELECTOR).toContain(
      'setListComplete(profileManager.getProfileIdsComplete().complete);'
    );
    expect(SELECTOR).toContain(
      'const listFacts = { shown: profiles.length, max: MAX_PROFILES, complete: listComplete };'
    );
  });

  test('все три ответа модуля дошли до разметки', () => {
    expect(SELECTOR).toContain(
      '{listNotice ? <Text style={styles.limitNote}>{listNotice}</Text> : null}'
    );
    expect(SELECTOR).toContain('{!mayCreateProfile(listFacts) ? (');
    expect(SELECTOR).toContain(
      '<Text style={styles.limitNote}>{profileCreateBlockedText(listFacts)}</Text>'
    );
    expect(SELECTOR).toContain('<Text style={styles.slotsCounter}>{profileSlotsText(listFacts)}</Text>');
    // Прежний счётчик и прежнее условие показа формы ушли целиком: иначе на
    // экране остались бы два правила про одно и то же.
    expect(SELECTOR).not.toContain('Занято {profiles.length} из {MAX_PROFILES}');
    expect(SELECTOR).not.toContain('{profiles.length >= MAX_PROFILES ? (');
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: остальное на листе не тронуто', () => {
    // Предупреждение стоит НАД списком — человек читает его до того, как
    // решит, что профиля нет.
    expect(SELECTOR.indexOf('{listNotice ?')).toBeLessThan(
      SELECTOR.indexOf('{profiles.map((profile) => (')
    );
    // Кнопка «Удалить» при единственной строке по-прежнему скрыта.
    expect(SELECTOR).toContain('{profiles.length > 1 ? (');
    // Переключение и переименование не трогали.
    expect(SELECTOR).toContain('switched = await profileManager.switchProfile(profile.id);');
    expect(SELECTOR).toContain('await profileManager.addProfile(newProfileName.trim());');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  test('ПРОВЕРКА НЕ ПУСТАЯ: целый снимок даёт полный список', async () => {
    await boot(GOOD);
    expect(profileManager.getAllProfiles().map((p) => p.id)).toEqual([1, 2]);
    expect(profileManager.getProfileIdsComplete().complete).toBe(true);
  });

  test('getAllProfiles и правда отдаёт урезанный список без единого слова', async () => {
    await boot(TRUNCATED);
    // Профиль на устройстве есть, в списке его нет — и по самому списку это
    // никак не отличить от «его удалили».
    expect(profileManager.getAllProfiles().map((p) => p.id)).toEqual([1]);
    expect(profileManager.getProfileIdsComplete().complete).toBe(false);
  });

  test('и счётчик по такому списку соврал бы про свободные слоты', async () => {
    await boot(TRUNCATED);
    const shown = profileManager.getAllProfiles().length;
    expect(profileSlotsText({ shown, max: 4, complete: true })).toBe('Занято 1 из 4');
    expect(mayCreateProfile({ shown, max: 4, complete: false })).toBe(false);
  });

  test('ядро осознанную правку списка по-прежнему пишет как обычно (v4.32.731)', () => {
    const core = codeOnly(read('core', 'identity', 'profileManager.ts'));
    expect(core).toContain('await this.persistState({ keepDiskSnapshot: this.snapshotIncomplete });');
    // Отдельного отказа в создании ядро не завело: решение человека лист не
    // отменяет, он лишь перестаёт звать к нему вслепую.
    expect(core).not.toContain('snapshotIncomplete) {\n      log.warn(\'add_profile_refused');
  });
});
