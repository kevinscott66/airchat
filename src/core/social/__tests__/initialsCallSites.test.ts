/**
 * Храповик на буквы в кружке аватара.
 *
 * v4.32.424. Первая буква и пара букв считались вручную в восьми местах, и
 * совпадали не все. Общего у всех ручных форм одно: они режут строку по
 * единицам UTF-16 (`[0]`, `.charAt(0)`, `.slice(0, 2)`), а не по кодовым
 * точкам, — то есть у имени, начинающегося с эмодзи, в кружке половина
 * суррогатной пары, пустой прямоугольник. И ни одна не пропускала невидимый
 * ведущий символ, который приходит по сети вместе с именем.
 *
 * Чинить восемь копий бессмысленно, если девятую можно дописать завтра.
 * Поэтому здесь запрещена сама форма: заглавная буква рядом с обрезкой строки
 * по индексу. Единственный дом обеих функций — core/social/contactLabel.ts.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');
const HOME = 'core/social/contactLabel.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Хвостовой комментарий отрезается с оглядкой на строки: `'//'` внутри кавычек — не комментарий. */
function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Строки без комментариев: упоминание формы в пояснении — не код. */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    const code = stripLineComment(line).trim();
    if (code) out.push(code);
  }
  return out;
}

const FILES = walk(SRC).map((full) => ({
  key: full.slice(SRC.length + 1).split('\\').join('/'),
  lines: codeLines(readFileSync(full, 'utf8')),
}));

/** Обрезка строки по индексу — ровно те формы, которыми писались копии. */
const CUT = /\[\s*0\s*\]|\.charAt\(\s*0\s*\)|\.slice\(\s*0\s*,\s*[12]\s*\)|\.substr(?:ing)?\(\s*0\s*,\s*[12]\s*\)/;

describe('буквы в кружке считаются в одном месте', () => {
  it('файлы нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.map((f) => f.key)).toContain(HOME);
  });

  it('никто не собирает букву аватара вручную', () => {
    // Заглавная буква рядом с обрезкой строки по индексу в одной строке кода —
    // это и есть ручная форма. `translateLang.toUpperCase()` под неё не
    // подходит: там нет обрезки.
    const offenders = FILES.filter(
      (f) =>
        f.key !== HOME &&
        f.lines.some((l) => l.includes('toUpperCase()') && CUT.test(l))
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('форма ловится — иначе запрет пустой', () => {
    // Невырожденность: если завтра CUT перестанет что-либо находить, проверка
    // выше станет тавтологией. Здесь она проверяется на тех самых строках,
    // которые были в коде до этого раунда.
    for (const line of [
      "const initial = (displayName[0] ?? '?').toUpperCase();",
      "<Text>{didToName(did)[0]?.toUpperCase() ?? '?'}</Text>",
      '<Text>{name.slice(0, 1).toUpperCase()}</Text>',
      "const [a, b] = name.split(' '); return (a[0] + b[0]).toUpperCase();",
      'return name.slice(0, 2).toUpperCase();',
      'return name.charAt(0).toUpperCase();',
    ]) {
      expect(line.includes('toUpperCase()') && CUT.test(line)).toBe(true);
    }
    // А законные — не ловятся.
    for (const line of [
      "badge={translateLang.toUpperCase()}",
      "const method = (init?.method ?? 'GET').toUpperCase();",
      "const short = did.slice(0, 12);",
    ]) {
      expect(line.includes('toUpperCase()') && CUT.test(line)).toBe(false);
    }
  });

  it('экранные точки зовут именно контактную функцию', () => {
    // Невырожденность с другой стороны: запрет имеет смысл, только пока буквы
    // на аватарах вообще кто-то рисует.
    const users = FILES.filter(
      (f) => f.key !== HOME && f.lines.some((l) => /\bnameInitials?\s*\(/.test(l))
    ).map((f) => f.key);
    expect(users.length).toBeGreaterThanOrEqual(7);
    for (const key of users) {
      const f = FILES.find((x) => x.key === key);
      expect(f?.lines.some((l) => l.includes('social/contactLabel'))).toBe(true);
    }
  });
});
