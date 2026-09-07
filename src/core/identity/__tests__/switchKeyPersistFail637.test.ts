/**
 * Отказ записи ключа не должен оставлять устройство между двумя личностями.
 *
 * v4.32.637. switchProfile сначала записывает новый номер профиля в состояние,
 * а уже потом кладёт ключ этого профиля в SecureStore. Второй шаг звали без
 * try: исключение улетало вызывающему, а состояние оставалось переписанным.
 * Дальше расходилось всё: getActiveIdentity отвечал новым профилем, ключ на
 * устройстве оставался старым, onIdentityUpdated никто не звал — службы
 * продолжали работать под прежней личностью. Это ровно то расхождение «кто я»,
 * которое v4.32.480 закрыла ВНУТРИ метода, только вылезшее на уровень
 * приложения.
 *
 * То же у addProfile: человеку показывали «Ошибка создания», а профиль был
 * создан, объявлен активным и подписывал бы сообщения ключом предыдущего.
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

jest.mock('../../crypto/keyManager', () => {
  let fail = false;
  return {
    __setKeyFail: (v: boolean) => { fail = v; },
    loadKeyPair: jest.fn(async () => null),
    persistKeyPair: jest.fn(async () => {
      if (fail) throw new Error('secure store unavailable');
    }),
  };
});

jest.mock('../../backup/seedPhrase', () => ({
  getStoredMnemonic: jest.fn(async () => 'слово '.repeat(12).trim()),
  deriveKeyPairFromMnemonicForProfile: jest.fn((_m: string, idx: number) => ({
    publicKey: Uint8Array.from([idx, 200, 201]),
    secretKey: Uint8Array.from([idx, 100, 101]),
  })),
}));

jest.mock('../did', () => ({
  publicKeyToDidKey: (pub: Uint8Array) => `did:key:z${pub[0]}`,
}));

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../storage/dekDerivation', () => ({
  bytesEqualConstTime: (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { profileManager } from '../profileManager';

const secure = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string>;
};
const keys = jest.requireMock('../../crypto/keyManager') as {
  __setKeyFail: (v: boolean) => void;
};

const STATE_KEY = 'airchat_profiles_state_v1';
const managerSrc = readFileSync(join(__dirname, '..', 'profileManager.ts'), 'utf8');
const selectorSrc = readFileSync(
  join(__dirname, '..', '..', '..', 'ui', 'components', 'ProfileSelector.tsx'),
  'utf8',
);
/** Комментарии не должны подсказывать ответ на not.toContain. */
const stripComments = (s: string): string => s.replace(/^\s*\/\/.*$/gm, '');

function seedState(): void {
  secure.__store[STATE_KEY] = JSON.stringify({
    v: 1,
    activeProfileId: 1,
    nextProfileId: 3,
    nextDerivationIndex: 2,
    profiles: [
      { id: 1, derivationIndex: 0, name: 'Личный', createdAt: 1, lastUsed: 2 },
      { id: 2, derivationIndex: 1, name: 'Рабочий', createdAt: 3, lastUsed: 4 },
    ],
  });
}

/** Что записано на диск прямо сейчас. */
function persisted(): { activeProfileId: number; profiles: { id: number }[] } {
  return JSON.parse(secure.__store[STATE_KEY]);
}

beforeEach(async () => {
  for (const k of Object.keys(secure.__store)) delete secure.__store[k];
  keys.__setKeyFail(false);
  seedState();
  await profileManager.init();
  await profileManager.switchProfile(1);
});

afterEach(() => {
  keys.__setKeyFail(false);
});

