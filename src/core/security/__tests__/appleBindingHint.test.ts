/**
 * Привязка слов к Apple ID переживает смену пароля приложения.
 *
 * Дефект (v4.32.615). Конверт со словами лежит на сервере зашифрованным
 * паролем приложения — тем, что был на момент привязки. `changePassword`
 * переписывал только местный секрет и биометрию, а подсказка в настройках
 * оставалась `'1'`, и строка продолжала обещать: «Восстановить аккаунт можно
 * входом через Apple ID и паролем приложения». Обещание к тому моменту уже не
 * работало, и узнал бы об этом человек ровно в тот день, когда слов на руках
 * нет.
 *
 * Перешифровать конверт молча нечем: для записи нужен свежий токен Apple, то
 * есть системное окно входа. Поэтому третье состояние — «устарела».
 */

import fs from 'fs';
import path from 'path';

import {
  APPLE_BINDING_STORED,
  hintAfterPasswordChange,
  parseAppleBindingHint,
} from '../appleBindingHint';

const SCREEN = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'SettingsScreen.tsx'),
  'utf8',
) as string;

/** Комментарии не код: храповик не должен ловить сам себя в пояснении. */
const SCREEN_CODE = SCREEN.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/** Тело функции от заголовка до первой строки `\n  };\n` включительно. */
function bodyOf(src: string, anchor: string): string {
  const i = src.indexOf(anchor);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = src.indexOf('\n  };\n', i);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe('подсказка привязки: разбор записи', () => {
  test('прежние значения читаются как раньше', () => {
    expect(parseAppleBindingHint('1')).toBe('bound');
    expect(parseAppleBindingHint('0')).toBe('none');
  });

  test('новое значение читается как «устарела»', () => {
    expect(parseAppleBindingHint('stale')).toBe('stale');
    expect(parseAppleBindingHint(APPLE_BINDING_STORED.stale)).toBe('stale');
  });

  test('пусто, мусор и незнакомое — привязки нет', () => {
    for (const raw of [null, undefined, '', '2', 'true', 'STALE', ' 1', '1 ']) {
      expect(parseAppleBindingHint(raw)).toBe('none');
    }
  });

  test('запись и разбор — обратные друг другу', () => {
    for (const h of ['bound', 'stale', 'none'] as const) {
      expect(parseAppleBindingHint(APPLE_BINDING_STORED[h])).toBe(h);
    }
  });

  test('значение «привязано» не переехало: старые устройства уже пишут его', () => {
    expect(APPLE_BINDING_STORED.bound).toBe('1');
    expect(APPLE_BINDING_STORED.none).toBe('0');
  });
});

describe('подсказка привязки: смена пароля', () => {
  test('привязка была — становится устаревшей', () => {
    expect(hintAfterPasswordChange('bound')).toBe('stale');
  });

  test('привязки не было — писать нечего', () => {
    expect(hintAfterPasswordChange('none')).toBeNull();
  });

  test('уже помечена устаревшей — второй раз не предупреждаем', () => {
    expect(hintAfterPasswordChange('stale')).toBeNull();
  });

  test('вторая смена пароля подряд ничего не меняет', () => {
    const first = hintAfterPasswordChange('bound');
    expect(first).toBe('stale');
    expect(hintAfterPasswordChange(first as 'stale')).toBeNull();
  });
});

describe('храповик: экран настроек помечает привязку после смены пароля', () => {
  test('успешная смена пароля зовёт пометку', () => {
    const body = bodyOf(SCREEN_CODE, 'const submitChangePassword =');
    expect(body).toContain('authGuard.changePassword(');
    expect(body).toContain('markAppleBindingStaleAfterPasswordChange()');
  });

  test('пометка решает через чистый модуль, а не сравнением строк на месте', () => {
    const body = bodyOf(SCREEN_CODE, 'const markAppleBindingStaleAfterPasswordChange =');
    expect(body).toContain('parseAppleBindingHint(');
    expect(body).toContain('hintAfterPasswordChange(');
    expect(body).toMatch(/if \(!next\) return;/);
    expect(body).toContain('setAppleBindStale(true)');
  });

  test('привязка и отвязка снимают пометку', () => {
    expect(bodyOf(SCREEN_CODE, 'const submitBindApple =')).toContain('setAppleBindStale(false)');
    expect(bodyOf(SCREEN_CODE, 'const handleUnbindApple =')).toContain('setAppleBindStale(false)');
  });

  test('строка в настройках различает устаревшую привязку', () => {
    expect(SCREEN_CODE).toContain('appleBindStale');
    expect(SCREEN).toContain('Привязка к Apple ID устарела');
    expect(SCREEN).toContain('прежним паролем и новым уже не откроется');
  });

  test('сырые значения подсказки больше не разбросаны по экрану', () => {
    expect(SCREEN_CODE).not.toMatch(/APPLE_BINDING_HINT_KEY, '[01]'\)/);
    expect(SCREEN_CODE).not.toMatch(/APPLE_BINDING_HINT_KEY\)\) !== '1'/);
  });
});
