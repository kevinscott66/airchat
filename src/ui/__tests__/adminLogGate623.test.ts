/**
 * Журнал группы не открывается поверх непрочитанного (v4.32.623).
 *
 * Проверка отказа чтения стоит в `loadAdminLog` с v4.32.532 — по её же
 * комментарию «пустой журнал у группы с историей — заметная ложь: по нему
 * судят, кого исключили и кто менял настройки». Но вызывающий открывал окно
 * в `.then` независимо от неё, и человек видел ровно эту ложь, только теперь
 * ещё и вместе с сообщением об ошибке.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'screens', 'GroupsScreen.tsx'),
  'utf8',
);

it('loadAdminLog отвечает вызывающему, удалось ли чтение', () => {
  expect(SRC).toContain('const loadAdminLog = useCallback(async (): Promise<boolean> => {');
  const from = SRC.indexOf('const loadAdminLog = useCallback(');
  const body = SRC.slice(from, SRC.indexOf('}, [amAdmin, group.id, pid]);', from));
  // Отказ чтения — отдельный ответ, а не тот же, что успех.
  expect(body).toContain("showError('Не удалось прочитать журнал группы'); return false;");
  expect(body).toContain('return true;');
});

it('окно журнала открывается только после удачного чтения', () => {
  const calls = SRC.split('loadAdminLog()').length - 1;
  // Ровно одно место вызова: если появится второе, эта проверка его не увидит.
  expect(calls).toBe(1);
  expect(SRC).toContain('void loadAdminLog().then((ok) => { if (ok) setAdminLogVisible(true); });');
  expect(SRC).not.toContain('void loadAdminLog().then(() => setAdminLogVisible(true));');
});
