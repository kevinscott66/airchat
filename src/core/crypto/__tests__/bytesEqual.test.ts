/**
 * Рэтчет к v4.32.542 — сравнение байтов одно на всё приложение.
 *
 * Копий было три, и одна выходила на первом несовпадении. Тест следит не
 * столько за самой функцией (она в шесть строк), сколько за тем, чтобы рядом
 * не завелась четвёртая: именно наличие выбора и есть дефект — тот, кому
 * завтра понадобится сверить секрет, возьмёт ближайшую.
 */
import fs from 'fs';
import path from 'path';

import { bytesEqualConstTime } from '../bytesEqual';

const SRC = path.join(__dirname, '../../..');
const HOME = path.join(SRC, 'core/crypto/bytesEqual.ts');

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...collect(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const FILES = collect(SRC).filter((f) => f !== HOME);

const b = (...v: number[]): Uint8Array => Uint8Array.from(v);

describe('bytesEqualConstTime', () => {
  it('одинаковые массивы равны', () => {
    expect(bytesEqualConstTime(b(1, 2, 3), b(1, 2, 3))).toBe(true);
  });

  it('пустые массивы равны', () => {
    expect(bytesEqualConstTime(b(), b())).toBe(true);
  });

  it('разница в первом байте видна', () => {
    expect(bytesEqualConstTime(b(9, 2, 3), b(1, 2, 3))).toBe(false);
  });

  it('разница в последнем байте видна — цикл не обрывается досрочно', () => {
    expect(bytesEqualConstTime(b(1, 2, 3), b(1, 2, 4))).toBe(false);
  });

  it('разная длина — не равны, и без обращения за границу массива', () => {
    expect(bytesEqualConstTime(b(1, 2), b(1, 2, 3))).toBe(false);
    expect(bytesEqualConstTime(b(1, 2, 3), b(1, 2))).toBe(false);
  });

  it('различающиеся биты внутри байта не теряются', () => {
    // 0b1000_0000 против 0b0000_0000: разница только в старшем бите.
    expect(bytesEqualConstTime(b(128), b(0))).toBe(false);
  });

  it('накопленная разница не обнуляется следующим совпадением', () => {
    expect(bytesEqualConstTime(b(1, 5, 5, 5), b(2, 5, 5, 5))).toBe(false);
  });

  it('длинные одинаковые массивы всё же равны', () => {
    const x = new Uint8Array(64).fill(7);
    const y = new Uint8Array(64).fill(7);
    expect(bytesEqualConstTime(x, y)).toBe(true);
    y[63] = 8;
    expect(bytesEqualConstTime(x, y)).toBe(false);
  });
});

describe('четвёртой копии не заводится', () => {
  it('рукописного сравнения байтов в исходниках нет', () => {
    const HAND = /function bytesEqual\s*\(/;
    const offenders = FILES.filter((f) => HAND.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('досрочного выхода из сравнения байтов нет', () => {
    // Ровно так была написана copy в contacts.ts: время ответа выдавало,
    // сколько байт совпало с начала.
    const EARLY = /for \(let i = 0; i < a\.length; i\+\+\) if \(a\[i\] !== b\[i\]\) return false;/;
    const offenders = FILES.filter((f) => EARLY.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('запрет не холостой: обе исторические формы ловятся', () => {
    expect(/function bytesEqual\s*\(/.test('function bytesEqual(a: Uint8Array, b: Uint8Array) {')).toBe(true);
    expect(
      /for \(let i = 0; i < a\.length; i\+\+\) if \(a\[i\] !== b\[i\]\) return false;/
        .test('  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;'),
    ).toBe(true);
  });

  it('дом сравнения не тянет за собой ни одного импорта', () => {
    const home = fs.readFileSync(HOME, 'utf8');
    expect(home.split('\n').filter((l) => l.startsWith('import '))).toEqual([]);
  });

  it('прежний адрес остался работающим реэкспортом — импорты не переписаны наспех', () => {
    const dek = fs.readFileSync(path.join(SRC, 'core/storage/dekDerivation.ts'), 'utf8');
    expect(dek).toContain("export { bytesEqualConstTime } from '../crypto/bytesEqual';");
  });
});
