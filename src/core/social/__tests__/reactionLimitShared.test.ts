/**
 * Один потолок реакций на всё: сообщение, пост, комментарий (v4.32.608).
 *
 * Измеренный дефект. У сообщений потолок стоял с v4.32.509 и был
 * двухуровневым: восемь различных эмодзи на участника плюс шестьдесят четыре
 * ключа на запись. В ленте же ограничивалось только общее число ключей (64) и
 * число авторов на один эмодзи (512), а сколько эмодзи вправе навесить ОДИН
 * человек — не ограничивалось ничем. Один контакт в одиночку занимал все
 * шестьдесят четыре ключа поста или комментария: строка в базе раздувалась, а
 * под записью вырастала лента чипов, которую рисовали все остальные.
 *
 * Второй дефект того же места — молчание. Отказ потолком в ленте выглядел как
 * успех: `addReaction` возвращала `void`, вызывающий рассылал эмодзи
 * контактам, экран оставлял его нарисованным, а в базе не было ничего.
 *
 * Здесь проверяется и правило, и то, что все три пути зовут именно его, а не
 * свои числа рядом.
 */
import fs from 'fs';
import path from 'path';

import {
  MAX_REACTIONS_PER_ACTOR,
  MAX_REACTION_ACTORS_PER_KEY,
  MAX_REACTION_KEYS,
  applyReaction,
  canAddReaction,
  reactionAddRefusal,
  type ReactionMap,
} from '../reactionMapPolicy';
import { isReactionLimitError, reactionLimitError, reactionLimitText } from '../reactionWrite';

const SRC = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

/** Кусок файла между двумя опорами — чтобы утверждение не ловило соседей. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Карта, где `actor` уже держит `n` различных эмодзи. */
function mapWithOwn(actor: string, n: number): ReactionMap {
  const map: ReactionMap = {};
  for (let i = 0; i < n; i++) map[`e${i}`] = [actor];
  return map;
}

describe('правило', () => {
  it('один человек не занимает запись в одиночку', () => {
    const map = mapWithOwn('me', MAX_REACTIONS_PER_ACTOR);
    expect(Object.keys(map).length).toBeLessThan(MAX_REACTION_KEYS);
    expect(reactionAddRefusal(map, 'новый', 'me')).toBe('actor');
    // Место на записи ещё есть — отказ именно личный, и другому он не мешает.
    expect(reactionAddRefusal(map, 'новый', 'кто-то другой')).toBeNull();
  });

  it('уже поставленное своё не считается добавлением', () => {
    const map = mapWithOwn('me', MAX_REACTIONS_PER_ACTOR);
    expect(reactionAddRefusal(map, 'e0', 'me')).toBeNull();
  });

  it('общий потолок ключей назван отдельным словом', () => {
    const map: ReactionMap = {};
    for (let i = 0; i < MAX_REACTION_KEYS; i++) map[`e${i}`] = [`actor${i}`];
    expect(reactionAddRefusal(map, 'новый', 'me')).toBe('keys');
    // Уже существующий ключ добавить можно: строка от этого не растёт ключами.
    expect(reactionAddRefusal(map, 'e0', 'me')).toBeNull();
  });

  it('толпа на одном эмодзи тоже ограничена', () => {
    const crowd = Array.from({ length: MAX_REACTION_ACTORS_PER_KEY }, (_, i) => `a${i}`);
    expect(reactionAddRefusal({ '👍': crowd }, '👍', 'me')).toBe('actors');
  });

  it('canAddReaction — та же проверка без причины', () => {
    const map = mapWithOwn('me', MAX_REACTIONS_PER_ACTOR);
    expect(canAddReaction(map, 'новый', 'me')).toBe(false);
    expect(canAddReaction(map, 'e0', 'me')).toBe(true);
  });

  it('снятие потолок не спрашивает никогда', () => {
    // Иначе упёршийся в потолок не смог бы убрать даже своё и остался бы
    // заперт: поставить нельзя, снять нельзя.
    const map = mapWithOwn('me', MAX_REACTIONS_PER_ACTOR);
    const off = applyReaction(map, 'e0', 'me', false);
    expect(off).not.toBeNull();
    expect(off?.on).toBe(false);
    expect(Object.keys(off?.map ?? {})).toHaveLength(MAX_REACTIONS_PER_ACTOR - 1);
  });

  it('добавление сверх потолка не меняет карту', () => {
    const map = mapWithOwn('me', MAX_REACTIONS_PER_ACTOR);
    expect(applyReaction(map, 'новый', 'me', true)).toBeNull();
    expect(Object.keys(map)).toHaveLength(MAX_REACTIONS_PER_ACTOR);
  });
});

describe('текст отказа', () => {
  it('называет, на чём стоит реакция', () => {
    expect(reactionLimitText('keys', 'post')).toContain('посте');
    expect(reactionLimitText('keys', 'comment')).toContain('комментарии');
    expect(reactionLimitText('keys', 'message')).toContain('сообщении');
  });

  it('свой потолок называет число и что делать', () => {
    const t = reactionLimitText('actor', 'post');
    expect(t).toContain(String(MAX_REACTIONS_PER_ACTOR));
    expect(t).toContain('снимите');
  });

  it('ошибка-носитель узнаётся без instanceof-подкласса', () => {
    // Под Hermes наследование от Error ломает instanceof — признак живёт на
    // самом объекте.
    const e = reactionLimitError('actor', 'comment');
    expect(isReactionLimitError(e)).toBe(true);
    expect(isReactionLimitError(new Error('обычная'))).toBe(false);
    expect(e.message).toBe(reactionLimitText('actor', 'comment'));
  });
});

describe('все три пути зовут общее правило', () => {
  const feedStorage = () => slice(SRC('storage', 'feedStorage.ts'), '  async addReaction(', '\n  }\n');

  it('реакция на пост проходит через свод потолков', () => {
    const body = feedStorage();
    expect(body).toContain('applyReaction(');
    expect(body).not.toMatch(/>= 64|>= 512/);
  });

  it('отказ по посту виден вызывающему', () => {
    // `Promise<void>` не умел сказать «не записал», и рассылка уходила вхолостую.
    expect(feedStorage()).toContain('): Promise<boolean> {');
  });

  it('рассылка реакции на пост не идёт впереди записи', () => {
    const body = slice(
      SRC('social', 'feedService.ts'),
      'export async function toggleAndBroadcastReaction(',
      '\n}\n'
    );
    expect(body).toContain('reactionAddRefusal(');
    expect(body).toContain('reactionLimitError(');
    expect(body.indexOf('addReaction(')).toBeLessThan(body.indexOf('signAndBroadcastFeedEnvelope('));
  });

  it('своя реакция на комментарий — то же правило', () => {
    const body = slice(SRC('social', 'feedService.ts'), 'export function toggleCommentReaction(', '\n}\n');
    expect(body).toContain('reactionAddRefusal(');
    expect(body).not.toMatch(/>= 64|>= 512/);
  });

  it('чужая реакция на комментарий — то же правило', () => {
    const body = slice(SRC('social', 'feedService.ts'), "case 'feed_comment_reaction': {", "case 'feed_comment': {");
    expect(body).toContain('reactionAddRefusal(');
    expect(body).not.toMatch(/>= 64|>= 512/);
  });
});
