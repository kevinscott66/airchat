/**
 * v4.32.866. Отказ хранилища ключей на последнем шаге запуска вешал приложение.
 *
 * Дефект. Запуск заканчивается одним вопросом: есть ли у приложения пароль.
 * Отвечает на него хранилище ключей, а оно умеет отказывать — телефон
 * перезагрузили и приложение подняли до первого разблокирования, и
 * `hasPassword` бросает `errSecInteractionNotAllowed`. Бросок уходил в
 * `void (async () => …)()` без обработки, `setPasswordGateResolved(true)` не
 * выполнялся никогда, и рендер до скончания времён держал «Завершаем вход…».
 *
 * Цена. Ни ошибки, ни кнопки, ни подсказки: бесконечный лоадер, из которого
 * выход один — убить приложение и запустить заново. И так каждый раз, пока
 * телефон не разблокируют первым. Обиднее всего, что диагноз этому отказу в
 * проекте уже написан (v4.32.613) и соседний эффект автоблокировки его
 * применяет — правку сюда просто не донесли.
 *
 * Правка. Вопрос задаётся под `try`, а отказ становится обычной ошибкой
 * запуска: тот же текст, та же кнопка «Повторить», то же самоисцеление при
 * возвращении в активное состояние. Гадать нельзя ни в какую сторону —
 * отпереть без пароля значит открыть переписку тому, кто поднял телефон, а
 * запереть при отсутствующем пароле значит запереть навсегда.
 *
 * Проверяется исходник: React-гарнитуры для рендера App.tsx в проекте нет, а
 * правило по природе своей про то, какая ветка куда ведёт.
 */
import fs from 'fs';
import path from 'path';

const APP = path.join(__dirname, '..', 'App.tsx');
const read = (): string => fs.readFileSync(APP, 'utf8');

/** Тело эффекта, решающего вопрос про пароль, — вместе с массивом зависимостей. */
function gate(): string {
  const src = read();
  const from = src.indexOf('    if (gate !== \'ready\' || !pair || savedSession === undefined) {');
  expect(from).toBeGreaterThan(0);
  const to = src.indexOf('}, [gate, pair, savedSession', from);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, src.indexOf('\n', to));
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('эффект на месте и по-прежнему спрашивает хранилище про пароль', () => {
    expect(gate()).toContain('await authGuard.hasPassword()');
  });

  it('снимок именно того куска, который решает судьбу лоадера', () => {
    expect(gate()).toContain('setPasswordGateResolved(true);');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('`hasPassword` по-прежнему умеет бросать — своего try у него нет', () => {
    const guard = fs.readFileSync(
      path.join(__dirname, '..', 'core', 'security', 'authGuard.ts'),
      'utf8'
    );
    const from = guard.indexOf('async hasPassword(): Promise<boolean> {');
    expect(from).toBeGreaterThan(0);
    const body = guard.slice(from, guard.indexOf('\n  }', from));
    expect(body).toContain('await SecureStore.getItemAsync(');
    expect(body).not.toContain('try {');
  });

  it('рендер всё так же держит лоадер, пока вопрос не решён', () => {
    const src = read();
    expect(src).toContain(
      '(gate === \'ready\' && pair && savedSession !== undefined && !passwordGateResolved)'
    );
    expect(src).toContain("? 'Завершаем вход…'");
  });

  it('«Повторить» само по себе эффекта не трогает — только нонс', () => {
    const src = read();
    const from = src.indexOf('const retryBoot = useCallback(() => {');
    expect(from).toBeGreaterThan(0);
    const body = src.slice(from, src.indexOf('}, []);', from));
    expect(body).toContain('setBootError(null);');
    expect(body).toContain('setWalletBootNonce((n) => n + 1);');
    // Ни `gate`, ни `pair`, ни `savedSession` повтор не меняет — значит без
    // нонса в зависимостях эффект после нажатия не ожил бы.
    for (const s of ['setGate(', 'setPair(', 'setSavedSession(']) expect(body).not.toContain(s);
  });
});

describe('отказ становится ошибкой запуска, а не вечным лоадером', () => {
  it('вопрос задаётся под try, и отказ доходит до экрана', () => {
    const body = gate();
    expect(body).toContain('try {\n        hasPwd = await authGuard.hasPassword();\n      } catch (e) {');
    expect(body).toContain('setBootError(');
    expect(body).toContain("log.error('boot_password_gate_failed', { err: msg });");
  });

  it('ветка отказа не выдаёт решения за хранилище', () => {
    const body = gate();
    const at = body.indexOf('} catch (e) {');
    expect(at).toBeGreaterThan(0);
    const branch = body.slice(at, body.indexOf('if (cancelled) return;\n      hadPasswordRef', at));
    // Ни отпереть, ни запереть: обе догадки одинаково опасны.
    for (const s of ['unlockSession()', 'lockSession()', 'setAppUnlocked(', 'setPasswordGateResolved(']) {
      expect(branch).not.toContain(s);
    }
    expect(branch).toContain('return;');
  });

  it('«телефон был заблокирован» узнаётся тем же разбором, что и на запуске', () => {
    const body = gate();
    expect(body).toContain('isKeychainLockedMessage(msg)\n            ? KEYCHAIN_LOCKED_TEXT');
    expect(body).toContain('diagnoseStorageFailure(msg, currentStorageEnv()) ?? msg');
    // Тот же текст, что у остальных отказов запуска, — значит и эффект
    // самоповтора при возвращении в активное состояние накрывает этот случай.
    const src = read();
    expect(src).toContain('if (bootError !== KEYCHAIN_LOCKED_TEXT) return;');
    expect(src).toContain("if (next === 'active') retryBoot();");
  });

  it('«Повторить» доходит и сюда: нонс в зависимостях', () => {
    expect(gate()).toContain('}, [gate, pair, savedSession, walletBootNonce]);');
  });

  it('экран ошибки перебивает лоадер, а не встаёт после него', () => {
    const src = read();
    const err = src.indexOf('  if (bootError) {');
    const loader = src.indexOf("? 'Завершаем вход…'");
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(loader);
    // И сплэш уходит, иначе ошибку никто бы не увидел.
    expect(src).toContain('if (bootError !== null) {');
  });
});
