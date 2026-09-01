/**
 * v4.32.554 — пост и репост, набранные без сети, терялись целиком.
 *
 * Публикация начиналась с проверки сети и обрывалась до записи в базу, хотя
 * ниже по коду уже стояла очередь повторов, заведённая ровно на этот случай.
 * Репост вдобавок не умел уехать из очереди репостом: `republishQueuedItem`
 * собирал обычный пост, и у получателя пропадали ссылка на оригинал и имя
 * его автора.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  classifyBroadcast,
  dispositionOf,
  isDelivered,
  needsRetryQueue,
  type BroadcastAttempt,
} from '../publishOutcome';

const ATTEMPTS: BroadcastAttempt[] = [
  'skipped-offline',
  'no-recipients',
  'failed',
  'partial',
  'complete',
];

const MODULE = readFileSync(join(__dirname, '..', 'publishOutcome.ts'), 'utf8');
const FEED = readFileSync(join(__dirname, '..', '..', 'social', 'feedService.ts'), 'utf8');

describe('исход попытки рассылки', () => {
  it('без сети попытки не было — что бы ни лежало в счётчиках', () => {
    expect(classifyBroadcast(false, 0, 0)).toBe('skipped-offline');
    expect(classifyBroadcast(false, 5, 5)).toBe('skipped-offline');
  });

  it('нет адресатов — это не провал доставки', () => {
    expect(classifyBroadcast(true, 0, 0)).toBe('no-recipients');
    expect(needsRetryQueue('no-recipients')).toBe(false);
    expect(isDelivered('no-recipients')).toBe(false);
  });

  it('ни одного успеха — провал, часть — частичная доставка', () => {
    expect(classifyBroadcast(true, 3, 0)).toBe('failed');
    expect(classifyBroadcast(true, 3, 1)).toBe('partial');
    expect(classifyBroadcast(true, 3, 3)).toBe('complete');
  });

  it('доставленным считается ровно один исход', () => {
    expect(ATTEMPTS.filter(isDelivered)).toEqual(['complete']);
  });

  it('очередь нужна ровно там, где остались неполучившие', () => {
    expect(ATTEMPTS.filter(needsRetryQueue)).toEqual(['skipped-offline', 'failed', 'partial']);
  });

  it('очередь и доставка никогда не совпадают', () => {
    for (const a of ATTEMPTS) {
      expect(needsRetryQueue(a) && isDelivered(a)).toBe(false);
      expect(dispositionOf(a)).toBe(
        needsRetryQueue(a) ? 'queue-retry' : isDelivered(a) ? 'done' : 'local-only'
      );
    }
  });

  it('успехов больше, чем адресатов, всё равно полная доставка', () => {
    expect(classifyBroadcast(true, 2, 7)).toBe('complete');
  });

  it('отрицательные счётчики не притворяются доставкой', () => {
    expect(classifyBroadcast(true, -1, -1)).toBe('no-recipients');
    expect(classifyBroadcast(true, 2, -1)).toBe('failed');
  });
});

describe('форма исходников', () => {
  it('модуль решения без импортов', () => {
    expect(MODULE).not.toMatch(/^import\s/m);
    expect(MODULE).not.toMatch(/\brequire\(/);
  });

  it('публикация и репост не отказывают из-за сети на входе', () => {
    expect(FEED).not.toContain("if (!online.ok) return { ok: false, reason: 'offline' };");
  });

  it('пост без сети уходит в очередь, а не в никуда', () => {
    expect(FEED).toContain("log.info('feed_publish_queued_offline'");
    expect(FEED).toContain("log.info('feed_repost_queued'");
  });

  it('исход рассылки называется через общий модуль', () => {
    expect(FEED.match(/classifyBroadcast\(/g)).toHaveLength(3);
    expect(FEED).toContain("if (needsRetryQueue(attempt)) {");
  });

  it('очередь пересобирает именно репост', () => {
    expect(FEED).toContain("const repostData: FeedRepostData = {");
    expect(FEED).toContain("type: 'feed_repost',");
    expect(FEED).toContain('existing.repostAuthorDid');
  });

  it('репост в очереди не называют опубликованным', () => {
    const screen = readFileSync(
      join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'),
      'utf8'
    );
    expect(screen).toContain("'feed.repostQueued' : 'feed.repostPublished'");
    const ru = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'i18n', 'ru.json'), 'utf8')
    ) as { feed: Record<string, string> };
    expect(typeof ru.feed.repostQueued).toBe('string');
  });
});
