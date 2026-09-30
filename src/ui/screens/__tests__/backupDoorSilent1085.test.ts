/**
 * ДЕФЕКТ (v4.32.1085). Дверь в «Резервную копию» молчала об отказе.
 *
 * `openBackupSection` был написан без `catch`, а первым же делом зовёт
 * `sensitiveAccessGate()` — та идёт в защищённое хранилище за тем, заведён ли
 * пароль приложения. Хранилище умеет отказывать: на Android оно закрыто, пока
 * устройство не разблокировали после перезагрузки. Отклонение промиса ловить
 * было некому: кнопка обёрнута в `useAsyncButton`, а он на отказ только пишет
 * в `console.warn`.
 *
 * ЦЕНА. Нажатие на «Резервную копию» не делает ничего: ни окна с паролем, ни
 * предложения его завести, ни единого слова. Кнопка, которая молчит, читается
 * как сломанное приложение, и человек уходит — а за этой дверью лежат
 * секретные слова и облачная копия, то есть единственный способ не потерять
 * аккаунт вместе с телефоном. Три соседние двери — смена пароля,
 * разблокировка копии и показ слов — научились называть отказ ещё в
 * v4.32.882; эта осталась.
 *
 * ПРАВКА. Тот же `catch` с `showError(userErrorText(e, …))`, что у соседей,
 * и свой запасной текст.
 *
 * ГРАНИЦЫ. Отказ не проглатывается: `sensitiveAccessGate` по-прежнему
 * бросает, а не отвечает «пароля нет» — иначе молчание сменилось бы обходом
 * пароля (политика v4.32.176).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'SettingsScreen.tsx'), 'utf8');
const GATE = readFileSync(
  join(__dirname, '..', '..', '..', 'core', 'security', 'sensitiveAccess.ts'),
  'utf8'
);
const BUTTON = readFileSync(
  join(__dirname, '..', '..', '..', 'core', 'hooks', 'useAsyncButton.ts'),
  'utf8'
);

function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CODE = codeOnly(SRC);

/** Тело двери — от объявления до его же списка зависимостей. */
function doorBody(): string {
  const start = CODE.indexOf('const openBackupSection = useCallback(async () => {');
  expect(start).toBeGreaterThan(0);
  const end = CODE.indexOf('}, [openSetPassword]);', start);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

describe('ПРОВЕРКА НЕ ПУСТАЯ (проходит и на старом коде)', () => {
  it('дверь на месте и делает то же, что делала', () => {
    const body = doorBody();
    expect(body).toContain('await sensitiveAccessGate()');
    expect(body).toContain("gate === 'set_password'");
    expect(body).toContain('setBackupUnlockModal(true);');
  });

  it('образец правильного поведения в этом же файле уже есть', () => {
    expect(CODE).toContain("showError(userErrorText(e, 'Не удалось проверить пароль. Попробуйте ещё раз.'))");
    expect(CODE).toContain("from '../components/userErrorText'");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('дверь висит на useAsyncButton, а он отказ только пишет в консоль', () => {
    expect(CODE).toContain('useAsyncButton(openBackupSection');
    expect(BUTTON).toContain("console.warn('[useAsyncButton] Unhandled error:', e)");
    expect(codeOnly(BUTTON)).not.toContain('showError');
  });

  it('gate по-прежнему ходит в хранилище и отказ не проглатывает', () => {
    const gate = codeOnly(GATE);
    expect(gate).toContain('await authGuard.hasPassword()');
    // Своего try/catch у разбора нет: отказ обязан дойти до экрана, иначе
    // «не прочиталось» превратится в «пароля нет» — это обход пароля.
    expect(gate).not.toContain('catch');
  });

  it('три соседние двери по-прежнему ловят отказ (v4.32.882)', () => {
    for (const decl of [
      'const submitChangePassword = async ()',
      'const submitBackupUnlock = async ()',
      'const handleShowSeed = useCallback(async ()',
    ]) {
      const start = CODE.indexOf(decl);
      expect(start).toBeGreaterThan(0);
      const body = CODE.slice(start, CODE.indexOf('Busy(false); }', start));
      expect(body).toContain('} catch (e) {');
    }
  });
});

describe('дверь называет отказ', () => {
  it('ловит ошибку', () => {
    expect(doorBody()).toContain('} catch (e) {');
  });

  it('показывает текст, а не молчит', () => {
    expect(doorBody()).toMatch(/showError\(userErrorText\(e, '[^']+'\)\)/);
  });

  it('запасной текст по-русски и не пустой', () => {
    const m = /userErrorText\(e, '([^']+)'\)/.exec(doorBody());
    expect(m).not.toBeNull();
    expect(m![1].length).toBeGreaterThan(10);
    expect(m![1]).toMatch(/[а-яё]/i);
  });

  it('текст свой, а не одолженный у соседней двери', () => {
    const mine = /userErrorText\(e, '([^']+)'\)/.exec(doorBody())![1];
    const others = [...CODE.matchAll(/userErrorText\(e, '([^']+)'\)/g)].map((x) => x[1]);
    expect(others.filter((t) => t === mine)).toHaveLength(1);
  });

  it('под catch попадает вся дверь, а не её хвост', () => {
    const body = doorBody();
    // Без этой строки проверка прошла бы и на старом коде: у отсутствующего
    // try indexOf равен -1, а -1 меньше чего угодно.
    expect(body).toContain('try {');
    expect(body.indexOf('try {')).toBeLessThan(body.indexOf('await sensitiveAccessGate()'));
  });
});
