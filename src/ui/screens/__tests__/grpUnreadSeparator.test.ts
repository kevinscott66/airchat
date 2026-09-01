/**
 * v4.32.529: полоса «N непрочитанных» в группе — с правильного конца списка.
 *
 * Массив сообщений группы идёт «новые первыми», лента отрисована `inverted`.
 * Проверяется, что полоса стоит сразу за непрочитанными, что она не исчезает,
 * когда непрочитанных больше, чем загружено, и что расстановка дат не
 * пострадала.
 */
import fs from 'fs';
import path from 'path';

import type { GroupMessageRow } from '../../../core/storage/local';
import { injectGrpDateSeparators } from '../groups-utils/dates';
import { unreadSeparatorIndex } from '../groups-utils/unreadSeparator';

const MODULE = fs.readFileSync(
  path.join(__dirname, '..', 'groups-utils', 'unreadSeparator.ts'),
  'utf8',
);
const DATES = fs.readFileSync(path.join(__dirname, '..', 'groups-utils', 'dates.ts'), 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const BASE = 1_700_000_000_000;

/** n сообщений «новые первыми», по одному в час, все в один день. */
function msgs(n: number): GroupMessageRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    groupId: 'g1',
    senderPubB64: 'peer',
    senderName: 'Пётр',
    text: `t${i}`,
    mediaCids: [],
    replyToId: null,
    replyToPreview: null,
    reactions: {},
    createdAt: BASE - i * 60 * 60 * 1000,
    ownerProfileId: 1,
    editedAt: null,
    starred: false,
    viewCount: 0,
    seenBy: [],
  })) as unknown as GroupMessageRow[];
}

const sepPos = (items: ReturnType<typeof injectGrpDateSeparators>): number =>
  items.findIndex((it) => (it as { type?: string }).type === 'unread_sep');

describe('unreadSeparatorIndex', () => {
  it('пять непрочитанных из шестидесяти: полоса сразу за пятью самыми новыми', () => {
    expect(unreadSeparatorIndex(60, 5)).toBe(5);
  });

  it('непрочитанных ровно столько, сколько загружено: полоса в конце массива', () => {
    expect(unreadSeparatorIndex(60, 60)).toBe(60);
  });

  it('непрочитанных больше, чем загружено: полоса всё равно в конце, а не пропадает', () => {
    expect(unreadSeparatorIndex(60, 500)).toBe(60);
  });

  it('одно непрочитанное — полоса после первого элемента', () => {
    expect(unreadSeparatorIndex(60, 1)).toBe(1);
  });

  it('непрочитанных нет — полосы нет', () => {
    expect(unreadSeparatorIndex(60, 0)).toBe(-1);
    expect(unreadSeparatorIndex(60, -3)).toBe(-1);
  });

  it('пустой список — полосы нет', () => {
    expect(unreadSeparatorIndex(0, 5)).toBe(-1);
  });

  it('мусорные числа не превращаются в индекс', () => {
    expect(unreadSeparatorIndex(Number.NaN, 5)).toBe(-1);
    expect(unreadSeparatorIndex(60, Number.NaN)).toBe(-1);
    expect(unreadSeparatorIndex(60, Number.POSITIVE_INFINITY)).toBe(-1);
  });

  it('дробное число непрочитанных округляется вниз, а не даёт нецелый индекс', () => {
    expect(unreadSeparatorIndex(60, 2.7)).toBe(2);
  });
});

describe('injectGrpDateSeparators: полоса непрочитанных', () => {
  it('стоит сразу за непрочитанными, а не в середине прочитанного', () => {
    const items = injectGrpDateSeparators(msgs(20), 3);
    const at = sepPos(items);
    expect(at).toBeGreaterThan(-1);
    // до полосы — ровно три самых новых сообщения (разделители дат не в счёт)
    const before = items
      .slice(0, at)
      .filter((it) => (it as { type?: string }).type === undefined) as GroupMessageRow[];
    expect(before.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    // а прежний индекс msgs.length - unread увёл бы полосу в самый конец
    expect(at).toBeLessThan(items.length / 2);
  });

  it('не исчезает, когда всё загруженное непрочитано', () => {
    const items = injectGrpDateSeparators(msgs(10), 10);
    expect(sepPos(items)).toBe(items.length - 1);
  });

  it('не исчезает, когда непрочитанных больше, чем загружено', () => {
    const items = injectGrpDateSeparators(msgs(10), 40);
    expect(sepPos(items)).toBeGreaterThan(-1);
  });

  it('одно непрочитанное — полоса есть (прежде её съедала проверка i > 0 только на нуле)', () => {
    const items = injectGrpDateSeparators(msgs(10), 1);
    expect(sepPos(items)).toBe(1);
  });

  it('без непрочитанных полосы нет', () => {
    const items = injectGrpDateSeparators(msgs(10), 0);
    expect(sepPos(items)).toBe(-1);
  });

  it('полоса ровно одна', () => {
    const items = injectGrpDateSeparators(msgs(30), 7);
    expect(items.filter((it) => (it as { type?: string }).type === 'unread_sep')).toHaveLength(1);
  });

  it('пустой список остаётся пустым', () => {
    expect(injectGrpDateSeparators([], 5)).toEqual([]);
  });

  it('разделители дат по-прежнему расставляются', () => {
    const two = msgs(2);
    two[1].createdAt = BASE - DAY;
    const items = injectGrpDateSeparators(two, 0);
    expect(items.filter((it) => (it as { type?: string }).type === 'date_sep').length).toBeGreaterThan(0);
  });
});

describe('исходники', () => {
  it('модуль без зависимостей', () => {
    expect(MODULE).not.toMatch(/^import /m);
  });

  it('расстановка больше не считает список от старых к новым', () => {
    expect(DATES).toContain('unreadSeparatorIndex(msgs.length, initialUnreadCount)');
    expect(DATES).not.toContain('msgs.length - initialUnreadCount');
    expect(DATES).not.toContain('i === unreadStartIdx && i > 0');
  });
});
