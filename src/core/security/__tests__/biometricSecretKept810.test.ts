/**
 * Выключение биометрии перестало молчать о забытом пароле (v4.32.810).
 *
 * Дефект. `disableBiometricUnlock` отдавала `void`. Внутри два удаления:
 * незапертый признак «включено» и запертая запись, в которой лежит САМ пароль
 * приложения. Второе на части устройств поднимает системный запрос, и отказ на
 * нём гасился в лог. Оба вызывающих вели себя так, будто запись снята: экран
 * настроек переставлял переключатель и молчал, а `authGuard.setPassword`
 * считал, что прежний пароль из хранилища убран. Рядом жила вторая половина
 * той же дыры: `enableBiometricUnlock` при отказе на записи признака оставляла
 * уже положенный пароль лежать и возвращала `false` — экран говорил «не
 * удалось включить», и копия пароля оставалась на устройстве от неудавшегося
 * включения.
 *
 * Цена. Хранить пароль в Secure Enclave — осознанный размен, и человек
 * соглашается на него, включая Face ID. Выключая, он этот размен отменяет:
 * единственное, что здесь делается, — уносится копия пароля. Если она не
 * уносится, не сделано ничего, а сказано обратное. Острее всего при смене
 * пароля: `setPassword` зовёт выключение именно затем, чтобы под биометрией не
 * остался ПРЕЖНИЙ пароль — тот, от которого человек уходит, и уходит чаще
 * всего потому, что его узнали.
 *
 * Правка. `disableBiometricUnlock` возвращает `boolean`, и `false` означает
 * ровно одно: копия пароля осталась. Сама биометрия выключается в любом
 * случае — признак снимается первым и без запроса, — поэтому переключатель
 * гаснет, а человеку отдельно говорят про несостоявшееся удаление.
 * `enableBiometricUnlock` при отказе на признаке убирает за собой.
 */
jest.mock('../../storage/secureStoreQueued', () => {
  const s: Record<string, string | undefined> = {};
  return {
    __store: s,
    getItemAsync: jest.fn(async (key: string) => s[key] ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { s[key] = value; }),
    deleteItemAsync: jest.fn(async (key: string) => { delete s[key]; }),
  };
});

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  canUseBiometricAuthentication: jest.fn(() => true),
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import fs from 'fs';
import path from 'path';

import {
  BIOMETRIC_SECURE_KEYS,
  disableBiometricUnlock,
  enableBiometricUnlock,
  isBiometricUnlockEnabled,
  readBiometricPassword,
} from '../biometricUnlock';

