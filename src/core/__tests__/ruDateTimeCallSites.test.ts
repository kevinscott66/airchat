/**
 * Храповик на дату и время.
 *
 * v4.32.426. Приложение говорит только по-русски: i18n поднят с `lng: 'ru'`,
 * словарь один, переключателя нет. Значит, любое обращение к Intl — это
 * подпись на языке телефона внутри русского окна, и запретить надо не копии,
 * а саму форму: `toLocaleDateString`, `toLocaleTimeString`, `toLocaleString`
 * и собственный массив русских месяцев.
 *
 * Запрет здесь полный, без «дома-исключения»: ruDateTime тоже обходится без
 * Intl. Появится нужда в настоящей локализации — сначала появится словарь
 * второго языка, и тогда это правило меняют осознанно, а не молча.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** Единственное место, где русские названия месяцев записаны словами. */
const HOME = 'core/time/ruDateTime.ts';

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

const INTL = /\.toLocale(?:Date|Time)?String\(/;
const MONTHS = /'янв'|'января'|"янв"|"января"/;

describe('дата и время не спрашивают язык у телефона', () => {
  it('файлы вообще нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.map((f) => f.key)).toContain(HOME);
  });

  it('Intl не зовут нигде', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      for (const line of f.lines) if (INTL.test(line)) offenders.push(`${f.key}: ${line}`);
    }
    expect(offenders).toEqual([]);
  });

  it('русские месяцы записаны ровно в одном файле', () => {
    const offenders = FILES.filter((f) => f.key !== HOME && f.lines.some((l) => MONTHS.test(l)))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('запрещённые формы действительно опознаются', () => {
    // Невырожденность: без этого обе проверки зелены и на пустом правиле.
    expect(INTL.test("const d = new Date(m.createdAt).toLocaleString();")).toBe(true);
    expect(INTL.test("new Date(ts).toLocaleDateString('ru-RU')")).toBe(true);
    expect(INTL.test("date.toLocaleTimeString(undefined, { hour: '2-digit' })")).toBe(true);
    expect(MONTHS.test("const MONTHS = ['янв','фев','мар'];")).toBe(true);
  });

  it('похожее, но законное, под правило не попадает', () => {
    // Обратная невырожденность: правило, ловящее всё подряд, обросло бы
    // исключениями и перестало что-либо значить.
    expect(INTL.test("const s = String(ts);")).toBe(false);
    expect(INTL.test("value.toString();")).toBe(false);
    expect(INTL.test("const label = localeName(code);")).toBe(false);
    expect(MONTHS.test("const label = 'январь';")).toBe(false);
  });

  it('подписи зовут отовсюду, где раньше был свой Intl', () => {
    const users = FILES.filter((f) => f.lines.some((l) => l.includes("time/ruDateTime'"))).map((f) => f.key);
    expect(users.length).toBeGreaterThanOrEqual(18);
  });
});
