/**
 * Отказ записи реакции называет причину (v4.32.599).
 *
 * `toggleReaction` возвращала `{ on } | null`, и в этом `null` жили четыре
 * разных исхода: строки сообщения нет; столбец с реакциями не открылся нашим
 * ключом (писать в него запрещено с v4.32.544 — иначе прежние реакции были бы
 * стёрты необратимо); карта упёрлась в потолок различных эмодзи (v4.32.509);
 * запрос к базе упал.
 *
 * Слоем выше все четыре превращались в «Сообщение не найдено». Человек читал
 * про пропавшее сообщение, глядя прямо на него, — и шёл искать не ту беду,
 * пока настоящая, ключ, не открывающий часть его же данных, оставалась
 * неназванной. Ровно то, что v4.32.447 исправила этажом выше.
 */
import fs from 'fs';
import path from 'path';

import { reactionWriteFailureText, type ReactionWriteFailure } from '../reactionWrite';

const WRITE = () => fs.readFileSync(path.join(__dirname, '..', 'reactionWrite.ts'), 'utf8');
const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const SYNC = () => fs.readFileSync(path.join(__dirname, '..', 'reactionSync.ts'), 'utf8');

/** Кусок файла между двумя опорами — чтобы утверждение не ловило соседей. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const ALL: ReactionWriteFailure[] = ['missing', 'unreadable', 'limit', 'ownLimit', 'failed'];

describe('текст отказа', () => {
  it('у каждой причины он свой', () => {
    const texts = ALL.map(reactionWriteFailureText);
    expect(new Set(texts).size).toBe(ALL.length);
  });

  it('пустого текста нет ни у одной', () => {
    for (const reason of ALL) expect(reactionWriteFailureText(reason).trim().length).toBeGreaterThan(0);
  });

  it('непрочитанный столбец назван прямо, а не «сообщение не найдено»', () => {
    const t = reactionWriteFailureText('unreadable');
    expect(t).toContain('ключ');
    expect(t).not.toContain('не найдено');
  });

  it('потолок реакций не выдаётся за пропавшее сообщение', () => {
    expect(reactionWriteFailureText('limit')).not.toContain('не найдено');
    expect(reactionWriteFailureText('ownLimit')).not.toContain('не найдено');
  });

  // v4.32.608: «слишком много реакций» — это два разных исхода. Свой потолок
  // человек снимает сам; общий он не снимет никак, и звать его снимать —
  // отправлять искать среди своих реакций то, чего там нет.
  it('свой потолок зовёт снять реакцию, общий — нет', () => {
    expect(reactionWriteFailureText('ownLimit')).toContain('снимите');
    expect(reactionWriteFailureText('limit')).not.toContain('снимите');
  });

  it('про сбой базы не сказано «попробуйте ещё раз» там, где повтор не поможет', () => {
    expect(reactionWriteFailureText('missing')).toBe('Сообщение не найдено');
    expect(reactionWriteFailureText('failed')).toBe('Не удалось сохранить реакцию');
  });

  it('правило живёт отдельно и ничего за собой не тянет', () => {
    // v4.32.608: единственный импорт — свод потолков, откуда берётся число в
    // тексте. Ни react-native, ни журнала, ни хранилища здесь нет.
    const imports = WRITE().split('\n').filter((l) => l.startsWith('import '));
    expect(imports).toEqual([
      "import { MAX_REACTIONS_PER_ACTOR, type ReactionLimit } from './reactionMapPolicy';",
    ]);
  });
});

describe('запись в свою базу', () => {
  it('ни один выход не возвращает безмолвный null', () => {
    const body = slice(LOCAL(), 'export async function toggleReaction(', '\n// ─── Groups & Channels');
    expect(body.split('\n').filter((l) => l.trim() === 'return null;')).toEqual([]);
  });

  it('каждая из причин названа своим словом', () => {
    const body = slice(LOCAL(), 'export async function toggleReaction(', '\n// ─── Groups & Channels');
    expect(body).toContain("return { ok: false, reason: 'missing' };");
    expect(body).toContain("return { ok: false, reason: 'unreadable' };");
    expect(body).toContain("return { ok: false, reason: limit === 'actor' ? 'ownLimit' : 'limit' };");
    expect(body).toContain("return { ok: false, reason: 'failed' };");
    expect(body).toContain('return { ok: true, on: next };');
  });

  it('отказ по непрочитанному столбцу стоит ДО записи', () => {
    const body = slice(LOCAL(), 'export async function toggleReaction(', '\n// ─── Groups & Channels');
    expect(body.indexOf("reason: 'unreadable'")).toBeLessThan(body.indexOf('SET reactions = ?'));
  });

  it('тип итога берётся из общего модуля, а не описан на месте', () => {
    const src = LOCAL();
    expect(src).toMatch(/^import type \{ ReactionWriteResult \} from '\.\.\/social\/reactionWrite';$/m);
    expect(src).toContain('): Promise<ReactionWriteResult> {');
  });
});

describe('слой выше', () => {
  it('свой единственный текст на четыре причины больше не держит', () => {
    const src = SYNC();
    expect(src).toContain('if (!res.ok) return { ok: false, reason: reactionWriteFailureText(res.reason) };');
    expect(src).not.toContain("if (!res) return { ok: false, reason: 'Сообщение не найдено' };");
  });

  it('чужая реакция роняется с причиной в журнале', () => {
    const body = slice(SYNC(), 'export async function handleIncomingReaction(', '\n}\n');
    expect(body).toContain('if (!res.ok) {');
    expect(body).toContain('reason: res.reason,');
  });

  it('тексты отказов сюда не переписаны', () => {
    expect(SYNC()).not.toContain('Реакции этого сообщения не удалось прочитать');
  });
});