const store = jest.requireMock('../../storage/secureStoreQueued') as {
  __store: Record<string, string | undefined>;
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

const [SECRET_KEY, FLAG_KEY] = BIOMETRIC_SECURE_KEYS;

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

beforeEach(() => {
  for (const k of Object.keys(store.__store)) delete store.__store[k];
  store.getItemAsync.mockReset();
  store.setItemAsync.mockReset();
  store.deleteItemAsync.mockReset();
  store.getItemAsync.mockImplementation(async (key: string) => store.__store[key] ?? null);
  store.setItemAsync.mockImplementation(async (key: string, value: string) => { store.__store[key] = value; });
  store.deleteItemAsync.mockImplementation(async (key: string) => { delete store.__store[key]; });
});

describe('забытая копия пароля называется вслух', () => {
  it('удачное выключение отвечает утвердительно', async () => {
    await enableBiometricUnlock('secret123');
    expect(await disableBiometricUnlock()).toBe(true);
    expect(store.__store[SECRET_KEY]).toBeUndefined();
  });

  it('отказ на стирании пароля отвечает false, а не «готово»', async () => {
    await enableBiometricUnlock('secret123');
    store.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === SECRET_KEY) throw new Error('user cancelled');
      delete store.__store[key];
    });
    expect(await disableBiometricUnlock()).toBe(false);
    // И это правда: пароль лежит там же, где лежал.
    expect(store.__store[SECRET_KEY]).toBe('secret123');
  });

  it('несостоявшееся включение не оставляет пароль на устройстве', async () => {
    // Пароль лёг, признак не встал: включения не было, а копия осталась бы.
    store.setItemAsync.mockImplementation(async (key: string, value: string) => {
      if (key === FLAG_KEY) throw new Error('keychain busy');
      store.__store[key] = value;
    });
    expect(await enableBiometricUnlock('secret123')).toBe(false);
    expect(await isBiometricUnlockEnabled()).toBe(false);
    expect(store.__store[SECRET_KEY]).toBeUndefined();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежний договор биометрии цел', () => {
  it('включение кладёт пароль, чтение его отдаёт', async () => {
    expect(await enableBiometricUnlock('secret123')).toBe(true);
    expect(await isBiometricUnlockEnabled()).toBe(true);
    expect(await readBiometricPassword()).toBe('secret123');
  });

  it('признак снимается первым — иначе остаётся кнопка, которая не открывает', async () => {
    await enableBiometricUnlock('secret123');
    store.deleteItemAsync.mockClear();
    await disableBiometricUnlock();
    const order = (store.deleteItemAsync.mock.calls as Array<[string]>).map(([key]) => key);
    expect(order[0]).toBe(FLAG_KEY);
    expect(order).toContain(SECRET_KEY);
  });

  it('биометрия выключена даже тогда, когда копия осталась', async () => {
    await enableBiometricUnlock('secret123');
    store.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === SECRET_KEY) throw new Error('user cancelled');
      delete store.__store[key];
    });
    await disableBiometricUnlock();
    expect(await isBiometricUnlockEnabled()).toBe(false);
    expect(await readBiometricPassword()).toBeNull();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('в запертой записи лежит сам пароль приложения, слово в слово', async () => {
    // Потому забытая копия и стоит разговора: это не токен и не отпечаток, а
    // ровно те цифры, которые открывают переписку.
    await enableBiometricUnlock('шесть-цифр-и-ещё');
    expect(store.__store[SECRET_KEY]).toBe('шесть-цифр-и-ещё');
  });

  it('до выхода из аккаунта копию не уносит ничто другое', () => {
    // Список ключей сброса берётся у владельца данных — и ключи там есть, но
    // сброс случается при выходе, а не при выключении переключателя.
    const wipe = codeOnly(read('core', 'wallet', 'wipeLocalWallet.ts'));
    expect(wipe).toContain('...BIOMETRIC_SECURE_KEYS,');
  });
});

describe('форма исходников: об отказе говорят обоим вызывающим', () => {
  it('подпись функции обещает ответ', () => {
    const s = codeOnly(read('core', 'security', 'biometricUnlock.ts'));
    expect(s).toContain('export async function disableBiometricUnlock(): Promise<boolean> {');
    expect(s).not.toContain('export async function disableBiometricUnlock(): Promise<void> {');
    expect(s).toContain('await disableBiometricUnlock();\n    return false;');
  });

  it('экран настроек говорит человеку, что копия осталась', () => {
    const s = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
    expect(s).toContain('.then((removed) => {');
    expect(s).toContain(
      "showError('Вход по биометрии выключен, но убрать сохранённую копию пароля не удалось: система не подтвердила доступ. Попробуйте включить и выключить ещё раз.');",
    );
    expect(s).not.toContain('.then(() => { setBioEnabled(false); })');
  });

  it('смена пароля пишет в лог, что под биометрией остался прежний', () => {
    const s = codeOnly(read('core', 'security', 'authGuard.ts'));
    expect(s).toContain(
      'if (!(await enableBiometricUnlock(password)) && !(await disableBiometricUnlock())) {',
    );
    expect(s).toContain("log.error('auth_stale_biometric_secret_kept');");
  });
});
