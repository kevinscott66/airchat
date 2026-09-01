/**
 * Заниженное число голосовых в статистике профиля (v4.32.585).
 *
 * Голосовые считаются расшифровкой последних строк, и обе причины ошибиться —
 * непрочитанная строка и потолок обхода — молчали: строка уходила в `catch {}`
 * как не-голосовая, потолок писался в журнал, которого человек не видит. На
 * экран выходило точное на вид число, на деле бывшее нижней границей.
 */
import fs from 'fs';
import path from 'path';

import {
  approxCountLabel,
  approxCountNotice,
  approxIsExact,
  exactCount,
  type ApproxCount,
} from '../approxCount';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
const PROFILE = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ProfileScreen.tsx'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const approx = (value: number, unreadable: number, capped: boolean): ApproxCount => ({ value, unreadable, capped });

describe('счётчик признаётся в своей неточности', () => {
  it('точен только когда всё прочитано и потолок не задет', () => {
    expect(approxIsExact(exactCount(7))).toBe(true);
    expect(approxIsExact(approx(7, 1, false))).toBe(false);
    expect(approxIsExact(approx(7, 0, true))).toBe(false);
  });

  it('неточное число показывается как нижняя граница', () => {
    expect(approxCountLabel(exactCount(12))).toBe('12');
    expect(approxCountLabel(approx(12, 3, false))).toBe('≥ 12');
    expect(approxCountLabel(approx(12, 0, true))).toBe('≥ 12');
    expect(approxCountLabel(approx(-4, 0, false))).toBe('0');
  });

  it('подпись называет каждую причину и складывает их вместе', () => {
    expect(approxCountNotice(exactCount(12))).toBeNull();
    expect(approxCountNotice(approx(0, 1, false))).toBe('точное число неизвестно: 1 сообщение не удалось прочитать');
    expect(approxCountNotice(approx(0, 3, false))).toBe('точное число неизвестно: 3 сообщения не удалось прочитать');
    expect(approxCountNotice(approx(0, 11, false))).toBe('точное число неизвестно: 11 сообщений не удалось прочитать');
    expect(approxCountNotice(approx(5, 0, true))).toBe('точное число неизвестно: просмотрены не все сообщения');
    expect(approxCountNotice(approx(5, 2, true)))
      .toBe('точное число неизвестно: 2 сообщения не удалось прочитать, просмотрены не все сообщения');
  });

  it('нулевая и отрицательная непрочитанность причиной не считается', () => {
    expect(approxCountNotice(approx(5, 0, false))).toBeNull();
    expect(approxCountNotice(approx(5, -3, false))).toBeNull();
  });

  it('модуль зависит только от такого же чистого правила окончаний', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'approxCount.ts'), 'utf8');
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import { pluralRu } from './ruPlural';"]);
  });
});

describe('статистика профиля считает голосовые честно', () => {
  it('непрочитанная строка не объявляется не-голосовой', () => {
    const body = slice(LOCAL(), 'export async function getProfileStats(', 'export async function');
    expect(body).toContain("if (cell.state === 'unreadable') { unreadable++; continue; }");
    expect(body).not.toContain('// skip undecryptable rows');
    expect(body).not.toContain("decryptAtRestString(r.text, dek).startsWith('\\x01voice:')");
  });

  it('потолок обхода едет на экран, а не только в журнал', () => {
    const body = slice(LOCAL(), 'export async function getProfileStats(', 'export async function');
    expect(body).toContain('const capped = voiceCandidateRows.length >= VOICE_SCAN_CAP;');
    expect(body).toContain('const voicesSent: ApproxCount = { value: voices, unreadable, capped };');
    expect(body).toContain("log.warn('profile_stats_voices_scan_capped'");
  });

  it('сбой чтения отдаёт честный ноль, а не выдуманную точность', () => {
    expect(LOCAL()).toContain('voicesSent: exactCount(0)');
  });

  it('экран показывает нижнюю границу и объясняет её', () => {
    const src = PROFILE();
    expect(src).toContain('{approxCountLabel(stats.voicesSent)}');
    expect(src).toContain('{approxCountNotice(stats.voicesSent)}');
    expect(src).toContain('stats.voicesSent.value > 0');
    expect(src).not.toContain('{stats.voicesSent}');
  });
});
