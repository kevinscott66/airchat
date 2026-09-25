/**
 * Часы, написанные от руки (v4.32.929).
 *
 * Дефект. В доме есть общий циферблат — `clockTime`/`clockTimeSec` в
 * `core/time/ruDateTime`, — и мимо него жили ещё три места.
 *
 *   1. Раздел туннеля собирал «часы:минуты:секунды» своим `formatTime`.
 *      От общего он отличался ровно одним: общий молчит на непригодной метке
 *      (`isUsableTimestamp`), а свой рисовал `new Date(0)` как «03:00:00» —
 *      час местного пояса, выданный за ответ.
 *   2. Подпись часа настройки «22:00» была выписана семью копиями в пяти
 *      строках: четыре в настройках, одна в самом шаговом выборе часа. За
 *      подписью не стояло никакой проверки, а данные в неё шли из kv.
 *   3. В ленте жил переходник `function formatTime(ts) { return
 *      dayMonthShortTime(ts); }` — имя, которое не добавляло ничего, кроме
 *      третьего значения слова `formatTime` в одном приложении.
 *
 * Цена. Часы ночной темы читались голым `parseInt`. Испорченная запись давала
 * NaN, и это било дважды: «Тёмная: NaN:00 – NaN:00» в настройках и тема,
 * которая молча перестаёт переключаться — сравнения с NaN всегда ложны.
 * Границы «не беспокоить» такую проверку получили ещё в v4.32.195, размер
 * шрифта строкой ниже — тоже; ночные часы её не получили.
 *
 * Правка. Час суток как настройка — отдельный модуль `core/time/hourOfDay`:
 * `parseHourOfDay` на входе, `hourOfDayLabel` на выходе. Метка времени —
 * общий `clockTimeSec`. Переходник в ленте убран.
 *
 * Границы. `parseDndHour` в слое уведомлений намеренно оставлен на месте:
 * его зовёт фоновый обработчик push в своём контексте, и модуль там без
 * единого импорта не по случайности. `getHours()` тоже не запрещается — час
 * законно спрашивают там, где он решение, а не подпись.
 */
import fs from 'fs';
import path from 'path';

import { hourOfDayLabel, parseHourOfDay } from '../../core/time/hourOfDay';
import { clockTime, clockTimeSec } from '../../core/time/ruDateTime';
import { formatClockDuration } from '../time/durationLabel';

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Только код: упоминание в комментарии проверку удовлетворять не должно. */
const codeOnly = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

/** Как циферблат был написан от руки — для сравнения с общим. */
function handRolledClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

describe('час суток называется одинаково и приходит проверенным', () => {
  it('подпись часа — две цифры и ноль минут', () => {
    expect(hourOfDayLabel(0)).toBe('00:00');
    expect(hourOfDayLabel(7)).toBe('07:00');
    expect(hourOfDayLabel(9)).toBe('09:00');
    expect(hourOfDayLabel(10)).toBe('10:00');
    expect(hourOfDayLabel(21)).toBe('21:00');
    expect(hourOfDayLabel(23)).toBe('23:00');
  });

  it('не-час подписи не получает — молчание вместо «NaN:00»', () => {
    expect(hourOfDayLabel(NaN)).toBe('');
    expect(hourOfDayLabel(-1)).toBe('');
    expect(hourOfDayLabel(24)).toBe('');
    expect(hourOfDayLabel(21.5)).toBe('');
    expect(hourOfDayLabel(Infinity)).toBe('');
  });

  it('разбор настройки: час берётся, мусор заменяется запасным', () => {
    expect(parseHourOfDay('0', 22)).toBe(0);
    expect(parseHourOfDay('7', 8)).toBe(7);
    expect(parseHourOfDay('23', 22)).toBe(23);
    for (const raw of [null, undefined, '', ' ', 'abc', 'NaN', '24', '-1', '99']) {
      expect(parseHourOfDay(raw, 21)).toBe(21);
    }
  });

  it('всё, что вышло из разбора, подпись получает', () => {
    // Пара должна быть замкнутой: иначе пустая подпись стала бы обычным делом
    // и перестала бы что-либо значить.
    for (const raw of [null, '', 'abc', '24', '-1', '0', '23', '9']) {
      expect(hourOfDayLabel(parseHourOfDay(raw, 21))).toMatch(/^\d\d:00$/);
    }
  });
});

describe('метка времени в разделе туннеля идёт через общий циферблат', () => {
  it('пустая метка остаётся пустой, а не становится часом пояса', () => {
    expect(clockTimeSec(0)).toBe('');
    expect(clockTimeSec(NaN)).toBe('');
    expect(clockTimeSec(-1)).toBe('');
  });

  it('настоящая метка называется полностью — с секундой', () => {
    const ts = new Date(2026, 8, 25, 14, 3, 7, 0).getTime();
    expect(clockTimeSec(ts)).toBe('14:03:07');
    expect(clockTime(ts)).toBe('14:03');
  });
});

