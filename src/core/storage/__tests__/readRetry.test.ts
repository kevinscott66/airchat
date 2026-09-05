/**
 * v4.32.601: предупреждение «Не удалось открыть ленту» сразу после Face ID.
 *
 * Первое чтение ленты на холодном старте проигрывает гонку за базу, и экран
 * немедленно объявлял это сбоем. Здесь — что пауза перед повтором осмысленная,
 * и что лента действительно повторяет чтение, а не рисует предупреждение с
 * первой неудачи.
 */
import fs from 'fs';
import path from 'path';

import { READ_RETRY_ATTEMPTS, READ_RETRY_MAX_MS, readRetryDelayMs } from '../readRetry';

const SRC = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

describe('readRetryDelayMs', () => {
  it('повторов хотя бы два — одного мало против одиночной блокировки', () => {
    expect(READ_RETRY_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });

  it('первая пауза короткая, дальше растёт', () => {
    expect(readRetryDelayMs(1)).toBe(150);
    expect(readRetryDelayMs(2)).toBe(300);
    expect(readRetryDelayMs(2)).toBeGreaterThan(readRetryDelayMs(1));
  });

  it('пауза не уходит за верхнюю границу', () => {
    for (const n of [4, 10, 1000]) expect(readRetryDelayMs(n)).toBe(READ_RETRY_MAX_MS);
    expect(READ_RETRY_MAX_MS).toBeLessThanOrEqual(1000);
  });

  it('бессмысленный номер попытки не ждёт вовсе', () => {
    for (const n of [0, -1, NaN, Infinity]) expect(readRetryDelayMs(n)).toBe(0);
  });

  it('суммарное ожидание не задерживает первый экран надолго', () => {
    let total = 0;
    for (let i = 1; i <= READ_RETRY_ATTEMPTS; i += 1) total += readRetryDelayMs(i);
    expect(total).toBeLessThanOrEqual(1000);
  });
});

describe('лента повторяет чтение, а не пугает с первой неудачи', () => {
  const feed = SRC('ui/screens/FeedScreen.tsx');

  it('первое чтение обёрнуто повтором', () => {
    expect(feed).toContain("import { READ_RETRY_ATTEMPTS, readRetryDelayMs } from '../../core/storage/readRetry';");
    expect(feed).toContain('for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS && !shouldApplyRows(read); attempt += 1) {');
    expect(feed).toContain('read = await loadFeedPosts(FEED_PAGE, 0);');
  });

  it('повтор бросают, если экран сняли или чтение устарело', () => {
    const loop = feed.slice(
      feed.indexOf('for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS'),
      feed.indexOf("log.info('ui_feed_load_posts_done'")
    );
    expect(loop).toContain('if (!isMountedRef.current) return;');
    expect(loop).toContain('if (loadVersionRef.current !== myVersion) {');
  });

  it('предупреждение остаётся честным: после повторов сбой всё ещё сбой', () => {
    expect(feed).toContain('setFeedReadFailed(true);');
    expect(feed).toContain('Не удалось открыть ленту');
  });
});
