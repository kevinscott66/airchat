/**
 * Непрочитанный признак биометрии не выдаётся за «выключено» (v4.32.1062).
 *
 * ДЕФЕКТ. `isBiometricUnlockEnabled` читала незапертую запись «включено» и на
 * любое исключение отвечала `false` — тем же словом, что и «выключено», и без
 * единой строки в журнале. Договор хранилища при этом проговорён в нём самом
 * (`secureStoreQueued`): «нет записи» — это `null`, «не читается» —
 * исключение. Третий исход существовал по проекту и терялся ровно здесь.
 *
 * ЦЕНА. Под замком лежит САМ пароль приложения, и оба вызывающих принимают
 * `false` за «копии на устройстве нет».
 *
 *   - `authGuard.setPassword` пропускал перешифровку целиком. На диске
 *     оставались признак «включено» и ПРЕЖНИЙ пароль, а экран настроек
 *     говорил «Пароль обновлён». Дальше на экране блокировки Face ID сам, без
 *     участия человека, отдавал этот пароль в `checkPassword`, и человек —
 *     приложив лицо и не набрав ни цифры — получал «Неверный пароль. Осталось
 *     попыток: N». Каждое открытие экрана тратило попытку из пяти, пятая
 *     приводила к пятнадцатиминутной блокировке. Защита v4.32.810
 *     (`auth_stale_biometric_secret_kept`) стояла в соседней ветке и в этом
 *     случае не срабатывала тоже.
 *   - экран настроек ставил переключатель в «выкл». Убрать копию пароля умеет
 *     только ветка выключения, а нажатие из «выкл» приходит как «включить» и
 *     уходило в противоположную сторону — открывало окно «введите пароль,
 *     чтобы включить». Выход исчезал и разворачивался; подсказка про «включите
 *     и выключите ещё раз» живёт в той самой недостижимой ветке.
 *
 * ПРАВКА. Ответ стал `boolean | null`. Смена пароля в незнании не
 * перезаписывает (положить копию пароля тому, кто не просил, нельзя), а
 * убирает — стирание идемпотентно, и терять там нечего, кроме удобства.
 * Экран настроек называет незнание вслух и ведёт нажатие в стирание. Экран
 * блокировки в незнании не поднимает системный запрос: клавиатура и есть
 * выход.
 *
 * ГРАНИЦЫ. Рабочее хранилище — прежнее поведение во всех трёх местах:
 * отсутствующий признак по-прежнему `false`, включённая биометрия по-прежнему
 * получает новый пароль, выключение работает как раньше.
 */
jest.mock('../../storage/secureStoreQueued', () => {
  const s: Record<string, string | undefined> = {};
  const broken = { readKeys: new Set<string>() };
  return {
    __store: s,
    __broken: broken,
    getItemAsync: jest.fn(async (key: string) => {
      if (broken.readKeys.has(key)) throw new Error('keychain busy');
      return s[key] ?? null;
    }),
    setItemAsync: jest.fn(async (key: string, value: string) => { s[key] = value; }),
    deleteItemAsync: jest.fn(async (key: string) => { delete s[key]; }),
  };
});

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  canUseBiometricAuthentication: jest.fn(() => true),
}));

jest.mock('../../logger', () => {
  const lines: string[] = [];
  const push = (tag: string): void => { lines.push(tag); };
  return {
    __lines: lines,
    log: { info: push, warn: push, debug: push, error: push },
  };
});

jest.mock('bip39', () => ({ validateMnemonic: jest.fn(() => true) }));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { init: jest.fn(async () => {}), getActiveProfile: jest.fn(() => null) },
}));
jest.mock('../../crypto/keyManager', () => ({ loadKeyPair: jest.fn(async () => null) }));
jest.mock('../../backup/seedPhrase', () => ({
  deriveKeyPairFromMnemonicForProfile: jest.fn(() => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  })),
}));

import fs from 'fs';
import path from 'path';

import { AuthGuard } from '../authGuard';
import {
  BIOMETRIC_SECURE_KEYS,
  disableBiometricUnlock,
  enableBiometricUnlock,
  isBiometricUnlockEnabled,
  readBiometricPassword,
} from '../biometricUnlock';

const store = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string | undefined>;
  __broken: { readKeys: Set<string> };
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};
const journal = (jest.requireMock('../../logger') as { __lines: string[] }).__lines;

const [SECRET_KEY, FLAG_KEY] = BIOMETRIC_SECURE_KEYS;

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** Только код: прозой закрепку не удовлетворить. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function freshGuard(): AuthGuard {
  // @ts-expect-error приватное статическое поле — ради изоляции теста
  AuthGuard.instance = undefined;
  return AuthGuard.getInstance();
}

beforeEach(() => {
  for (const k of Object.keys(store.__store)) delete store.__store[k];
  store.__broken.readKeys.clear();
  journal.length = 0;
  // Именно mockReset + новая реализация: подмена, заведённая внутри теста,
  // не должна пережить его падение и утечь в соседний.
  store.getItemAsync.mockReset();
  store.setItemAsync.mockReset();
  store.deleteItemAsync.mockReset();
  store.getItemAsync.mockImplementation(async (key: string) => {
    if (store.__broken.readKeys.has(key)) throw new Error('keychain busy');
    return store.__store[key] ?? null;
  });
  store.setItemAsync.mockImplementation(async (key: string, value: string) => { store.__store[key] = value; });
  store.deleteItemAsync.mockImplementation(async (key: string) => { delete store.__store[key]; });
});

