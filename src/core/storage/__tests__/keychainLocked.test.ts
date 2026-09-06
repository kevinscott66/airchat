/**
 * v4.32.613. Запуск при заблокированном телефоне.
 *
 * Проверяется и разбор строки, и то, что запуск с ней обходится по-людски:
 * человеческий текст вместо строки исключения, повтор вместо тупика и ни при
 * каких условиях — предложение удалить данные.
 */
import fs from 'fs';
import path from 'path';

import { KEYCHAIN_LOCKED_TEXT, isKeychainLockedMessage } from '../keychainLocked';

const APP = fs.readFileSync(path.join(__dirname, '../../../App.tsx'), 'utf8');
const SECURE_STORE = fs.readFileSync(path.join(__dirname, '../secureStoreQueued.ts'), 'utf8');

describe('распознавание заблокированной связки ключей', () => {
  it('узнаёт строку, которую показал телефон', () => {
    // Ровно то, что видел человек на экране.
    expect(
      isKeychainLockedMessage(
        "Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: User interaction is not allowed."
      )
    ).toBe(true);
  });

  it('узнаёт её в любом регистре и по коду OSStatus', () => {
    expect(isKeychainLockedMessage('errSecInteractionNotAllowed')).toBe(true);
    expect(isKeychainLockedMessage('USER INTERACTION IS NOT ALLOWED')).toBe(true);
    expect(isKeychainLockedMessage('The operation couldn’t be completed. (OSStatus error -25308)')).toBe(true);
  });

  it('не путает с другими отказами запуска', () => {
    expect(isKeychainLockedMessage('local data key unavailable: key_lost_data_present')).toBe(false);
    expect(isKeychainLockedMessage('Could not open database')).toBe(false);
    expect(isKeychainLockedMessage('')).toBe(false);
  });

  it('текст на русском и без служебных слов', () => {
    expect(KEYCHAIN_LOCKED_TEXT).toMatch(/[а-яё]/i);
    expect(KEYCHAIN_LOCKED_TEXT).not.toMatch(/[a-z]{4}/i);
    // Ничего удалять человеку тут не предлагают.
    expect(KEYCHAIN_LOCKED_TEXT).not.toMatch(/удал/i);
  });
});

describe('запуск не упирается в тупик', () => {
  it('отказ по заблокированному хранилищу переводится в человеческий текст', () => {
    expect(APP).toContain('isKeychainLockedMessage(msg)');
    expect(APP).toContain('? KEYCHAIN_LOCKED_TEXT');
  });

  it('удаление данных на этом отказе не предлагается', () => {
    expect(APP).toContain('const canReset = !locked && advice?.resettable === true && !!onReset;');
  });

  it('есть повтор — и вручную, и сам при возвращении в активное состояние', () => {
    expect(APP).toContain('testID="boot_error_retry"');
    expect(APP).toContain('if (bootError !== KEYCHAIN_LOCKED_TEXT) return;');
    expect(APP).toContain("if (next === 'active') retryBoot();");
  });
});

describe('умолчание доступности связки ключей', () => {
  it('записи по-прежнему не уезжают на чужое устройство', () => {
    expect(SECURE_STORE).toContain('keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,');
    expect(SECURE_STORE).not.toContain('keychainAccessible: ExpoSecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,');
  });
});
