/**
 * Храповик на календарь.
 *
 * v4.32.421. Правило «сегодня / вчера / день недели» жило в шести копиях, и
 * все шесть считали дни разностью в миллисекундах. Чинить копии бессмысленно,
 * если седьмую можно дописать завтра, — поэтому здесь запрещены сами формы, из
 * которых копия складывается: собственный массив дней недели и сравнение
 * «сегодня ли это» через `toDateString()` или через сравнение полей даты.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** Единственное место, где массив дней недели уместен. */
const WEEKDAY_HOME = 'core/time/calendarTime.ts';

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collect(full, out);
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Строки файла без комментариев: упоминание в комментарии — не код. */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

function relKey(full: string): string {
  return full.slice(SRC.length + 1).split('\\').join('/');
}

const FILES = collect(SRC).map((full) => ({
  key: relKey(full),
  lines: codeLines(readFileSync(full, 'utf8')),
}));

describe('календарные дни считаются в одном месте', () => {
  it('файлы вообще нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.map((f) => f.key)).toContain(WEEKDAY_HOME);
  });

  it('массив дней недели существует ровно в одном файле', () => {
    const offenders = FILES.filter(
      (f) => f.key !== WEEKDAY_HOME && f.lines.some((l) => l.includes("'вс', 'пн'"))
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('никто не спрашивает «сегодня ли это» через toDateString', () => {
    // `a.toDateString() === b.toDateString()` — сравнение текста двух дат:
    // работает, пока обе в одной локали, и молча ломается на смене формата.
    const offenders = FILES.filter((f) =>
      f.lines.some((l) => (l.match(/toDateString\(\)/g) ?? []).length >= 2)
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('никто не собирает «тот же день» из getDate и getMonth', () => {
    // Ровно так была написана копия в списке чатов — и в ней потерялся год.
    const offenders = FILES.filter(
      (f) =>
        f.key !== WEEKDAY_HOME &&
        f.lines.some((l) => l.includes('.getDate() ===') && !l.includes('setDate'))
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('никто не называет день недели по порогу в сутках', () => {
    // `diff < 7 * 24 * 3_600_000` рядом с `getDay()` — это «включая тот же день
    // недели неделю назад». Семидневное окно само по себе законно (срок
    // хранения, срок ссылки), поэтому ловится именно пара: окно И обращение к
    // дню недели в одном файле.
    const WEEK_MS = /7\s*\*\s*24\s*\*\s*3[_,]?600[_,]?000|7\s*\*\s*86[_,]?400[_,]?000/;
    const offenders = FILES.filter(
      (f) =>
        f.key !== WEEKDAY_HOME &&
        f.lines.some((l) => l.includes('.getDay()')) &&
        f.lines.some((l) => WEEK_MS.test(l))
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('день недели называют только два места — и оба через calendarTime', () => {
    // Невырожденность: если завтра `getDay()` не останется нигде, предыдущая
    // проверка станет пустой и перестанет что-либо стеречь.
    const users = FILES.filter((f) => f.lines.some((l) => l.includes('.getDay()'))).map((f) => f.key);
    expect(users).toContain(WEEKDAY_HOME);
    for (const key of users) {
      if (key === WEEKDAY_HOME) continue;
      const f = FILES.find((x) => x.key === key);
      expect(f?.lines.some((l) => l.includes('calendarTime'))).toBe(true);
    }
  });
});
