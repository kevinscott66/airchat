/**
 * Длительность: одна арифметика на звонок, голосовое, видео и журнал.
 *
 * v4.32.423.
 */
import { formatClockDuration, formatSpokenDuration } from '../time/durationLabel';

describe('formatClockDuration', () => {
  it('минуты и секунды', () => {
    expect(formatClockDuration(0)).toBe('0:00');
    expect(formatClockDuration(7_000)).toBe('0:07');
    expect(formatClockDuration(754_000)).toBe('12:34');
  });

  it('дробная секунда отбрасывается, а не округляется', () => {
    // Голосовое округляло к ближайшей: запись в 59.6 с подписывалась «1:00»,
    // то есть отсчёт показывал конец раньше конца.
    expect(formatClockDuration(59_600)).toBe('0:59');
    expect(formatClockDuration(999)).toBe('0:00');
  });

  it('часы называются часами', () => {
    // Раньше три копии из четырёх не знали часов: часовое видео из галереи
    // было подписано «62:05» — это читается как минута с небольшим.
    expect(formatClockDuration(3_725_000)).toBe('1:02:05');
    expect(formatClockDuration(3_600_000)).toBe('1:00:00');
    expect(formatClockDuration(36_000_000)).toBe('10:00:00');
  });

  it('минуты при часах пишутся двумя цифрами, без часов — одной', () => {
    expect(formatClockDuration(3_605_000)).toBe('1:00:05');
    expect(formatClockDuration(305_000)).toBe('5:05');
  });

  it('мусор на входе даёт ноль, а не «NaN:NaN» и не «-1:-1»', () => {
    for (const bad of [-1_000, NaN, Infinity, -Infinity, undefined as unknown as number]) {
      expect(formatClockDuration(bad)).toBe('0:00');
    }
  });
});

describe('formatSpokenDuration', () => {
  it('секунды, минуты, часы', () => {
    expect(formatSpokenDuration(7_000)).toBe('7 с');
    expect(formatSpokenDuration(59_000)).toBe('59 с');
    expect(formatSpokenDuration(312_000)).toBe('5 мин 12 с');
    expect(formatSpokenDuration(3_725_000)).toBe('1 ч 2 мин');
  });

  it('нулевой хвост не пишется', () => {
    // Журнал звонков писал «1 мин 0 с» и «60 мин 0 с».
    expect(formatSpokenDuration(60_000)).toBe('1 мин');
    expect(formatSpokenDuration(3_600_000)).toBe('1 ч');
  });

  it('часовой звонок не превращается в шестьдесят минут', () => {
    expect(formatSpokenDuration(3_660_000)).toBe('1 ч 1 мин');
  });

  it('мусор на входе даёт ноль секунд', () => {
    for (const bad of [-1_000, NaN, Infinity]) expect(formatSpokenDuration(bad)).toBe('0 с');
  });
});

describe('копий арифметики больше нет', () => {
  const HOME = 'ui/time/durationLabel.ts';

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync, readFileSync, statSync } = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path') as typeof import('path');
  const SRC = join(__dirname, '..', '..');

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(full, out);
      } else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
    }
    return out;
  };

  const FILES = walk(SRC).map((full) => ({
    key: full.slice(SRC.length + 1).split('\\').join('/'),
    src: readFileSync(full, 'utf8'),
  }));

  it('файлы нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.map((f) => f.key)).toContain(HOME);
  });

  it('formatDuration заново не объявляют', () => {
    const offenders = FILES.filter((f) => /function formatDuration\s*\(/.test(f.src)).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('никто не собирает «мм:сс» из остатка от деления на 60', () => {
    // Пара «остаток от 60» + «дополнить до двух цифр» в одном файле — это и
    // есть переписанная заново длительность.
    const offenders = FILES.filter(
      (f) => f.key !== HOME && /%\s*60\b/.test(f.src) && /padStart\(2/.test(f.src)
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('никто не собирает «N мин N с» из остатка от деления на 60000', () => {
    const offenders = FILES.filter(
      (f) => f.key !== HOME && /%\s*60[_]?000\b/.test(f.src) && /мин/.test(f.src)
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });
});
