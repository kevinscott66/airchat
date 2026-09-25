/**
 * Оставшееся время медленного режима записано тремя способами (v4.32.912).
 *
 * Дефект. Одно и то же число секунд, полученное из одного и того же
 * `slowModeRemaining`, показывалось на одном экране группы трижды и всякий раз
 * иначе:
 *
 *     Alert:      `Подождите ещё ${remaining} сек перед следующим сообщением.`
 *     плашка:     `Медленный режим: следующее через {slowCooldownLeft} с`
 *     подпись поля: `Подождите ${slowCooldownLeft} с…`
 *
 * Цена. Ни «сек», ни «с» не склоняются, а фраза вокруг склоняется: «Подождите
 * ещё 1 сек», «следующее через 1 с». Хуже того, плашка и подпись поля стоят
 * друг над другом и тикают одновременно — два разных написания одного числа
 * видны одним взглядом, и «с» рядом с «сек» читается как другая единица.
 * У приложения уже есть отсчёт этого же рода — блокировка входа после
 * неудачных попыток, — и он говорит «Попробуйте через 5 минут» полным словом.
 *
 * Правка. `secondsLabel` рядом с `minutesLabel`, все три места зовут её.
 * Сокращение «сек» остаётся за значением настройки (`formatSlowMode`): там
 * число стоит без глагола, в одном ряду с «5 мин» и «1 ч».
 *
 * Экран в jest не поднимается (весь react-native внутри), поэтому места вызова
 * проверяются по исходнику — как в storyBlankName906.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatSlowMode, slowModeRemaining, slowModeSysLine } from '../../core/social/groupSendPolicy';
import { minutesLabel, secondsLabel } from '../utils/plural';

const GROUPS = (): string =>
  readFileSync(join(__dirname, '..', 'screens', 'GroupsScreen.tsx'), 'utf8');

/** Исходник без комментариев: пояснение к правке цитирует прежние формы. */
function codeOnly(src: string): string {
  return src
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

describe('отсчёт медленного режима склоняется и записан одинаково', () => {
  test('подпись склоняет секунду по-русски', () => {
    expect(secondsLabel(1)).toBe('1 секунду');
    expect(secondsLabel(2)).toBe('2 секунды');
    expect(secondsLabel(4)).toBe('4 секунды');
    expect(secondsLabel(5)).toBe('5 секунд');
    expect(secondsLabel(11)).toBe('11 секунд');
    expect(secondsLabel(21)).toBe('21 секунду');
    expect(secondsLabel(22)).toBe('22 секунды');
    expect(secondsLabel(60)).toBe('60 секунд');
  });

  test('падеж тот же, что у отсчёта блокировки входа', () => {
    // Обе подписи стоят после «через»/«подождите», и разъезжаться им незачем.
    expect(`Попробуйте через ${minutesLabel(1)}`).toBe('Попробуйте через 1 минуту');
    expect(`Попробуйте через ${secondsLabel(1)}`).toBe('Попробуйте через 1 секунду');
  });

  test('все три места на экране группы зовут одну подпись', () => {
    const code = codeOnly(GROUPS());
    expect(code).toContain('`Подождите ещё ${secondsLabel(remaining)} перед следующим сообщением.`');
    expect(code).toContain('Медленный режим: следующее через {secondsLabel(slowCooldownLeft)}');
    expect(code).toContain('`Подождите ${secondsLabel(slowCooldownLeft)}…`');
  });

  test('прежних сокращений в отсчёте не осталось', () => {
    const code = codeOnly(GROUPS());
    expect(code).not.toContain('${remaining} сек');
    expect(code).not.toContain('{slowCooldownLeft} с<');
    expect(code).not.toContain('${slowCooldownLeft} с…');
  });

  test('подпись импортирована, а не написана по месту', () => {
    expect(GROUPS()).toContain("secondsLabel, subscribersLabel, scheduledLabel } from '../utils/plural';");
    expect(codeOnly(GROUPS())).not.toContain("'секунд'");
  });
});

describe('до правки было верно и осталось верно', () => {
  test('значение настройки по-прежнему сокращают', () => {
    // Там число стоит без глагола, в одном ряду с соседними единицами, и
    // полное слово только удлинило бы пункт меню. v4.32.265 эту форму свёл.
    expect(formatSlowMode(10)).toBe('10 сек');
    expect(formatSlowMode(300)).toBe('5 мин');
    expect(formatSlowMode(3600)).toBe('1 ч');
    expect(formatSlowMode(0)).toBe('Выключен');
    expect(slowModeSysLine(30)).toBe('Медленный режим: 30 сек');
    expect(slowModeSysLine(0)).toBe('Медленный режим отключён');
  });

  test('счёт оставшегося не трогали — менялась только подпись', () => {
    const base = { role: 'member' as const, slowModeSeconds: 30, lastSentAt: 1_000_000 };
    expect(slowModeRemaining({ ...base, now: 1_000_000 })).toBe(30);
    expect(slowModeRemaining({ ...base, now: 1_010_000 })).toBe(20);
    expect(slowModeRemaining({ ...base, now: 1_030_000 })).toBe(0);
    expect(slowModeRemaining({ ...base, now: 1_060_000 })).toBe(0);
  });

  test('администрацию отсчёт по-прежнему не касается', () => {
    const base = { slowModeSeconds: 30, lastSentAt: 1_000_000, now: 1_000_000 };
    expect(slowModeRemaining({ ...base, role: 'owner' })).toBe(0);
    expect(slowModeRemaining({ ...base, role: 'admin' })).toBe(0);
    expect(slowModeRemaining({ ...base, role: 'member' })).toBe(30);
  });

  test('плашка и подпись поля показываются только при ненулевом отсчёте', () => {
    const code = codeOnly(GROUPS());
    expect(code).toContain('{slowCooldownLeft > 0 ? (');
    expect(code).toContain('placeholder={slowCooldownLeft > 0 ?');
  });

  test('обход исходника не пуст и комментарии из него убраны', () => {
    // Невырожденность: без этого проверки на отсутствие зелены и на пустой строке.
    expect(GROUPS().length).toBeGreaterThan(10_000);
    expect(codeOnly(GROUPS())).toContain('slowCooldownLeft');
    expect(codeOnly('// ${remaining} сек\nconst a = 1;')).not.toContain('сек');
    expect(codeOnly('const t = `${remaining} сек`;')).toContain('сек');
  });
});
