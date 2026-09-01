/**
 * Храповик на дверь наружу.
 *
 * v4.32.420. Проверка схемы жила в девяти местах, и одно из них уже сгнило в
 * тождественно истинное условие. Чинить девять копий бессмысленно, если
 * десятую можно дописать завтра, — поэтому здесь стоит правило о правиле:
 * файл, который зовёт `Linking.openURL`, обязан либо звать общую дверь, либо
 * лежать в списке ниже с причиной.
 *
 * Список — не индульгенция, а место, где причина записана и видна на ревью.
 *
 * v4.32.535. Список опустел, и правило стало строже. Проверять адрес научились
 * в 420, но ОТКРЫВАТЬ его каждое место продолжало само, и почти везде отказ
 * системы глушился пустым перехватом. Теперь `Linking.openURL` зовёт ровно
 * один файл — `ui/utils/openExternal`, — и исключений из этого нет: карта,
 * документ и ссылка в тексте идут туда же. Поэтому вместо «не меньше восьми
 * вызовов, у каждого причина» здесь проверяется «вызывающий ровно один».
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** Единственный файл, которому позволено звать `Linking.openURL`. */
const THE_DOOR = 'ui/utils/openExternal.ts';

/** Все .ts/.tsx под src, кроме тестов. */
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

/** Строки файла без комментариев: упоминание в комментарии — не вызов. */
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

describe('всё, что открывается наружу, проходит через одну дверь', () => {
  const callers: string[] = [];

  for (const file of collect(SRC)) {
    const lines = codeLines(readFileSync(file, 'utf8'));
    if (!lines.some((l) => l.includes('Linking.openURL'))) continue;
    callers.push(relKey(file));
  }

  it('вызывающий ровно один — и это дверь', () => {
    expect(callers).toEqual([THE_DOOR]);
  });

  it('дверь и правда зовёт проверку адреса', () => {
    const door = readFileSync(join(SRC, THE_DOOR), 'utf8');
    expect(door).toMatch(/core\/net\/externalLink/);
    expect(door).toMatch(/core\/net\/mapLink/);
  });

  it('за дверью отказ не глушится пустым перехватом', () => {
    const door = readFileSync(join(SRC, THE_DOOR), 'utf8');
    expect(codeLines(door).join('\n')).not.toContain('.catch(() => {})');
  });

  it('никто не проверяет схему собственной строкой рядом с openURL', () => {
    // Именно так выглядела каждая из девяти копий. Форма запрещена целиком:
    // пройдёт она или нет — решать должна дверь, а не место вызова.
    const offenders: string[] = [];
    for (const file of collect(SRC)) {
      const key = relKey(file);
      const lines = codeLines(readFileSync(file, 'utf8'));
      if (!lines.some((l) => l.includes('Linking.openURL'))) continue;
      // Именно ПРЕДИКАТ, а не любое упоминание схемы: обрезать `https://`
      // для показа — не проверка, и запрещать это незачем.
      if (lines.some((l) => /\/\^https\?:/.test(l) && l.includes('.test('))) offenders.push(key);
    }
    expect(offenders).toEqual([]);
  });
});