describe('отказ записи ключа не оставляет две личности сразу', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: при удачной записи ключа переключение состоялось', async () => {
    const got = await profileManager.switchProfile(2);
    expect(got?.id).toBe(2);
    expect(profileManager.getActiveProfile()?.id).toBe(2);
    expect(persisted().activeProfileId).toBe(2);
    // Ключ выдаёт индекс деривации: 2 → 1.
    expect(profileManager.getActiveKeyPair().publicKey[0]).toBe(1);
  });

  it('не лёг ключ — профиль остался прежним и в памяти, и на диске', async () => {
    keys.__setKeyFail(true);
    const got = await profileManager.switchProfile(2);
    // null единственный вызывающий (ProfileSelector) показывать умеет.
    expect(got).toBeNull();
    expect(profileManager.getActiveProfile()?.id).toBe(1);
    expect(persisted().activeProfileId).toBe(1);
    // Главное: ключ отвечает тем же профилем, что и состояние.
    expect(profileManager.getActiveKeyPair().publicKey[0]).toBe(0);
  });

  it('после сорванного переключения следующее проходит нормально', async () => {
    keys.__setKeyFail(true);
    await profileManager.switchProfile(2);
    keys.__setKeyFail(false);
    const got = await profileManager.switchProfile(2);
    expect(got?.id).toBe(2);
    expect(persisted().activeProfileId).toBe(2);
  });

  // profileManager — модульный синглтон: init() поднимает состояние один раз, и
  // созданные профили живут до конца файла. Отсюда счёт «сколько было» вместо
  // абсолютных длин, разные имена у каждого теста (совпадение имён отклонили бы
  // ДО записи ключа, и проверка прошла бы вхолостую) и не больше двух созданий
  // на файл при MAX_PROFILES = 4.
  it('ПРОВЕРКА НЕ ПУСТАЯ: при удачной записи ключа профиль создаётся', async () => {
    const before = profileManager.getAllProfiles().length;
    const made = await profileManager.addProfile('Контрольный');
    expect(made.name).toBe('Контрольный');
    expect(profileManager.getAllProfiles()).toHaveLength(before + 1);
    expect(profileManager.getActiveProfile()?.id).toBe(made.id);
    expect(persisted().profiles).toHaveLength(before + 1);
  });

  it('не лёг ключ — созданного профиля нет ни в списке, ни на диске', async () => {
    const before = profileManager.getAllProfiles().length;
    const activeBefore = profileManager.getActiveProfile()?.id;
    keys.__setKeyFail(true);
    // Именно отказ записи ключа, а не отсев по имени или по лимиту.
    await expect(profileManager.addProfile('Сорванный')).rejects.toThrow(
      'secure store unavailable',
    );
    expect(profileManager.getAllProfiles()).toHaveLength(before);
    expect(profileManager.getActiveProfile()?.id).toBe(activeBefore);
    expect(persisted().profiles).toHaveLength(before);
    expect(persisted().activeProfileId).toBe(activeBefore);
  });

  it('номер сорванного профиля больше не выдаётся', async () => {
    keys.__setKeyFail(true);
    await expect(profileManager.addProfile('Погоревший')).rejects.toThrow(
      'secure store unavailable',
    );
    const burned = profileManager.getAllProfiles();
    keys.__setKeyFail(false);
    const made = await profileManager.addProfile('Следующий');
    // Сжечь номер дешевле, чем выдать его дважды: под старым могли остаться
    // записи в базе, которые достались бы новому профилю.
    expect(burned.some((p) => p.id === made.id)).toBe(false);
    expect(made.id).toBeGreaterThan(Math.max(...burned.map((p) => p.id)) + 1);
  });
});

describe('уборка удалённого профиля не срывается из-за ключа', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: запись ключа в deleteProfile вообще есть', () => {
    const at = managerSrc.indexOf('async deleteProfile(');
    expect(at).toBeGreaterThan(0);
    expect(managerSrc.slice(at, at + 3000)).toContain('await persistKeyPair(pair)');
  });

  it('запись ключа обёрнута try, иначе уборка данных не состоится', () => {
    const at = managerSrc.indexOf('async deleteProfile(');
    const body = stripComments(managerSrc.slice(at, at + 3000));
    const call = body.indexOf('await persistKeyPair(pair)');
    expect(call).toBeGreaterThan(0);
    // Между открытием ветки активного профиля и записью ключа стоит try.
    const before = body.slice(0, call);
    expect(before.lastIndexOf('try {')).toBeGreaterThan(before.lastIndexOf('if (active) {'));
    expect(body.slice(call, call + 400)).toContain('delete_profile_key_persist_failed');
  });
});

describe('лист профилей показывает отказ, а не молчит', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: handleSwitch вообще зовёт switchProfile', () => {
    const at = selectorSrc.indexOf('const handleSwitch =');
    expect(at).toBeGreaterThan(0);
    expect(selectorSrc.slice(at, at + 1200)).toContain('profileManager.switchProfile(profile.id)');
  });

  it('исключение switchProfile попадает в showError, а не в пустой промис', () => {
    const at = selectorSrc.indexOf('const handleSwitch =');
    const body = stripComments(selectorSrc.slice(at, at + 1200));
    const call = body.indexOf('await profileManager.switchProfile(profile.id)');
    expect(body.slice(0, call).lastIndexOf('try {')).toBeGreaterThan(-1);
    expect(body.slice(call, call + 400)).toContain('showError(userErrorText(error,');
  });
});
