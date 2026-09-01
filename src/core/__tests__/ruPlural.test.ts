/**
 * Русское склонение: одно правило вместо трёх, и на числах, где короткая
 * запись врала.
 *
 * v4.32.421.
 */
import { ruPlural } from '../text/ruPlural';
import { lastSeenLabel } from '../time/lastSeenLabel';
import { formatDisappearLabel } from '../social/disappearEnvelope';

const HOURS = ['час', 'часа', 'часов'] as const;

describe('ruPlural', () => {
  it('склоняет по последней цифре', () => {
    expect(ruPlural(1, HOURS)).toBe('час');
    expect(ruPlural(2, HOURS)).toBe('часа');
    expect(ruPlural(4, HOURS)).toBe('часа');
    expect(ruPlural(5, HOURS)).toBe('часов');
    expect(ruPlural(0, HOURS)).toBe('часов');
  });

  it('одиннадцать–четырнадцать — исключение', () => {
    for (const n of [11, 12, 13, 14]) expect(ruPlural(n, HOURS)).toBe('часов');
  });

  it('второй десяток и дальше — снова по последней цифре', () => {
    expect(ruPlural(21, HOURS)).toBe('час');
    expect(ruPlural(22, HOURS)).toBe('часа');
    expect(ruPlural(23, HOURS)).toBe('часа');
    expect(ruPlural(25, HOURS)).toBe('часов');
    expect(ruPlural(101, HOURS)).toBe('час');
    expect(ruPlural(111, HOURS)).toBe('часов');
  });
});

describe('подписи, которые это правило читают', () => {
  it('«был(а) 22 часа назад», а не «22 часов»', () => {
    // Короткая копия правила (`hrs < 5 ? 'часа' : 'часов'`) совпадала с
    // правильной на 1–4 и врала на 21–23 — а диапазон здесь до 23.
    const now = new Date(2026, 7, 17, 23, 0).getTime();
    expect(lastSeenLabel(now - 22 * 3_600_000, now).label).toBe('был(а) 22 часа назад');
    expect(lastSeenLabel(now - 21 * 3_600_000, now).label).toBe('был(а) 21 час назад');
    expect(lastSeenLabel(now - 11 * 3_600_000, now).label).toBe('был(а) 11 часов назад');
  });

  it('таймер исчезающих сообщений склоняется тем же правилом', () => {
    expect(formatDisappearLabel(86_400_000)).toBe('1 день');
    expect(formatDisappearLabel(2 * 86_400_000)).toBe('2 дня');
    expect(formatDisappearLabel(7 * 86_400_000)).toBe('7 дней');
    expect(formatDisappearLabel(3_600_000)).toBe('1 час');
    expect(formatDisappearLabel(0)).toBe('Выкл');
  });
});

describe('копий правила больше нет', () => {
  it('склонение по «n < 5» нигде не пишется заново', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync, readFileSync, statSync } = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path') as typeof import('path');
    const SRC = join(__dirname, '..', '..');
    const HOME = 'core/text/ruPlural.ts';
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules') continue;
          walk(full, out);
        } else if (/\.tsx?$/.test(name)) out.push(full);
      }
      return out;
    };
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .map((f) => ({ key: f.slice(SRC.length + 1), src: readFileSync(f, 'utf8') }))
      .filter((f) => f.key !== HOME && /function ruPlural\s*\(/.test(f.src))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });
});