describe('незнание про биометрию называется вслух', () => {
  it('отказ хранилища отвечает null, а не «выключено»', async () => {
    store.__broken.readKeys.add(FLAG_KEY);
    expect(await isBiometricUnlockEnabled()).toBeNull();
  });

  it('отказ хранилища виден в журнале', async () => {
    store.__broken.readKeys.add(FLAG_KEY);
    await isBiometricUnlockEnabled();
    expect(journal).toContain('biometric_flag_unreadable');
  });

  it('смена пароля не оставляет под биометрией ПРЕЖНИЙ пароль', async () => {
    await enableBiometricUnlock('старый1');
    expect(store.__store[SECRET_KEY]).toBe('старый1');
    store.__broken.readKeys.add(FLAG_KEY);

    expect(await freshGuard().setPassword('новый12')).toBe(true);

    // Главное: того, чем Face ID открывал бы приложение, на устройстве нет.
    expect(store.__store[SECRET_KEY]).toBeUndefined();
  });

  it('смена пароля в незнании оставляет след', async () => {
    await enableBiometricUnlock('старый1');
    store.__broken.readKeys.add(FLAG_KEY);
    await freshGuard().setPassword('новый12');
    expect(journal).toContain('auth_biometric_flag_unreadable');
  });

  it('копию не удалось снять — это отдельная строка, а не тишина', async () => {
    await enableBiometricUnlock('старый1');
    store.__broken.readKeys.add(FLAG_KEY);
    store.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === SECRET_KEY) throw new Error('user cancelled');
      delete store.__store[key];
    });
    await freshGuard().setPassword('новый12');
    expect(journal).toContain('auth_stale_biometric_secret_kept');
  });
});

describe('ГРАНИЦА: в незнании ничего лишнего не делается', () => {
  it('новую копию пароля не кладут — о ней никто не просил', async () => {
    store.__broken.readKeys.add(FLAG_KEY);
    await freshGuard().setPassword('новый12');
    expect(store.__store[SECRET_KEY]).toBeUndefined();
  });

  it('экран блокировки в незнании не поднимает системный запрос', async () => {
    // До правки ответ тоже был `null` — но по другой причине: `false`
    // означал «выключено». Поведение сохраняем намеренно, потому и ГРАНИЦА.
    await enableBiometricUnlock('старый1');
    store.__broken.readKeys.add(FLAG_KEY);
    store.getItemAsync.mockClear();
    expect(await readBiometricPassword()).toBeNull();
    const asked = (store.getItemAsync.mock.calls as Array<[string]>).map(([k]) => k);
    expect(asked).not.toContain(SECRET_KEY);
  });
});

describe('ГРАНИЦА: с рабочим хранилищем всё по-прежнему', () => {
  it('признака нет — это по-прежнему «выключено», а не незнание', async () => {
    expect(await isBiometricUnlockEnabled()).toBe(false);
  });

  it('включённая биометрия получает новый пароль', async () => {
    await enableBiometricUnlock('старый1');
    expect(await freshGuard().setPassword('новый12')).toBe(true);
    expect(store.__store[SECRET_KEY]).toBe('новый12');
    expect(await isBiometricUnlockEnabled()).toBe(true);
  });

  it('выключенную биометрию смена пароля не трогает', async () => {
    expect(await freshGuard().setPassword('новый12')).toBe(true);
    expect(store.__store[SECRET_KEY]).toBeUndefined();
    expect(store.__store[FLAG_KEY]).toBeUndefined();
  });

  it('выключение и чтение работают как раньше', async () => {
    await enableBiometricUnlock('старый1');
    expect(await readBiometricPassword()).toBe('старый1');
    expect(await disableBiometricUnlock()).toBe(true);
    expect(await isBiometricUnlockEnabled()).toBe(false);
    expect(await readBiometricPassword()).toBeNull();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: экраны читают третий ответ', () => {
  it('экран настроек отличает незнание от «выключено»', () => {
    const s = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
    expect(s).toContain('setBioUnknown(v === null);');
    expect(s).toContain('setBioEnabled(v === true);');
    // Прежнее однозначное чтение ушло целиком.
    expect(s).not.toContain('void isBiometricUnlockEnabled().then(setBioEnabled);');
  });

  it('нажатие из незнания ведёт в стирание копии, а не в «включить»', () => {
    const s = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
    const branch = s.indexOf('if (!next || bioUnknown) {');
    const drop = s.indexOf('void disableBiometricUnlock()');
    const enable = s.indexOf('setBioModal(true);');
    // Обе опоры должны существовать: у отсутствующей строки индекс -1, и
    // сравнение порядка было бы пустым.
    expect(branch).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(branch);
    expect(enable).toBeGreaterThan(drop);
  });

  it('экран настроек говорит, что состояние не прочитано', () => {
    const s = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
    expect(s).toContain('Состояние прочитать не удалось: система не ответила, лежит ли на устройстве сохранённая копия пароля. Нажмите переключатель, чтобы убрать её.');
  });

  it('экран блокировки спрашивает именно «включено», а не «не выключено»', () => {
    const s = codeOnly(read('ui', 'screens', 'PasswordScreen.tsx'));
    expect(s).toContain('const enabled = (await isBiometricUnlockEnabled()) === true;');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: под замком лежит сам пароль приложения', async () => {
    // Иначе забытая копия была бы разговором ни о чём.
    await enableBiometricUnlock('шесть-цифр-и-ещё');
    expect(store.__store[SECRET_KEY]).toBe('шесть-цифр-и-ещё');
  });
});
