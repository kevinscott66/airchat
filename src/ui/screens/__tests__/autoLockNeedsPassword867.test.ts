/**
 * v4.32.867. «Блокировать при выходе» включался без пароля и ничего не делал.
 *
 * Дефект. В «Безопасности» переключатель стоял всегда — в отличие от соседей,
 * биометрии и привязки к Apple ID, которых при незаданном пароле не видно.
 * Он включался, запись ложилась в `kv`, переживала перезапуск, и человек
 * уходил с экрана в уверенности, что переписка закрыта при сворачивании.
 *
 * Цена. Оба потребителя настройки выходят раньше, чем до неё доходят:
 * автоблокировка в App.tsx делает `if (!hasPwd) return;`, а скрытие текста в
 * баннерах спрашивает `hasPassword()` последним условием. То есть приложение
 * открывалось сразу, а баннеры продолжали показывать переписку целиком —
 * ровно то, от чего человек защищался. Обещание было ложным, и узнать об
 * этом можно было только чужими руками.
 *
 * Правка. Раздел виден при заданном пароле, как биометрия рядом. Замка без
 * ключа не бывает, а переключатель, который ничего не переключает, хуже
 * отсутствующего: он ещё и успокаивает.
 *
 * Проверяется исходник: экран настроек в jest не поднимается, а суть правки —
 * в том, под каким условием стоит разметка.
 */
import fs from 'fs';
import path from 'path';

const SCREENS = path.join(__dirname, '..');
const SETTINGS = (): string => fs.readFileSync(path.join(SCREENS, 'SettingsScreen.tsx'), 'utf8');
const APP = (): string => fs.readFileSync(path.join(SCREENS, '..', '..', 'App.tsx'), 'utf8');
const PUSH = (): string =>
  fs.readFileSync(path.join(SCREENS, '..', '..', 'notifications', 'pushNotifications.ts'), 'utf8');

/** Раздел автоблокировки целиком — от заголовка до закрытия его условия. */
function section(): string {
  const src = SETTINGS();
  const from = src.indexOf('<Text style={styles.sectionTitle}>Автоблокировка</Text>');
  expect(from).toBeGreaterThan(0);
  const to = src.indexOf('<Text style={styles.sectionTitle}>Активные сессии</Text>', from);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('раздел на месте и по-прежнему пишет настройку в kv', () => {
    const body = section();
    expect(body).toContain('Блокировать при выходе');
    expect(body).toContain("applyKvPref('auto_lock_on_exit', String(v)");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('автоблокировка в App.tsx по-прежнему выходит без пароля', () => {
    expect(APP()).toContain('if (!hasPwd) return;');
  });

  it('скрытие текста в баннерах по-прежнему упирается в тот же пароль', () => {
    const push = PUSH();
    const from = push.indexOf('async function lockAwaitsReturn(): Promise<boolean> {');
    expect(from).toBeGreaterThan(0);
    const body = push.slice(from, push.indexOf('\n}', from));
    expect(body).toContain("autoLockEnabled(await kvTryGet('auto_lock_on_exit'))");
    expect(body).toContain('return await authGuard.hasPassword();');
  });

  it('соседи по разделу прячутся ровно так же — образец рядом, а не выдуман', () => {
    const src = SETTINGS();
    expect(src).toContain('{hasAppPassword && isBiometricAvailable() ? (');
    expect(src).toContain('{appleBindReady && hasAppPassword ? (');
  });
});

describe('переключателя без пароля больше нет', () => {
  it('раздел стоит под тем же условием, что биометрия', () => {
    const src = SETTINGS();
    const cond = src.indexOf('{hasAppPassword ? (');
    expect(cond).toBeGreaterThan(0);
    const head = src.indexOf('<Text style={styles.sectionTitle}>Автоблокировка</Text>');
    // Условие открывается прямо перед заголовком, а не где-то выше по экрану.
    expect(cond).toBeLessThan(head);
    expect(src.slice(cond, head)).not.toContain('</Text>');
  });

  it('условие закрывается после раздела, а не внутри него', () => {
    const body = section();
    expect(body.trimEnd().endsWith(') : null}')).toBe(true);
    // Задержка блокировки осталась внутри — она часть того же обещания.
    expect(body).toContain("applyKvPref('auto_lock_delay_ms'");
  });

  it('другого места, где эту настройку можно включить, не завелось', () => {
    const src = SETTINGS();
    // Второе упоминание — чтение при открытии экрана, писать умеет только
    // переключатель, и он теперь под условием.
    expect(src.split("applyKvPref('auto_lock_on_exit'").length - 1).toBe(1);
    expect(src).toContain("kvRead('auto_lock_on_exit'),");
  });
});