describe('ни одного своего циферблата в исходниках не осталось', () => {
  it('раздел туннеля зовёт общий, своего не объявляет', () => {
    const src = codeOnly('ui/components/OpenFluxSettingsSection.tsx');
    expect(src).not.toContain('function formatTime');
    expect(src).not.toContain('getMinutes()');
    expect(src).toContain("import { clockTimeSec } from '../../core/time/ruDateTime';");
    expect(src).toContain('clockTimeSec(stats.lastAt)');
  });

  it('переходник в ленте убран, зовётся дом', () => {
    const src = codeOnly('ui/screens/FeedScreen.tsx');
    expect(src).not.toContain('function formatTime');
    expect(src).not.toContain('formatTime(');
    expect(src).toContain('dayMonthShortTime(item.timestamp)');
  });

  it('настройки и шаговый выбор часа называют час одним вызовом', () => {
    const settings = codeOnly('ui/screens/SettingsScreen.tsx');
    expect(settings).not.toContain("padStart(2, '0')}:00");
    expect(settings).toContain('{hourOfDayLabel(dndStart)}');
    expect(settings).toContain('{hourOfDayLabel(dndEnd)}');
    expect(settings).toContain('${hourOfDayLabel(autoNightStart)} – ${hourOfDayLabel(autoNightEnd)}');

    const stepper = codeOnly('ui/screens/settings/HourStepper.tsx');
    expect(stepper).not.toContain("padStart(2, '0')}:00");
    expect(stepper).toContain('const value = hourOfDayLabel(hour);');
  });

  it('ночные часы больше не читаются голым parseInt', () => {
    const src = codeOnly('ui/ThemeContext.tsx');
    expect(src).not.toContain('parseInt(nightStart');
    expect(src).not.toContain('parseInt(nightEnd');
    // v4.32.964: у довода прибавилось `.value` — чтение вида стало трёхсловным
    // (`kvTryGet`), и «не прочитали» больше не притворяется пустой записью.
    // Закрепка здесь про другое и не изменилась: час разбирается с проверкой, а
    // запасное значение остаётся прежним.
    expect(src).toContain('parseHourOfDay(nightStart.value, 21)');
    expect(src).toContain('parseHourOfDay(nightEnd.value, 7)');
  });

  it('границы «не беспокоить» разбираются тем же вызовом', () => {
    const src = codeOnly('ui/screens/SettingsScreen.tsx');
    expect(src).toContain('parseHourOfDay(dndS, 22)');
    expect(src).toContain('parseHourOfDay(dndE, 8)');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: законные padStart на месте', () => {
  it('длительность записи по-прежнему дописывает нули сама', () => {
    // Это не время суток, а отрезок: «1:02:05» тут значит час две минуты пять
    // секунд. Под общий циферблат оно не идёт и запрету не подлежит.
    expect(formatClockDuration(65_000)).toBe('1:05');
    expect(formatClockDuration(3_725_000)).toBe('1:02:05');
  });

  it('час суток и час длительности — разные строки', () => {
    expect(hourOfDayLabel(1)).toBe('01:00');
    expect(formatClockDuration(3_600_000)).toBe('1:00:00');
  });

  it('разбор часа не путает час с любым числом', () => {
    expect(parseHourOfDay('22', 0)).toBe(22);
    expect(parseHourOfDay('22000', 0)).toBe(0);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('рукописный циферблат и общий расходятся ровно на пустой метке', () => {
    const ts = new Date(2026, 8, 25, 14, 3, 7, 0).getTime();
    // На настоящей метке они совпадают — потому копия и прожила так долго.
    expect(handRolledClock(ts)).toBe(clockTimeSec(ts));
    // А на пустой рукописный выдаёт час пояса за ответ.
    expect(handRolledClock(0)).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(clockTimeSec(0)).toBe('');
  });

  it('рукописная подпись часа не молчит на не-часе', () => {
    const handRolledHour = (h: number): string => `${String(h).padStart(2, '0')}:00`;
    expect(handRolledHour(21)).toBe(hourOfDayLabel(21));
    expect(handRolledHour(NaN)).toBe('NaN:00');
    expect(hourOfDayLabel(NaN)).toBe('');
  });

  it('голый parseInt на испорченной записи даёт NaN', () => {
    expect(Number.isNaN(parseInt('abc', 10))).toBe(true);
    expect(parseHourOfDay('abc', 21)).toBe(21);
  });
});
