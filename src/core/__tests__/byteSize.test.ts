/**
 * Вес файла словами: одна подпись, десятичные единицы, и она совпадает с
 * подписью предела.
 *
 * v4.32.422.
 */
import { formatByteSize } from '../media/byteSize';
import { MAX_BLOB_BYTES } from '../media/blobRef';
import { IPFS_DOC_MAX_BYTES, IPFS_VIDEO_MAX_BYTES, formatLimit } from '../media/uploadRoute';

describe('formatByteSize', () => {
  it('байты остаются байтами', () => {
    expect(formatByteSize(0)).toBe('0 Б');
    expect(formatByteSize(1)).toBe('1 Б');
    // Раньше в ленте и в «Общих файлах» это было «0 KB».
    expect(formatByteSize(400)).toBe('400 Б');
    expect(formatByteSize(999)).toBe('999 Б');
  });

  it('килобайты — целыми', () => {
    expect(formatByteSize(1_000)).toBe('1 КБ');
    expect(formatByteSize(1_500)).toBe('2 КБ');
    expect(formatByteSize(12_345)).toBe('12 КБ');
  });

  it('округление не порождает «1000 КБ»', () => {
    // 999 999 байт округляются до 1000 КБ — единицы не существует.
    expect(formatByteSize(999_999)).toBe('1 МБ');
    expect(formatByteSize(999_499)).toBe('999 КБ');
  });

  it('мегабайты — с одним знаком и без хвостового нуля', () => {
    expect(formatByteSize(1_200_000)).toBe('1.2 МБ');
    expect(formatByteSize(8_000_000)).toBe('8 МБ');
    // Раньше здесь было «50.0 МБ» в одном месте и «51200 KB» в другом.
    expect(formatByteSize(52_428_800)).toBe('52.4 МБ');
  });

  it('гигабайты существуют', () => {
    expect(formatByteSize(2_500_000_000)).toBe('2.5 ГБ');
    expect(formatByteSize(999_999_999)).toBe('1 ГБ');
  });

  it('неизвестный размер — пустая строка, а не «0 KB» и не «NaN»', () => {
    for (const bad of [null, undefined, NaN, Infinity, -1, -0.5, '12' as unknown as number]) {
      expect(formatByteSize(bad as number)).toBe('');
    }
  });

  it('округление вниз ничего не обещает сверх', () => {
    expect(formatByteSize(8_990_000)).toBe('9 МБ');
    expect(formatByteSize(8_990_000, { roundDown: true })).toBe('8.9 МБ');
    expect(formatByteSize(999_999, { roundDown: true })).toBe('999 КБ');
  });
});

describe('подпись предела и подпись файла — одна и та же', () => {
  it('файл ровно на пределе подписан тем же числом, что и отказ', () => {
    // Это и был дефект: отказ говорил «предел 8 МБ», а тот же файл в переписке
    // был подписан «7.6 МБ» — делением на 1024 при десятичном пределе.
    for (const limit of [MAX_BLOB_BYTES, IPFS_VIDEO_MAX_BYTES, IPFS_DOC_MAX_BYTES]) {
      expect(formatLimit(limit)).toBe(formatByteSize(limit));
    }
    expect(formatLimit(MAX_BLOB_BYTES)).toBe('8 МБ');
    expect(formatLimit(IPFS_VIDEO_MAX_BYTES)).toBe('25 МБ');
    expect(formatLimit(IPFS_DOC_MAX_BYTES)).toBe('50 МБ');
  });
});

describe('копий подписи больше нет', () => {
  const HOME = 'core/media/byteSize.ts';

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

  /**
   * Хвостовой комментарий отрезается по-настоящему, с оглядкой на строки:
   * `// 1.2 MB` в конце строки кода — пояснение, а `'https://'` — не начало
   * комментария.
   */
  const stripLineComment = (line: string): string => {
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
  };

  /** Строки без комментариев: «до 8 МБ» в пояснении — не подпись на экране. */
  const codeLines = (source: string): string[] => {
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
  };

  const FILES = walk(SRC).map((full) => ({
    key: full.slice(SRC.length + 1).split('\\').join('/'),
    lines: codeLines(readFileSync(full, 'utf8')),
  }));

  it('файлы нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.map((f) => f.key)).toContain(HOME);
  });

  it('единицы размера пишутся только в byteSize', () => {
    const UNIT = /['"`][^'"`]*(КБ|МБ|ГБ)\b/;
    const offenders = FILES.filter((f) => f.key !== HOME && f.lines.some((l) => UNIT.test(l))).map(
      (f) => f.key
    );
    expect(offenders).toEqual([]);
  });

  it('латинских KB/MB в подписях нет вовсе', () => {
    // «51200KB» посреди русского интерфейса — это была не единица, а недосмотр.
    // Отрицательный просмотр назад пропускает BYTES_PER_KB — там перед «KB»
    // символ имени, а не пробел после числа.
    const LATIN = /(?<![A-Za-z0-9_])(KB|MB|GB)\b/;
    const offenders = FILES.filter((f) => f.lines.some((l) => LATIN.test(l))).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('никто не делит размер на 1024 ради подписи', () => {
    // Пределы десятичные; деление на 1024 рядом с текстом — это расхождение
    // подписи с проверкой. Двоичные потолки внутри транспорта законны, поэтому
    // ловится пара: деление на 1024 И вывод единицы в той же строке.
    const offenders = FILES.filter(
      (f) =>
        f.key !== HOME &&
        f.lines.some((l) => /\/\s*\(?1024/.test(l) && /(КБ|МБ|ГБ|KB|MB|GB)/.test(l))
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });
});
