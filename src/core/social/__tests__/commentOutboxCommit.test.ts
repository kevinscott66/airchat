/**
 * v4.32.471 — рэтчет: комментарий, написанный во время рассылки, не пропадает.
 *
 * Дефект тот же, что у очереди публикации (v4.32.456), и остался он ровно в
 * соседней очереди. `_flushCommentOutboxImpl` читал очередь целиком, потом
 * ходил в сеть по каждой записи — это секунды на запись, — и в конце записывал
 * свой снимок поверх файла. Всё, что попало в очередь за это время, стиралось:
 * человек видел свой комментарий в ленте, но повторных попыток по нему не
 * случалось никогда, и до собеседника он не доходил вовсе.
 *
 * Тест держит обе половины починки: чистое слияние (mergeOutbox) и форму
 * самой рассылки — снимок не записывается, запись идёт одной транзакцией.
 */
import * as fs from 'fs';
import * as path from 'path';

import { mergeOutbox, type OutboxEntry } from '../feedQueueCommit';

const FEED = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

type Item = OutboxEntry & { text?: string };
const item = (key: string, retries = 0, text = ''): Item => ({ key, retries, text });

describe('проверка не пустая', () => {
  it('исходник прочитан, счётчик считает', () => {
    expect(FEED.length).toBeGreaterThan(10_000);
    expect(count('a-b-a', 'a')).toBe(2);
  });
});

describe('слияние итогов рассылки', () => {
  it('запись, добавленная во время рассылки, остаётся', () => {
    const current = [item('c1'), item('c2-новый')];
    const decisions = new Map<string, Item | null>([['c1', null]]);
    expect(mergeOutbox(current, decisions).map((x) => x.key)).toEqual(['c2-новый']);
  });

  it('доставленная запись уходит из очереди', () => {
    const decisions = new Map<string, Item | null>([['c1', null]]);
    expect(mergeOutbox([item('c1')], decisions)).toEqual([]);
  });

  it('недоставленная остаётся с решением рассылки', () => {
    const decisions = new Map<string, Item | null>([['c1', item('c1', 3)]]);
    expect(mergeOutbox([item('c1', 0)], decisions)).toEqual([{ key: 'c1', retries: 3, text: '' }]);
  });

  it('счётчик попыток только растёт', () => {
    // Пока шла рассылка, запись переписали заново — счётчик в очереди больше.
    const decisions = new Map<string, Item | null>([['c1', item('c1', 1)]]);
    expect(mergeOutbox([item('c1', 5)], decisions)[0].retries).toBe(5);
  });

  it('порядок очереди сохраняется', () => {
    const current = [item('a'), item('b'), item('c')];
    const decisions = new Map<string, Item | null>([['b', null]]);
    expect(mergeOutbox(current, decisions).map((x) => x.key)).toEqual(['a', 'c']);
  });

  it('решение по записи, которой в очереди уже нет, ничего не воскрешает', () => {
    const decisions = new Map<string, Item | null>([['ушла', item('ушла', 2)]]);
    expect(mergeOutbox([item('a')], decisions).map((x) => x.key)).toEqual(['a']);
  });

  it('пустая очередь остаётся пустой', () => {
    expect(mergeOutbox([], new Map<string, Item | null>([['a', item('a')]]))).toEqual([]);
  });

  it('исходный массив не меняется', () => {
    const current = [item('a', 1)];
    mergeOutbox(current, new Map<string, Item | null>([['a', item('a', 9)]]));
    expect(current).toEqual([{ key: 'a', retries: 1, text: '' }]);
  });
});

describe('рассылка комментариев не записывает свой снимок', () => {
  const FLUSH = FEED.slice(
    FEED.indexOf('async function _flushCommentOutboxImpl('),
    FEED.indexOf('/** Ключ, которым будет отправлять таймер отложенных комментариев')
  );

  it('кусок рассылки найден', () => {
    expect(FLUSH.length).toBeGreaterThan(500);
    expect(FLUSH).toContain('signAndBroadcastFeedEnvelope');
  });

  it('массива kept больше нет — есть решения', () => {
    expect(FLUSH).not.toContain('kept');
    expect(FLUSH).toContain('const decisions = new Map<string, CommentOutboxItem | null>();');
  });

  it('итог записывается слиянием, одной транзакцией', () => {
    expect(FLUSH).toContain(
      'await updateCommentOutbox((cur) => ({ next: mergeOutbox(cur, decisions), value: undefined }));'
    );
    expect(FLUSH).not.toContain('saveCommentOutbox(');
  });

  it('каждый исход помечен: доставлено, протухло, исчерпано, ждём', () => {
    expect(count(FLUSH, 'drop(item);')).toBe(3);
    expect(count(FLUSH, 'keep(')).toBeGreaterThanOrEqual(4);
  });
});

describe('очередь комментариев — одна транзакция на всех', () => {
  it('транзакция заведена и синхронна внутри', () => {
    expect(FEED).toContain('async function updateCommentOutbox<T>(');
    expect(FEED).toContain('apply: (q: CommentOutboxItem[]) => { next: CommentOutboxItem[]; value: T }');
  });

  it('файл очереди пишут только из транзакции', () => {
    expect(count(FEED, 'await saveCommentOutbox(')).toBe(1);
    const tx = FEED.slice(FEED.indexOf('async function updateCommentOutbox<T>('));
    expect(tx.slice(0, tx.indexOf('\n}')).trim()).toContain('await saveCommentOutbox(next);');
  });

  it('постановка в очередь тоже идёт через транзакцию', () => {
    const enqueue = FEED.slice(
      FEED.indexOf('async function enqueueCommentOutboxItem('),
      FEED.indexOf('let _commentFlushInFlight')
    );
    expect(enqueue).toContain('await updateCommentOutbox((q) => {');
    expect(enqueue).not.toContain('await loadCommentOutbox()');
    // Отсечка по размеру осталась внутри той же неделимой операции.
    expect(enqueue).toContain('filtered.slice(-COMMENT_OUTBOX_MAX_ITEMS)');
  });

  it('транзакции выстраиваются в цепочку и не рвутся об одну неудачу', () => {
    expect(FEED).toContain('let commentQueueTx: Promise<unknown> = Promise.resolve();');
    expect(FEED).toContain('const started = commentQueueTx.then(run, run);');
  });
});
