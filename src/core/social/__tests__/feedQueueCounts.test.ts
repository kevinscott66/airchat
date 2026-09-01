import * as fs from 'fs';
import * as path from 'path';
import {
  ownedByKey,
  countByAuthor,
  sendableCount,
  parseQueueCounts,
  UNKNOWN_AUTHOR,
} from '../feedQueueCommit';

/**
 * Раунд 459: счётчик очереди показывает свои посты, а не все подряд.
 *
 * Очередь публикации — одна запись kv на всё приложение, а профилей несколько.
 * Счётчик считал её длину целиком: человек переключался на второй профиль и
 * видел «в очереди 2», хотя оба поста подписаны ключом первого. «Отправить
 * сейчас» для них ничего не делал, а число висело до TTL в 14 дней. Тем же
 * числом будился таймер повтора — он крутился по чужим записям вхолостую.
 */

const MINE = 'did:key:zMine';
const THEIRS = 'did:key:zTheirs';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  if (start < 0) return '';
  const end = src.indexOf('\n}', start);
  return end < 0 ? '' : src.slice(start, end);
}

const QUEUE = [
  { id: 'a', authorDid: MINE },
  { id: 'b', authorDid: THEIRS },
  { id: 'c', authorDid: THEIRS },
  { id: 'd' }, // до v4.32.439 отметки автора не было
];

describe('чьи записи в очереди', () => {
  test('чужие записи не наши', () => {
    expect(ownedByKey(QUEUE, MINE).map((i) => i.id)).toEqual(['a', 'd']);
  });

  test('запись без отметки автора достаётся любому ключу', () => {
    // Её владельца выясняет сама рассылка, заглянув в ленту; отдать её больше некому.
    expect(ownedByKey(QUEUE, THEIRS).map((i) => i.id)).toEqual(['b', 'c', 'd']);
  });

  test('пустая очередь — пустой ответ', () => {
    expect(ownedByKey([], MINE)).toEqual([]);
  });
});

describe('счётчик по авторам', () => {
  test('раскладывает очередь по ключам', () => {
    expect(countByAuthor(QUEUE)).toEqual({ [MINE]: 1, [THEIRS]: 2, [UNKNOWN_AUTHOR]: 1 });
  });

  test('счёт совпадает с полным перебором — иначе баннер и кнопка разойдутся', () => {
    for (const did of [MINE, THEIRS, 'did:key:zStranger']) {
      expect(sendableCount(countByAuthor(QUEUE), did)).toBe(ownedByKey(QUEUE, did).length);
    }
  });

  test('ключа нет в очереди — ноль, а не общая длина', () => {
    const onlyTheirs = [{ id: 'b', authorDid: THEIRS }];
    expect(sendableCount(countByAuthor(onlyTheirs), MINE)).toBe(0);
  });

  test('старый формат счётчика (голое число) не читается как счёт', () => {
    // Ключ переименован в _v2, но и наткнувшись на старое значение считаем заново.
    expect(parseQueueCounts('7')).toBeNull();
    expect(parseQueueCounts(null)).toBeNull();
    expect(parseQueueCounts('')).toBeNull();
    expect(parseQueueCounts('[1,2]')).toBeNull();
    expect(parseQueueCounts('не json')).toBeNull();
  });

  test('мусор в значениях отбрасывается, числа остаются', () => {
    expect(parseQueueCounts(JSON.stringify({ [MINE]: 2, [THEIRS]: 'три', x: -1 }))).toEqual({ [MINE]: 2 });
  });
});

describe('в ленте счётчик спрашивают за конкретный ключ', () => {
  test('длина очереди считается по ключу', () => {
    expect(SRC).toContain('export async function getFeedPublishQueueLength(pair: KeyPairBytes): Promise<number> {');
    const body = bodyOf(SRC, 'export async function getFeedPublishQueueLength(');
    expect(body).toContain('sendableCount(cached, myDid)');
    expect(body).not.toContain('.length;');
  });

  test('таймер повтора будят только свои записи', () => {
    expect(SRC).toContain('async function myQueueItems(pair: KeyPairBytes)');
    expect(bodyOf(SRC, 'function scheduleFeedPublishRetry(')).toContain('await myQueueItems(p)');
    expect(bodyOf(SRC, 'export function flushFeedQueueNow(')).toContain('(await myQueueItems(pair)).length > 0');
  });

  test('счётчик сохраняется по авторам', () => {
    expect(bodyOf(SRC, 'async function savePublishQueue(')).toContain(
      "kvSet(FEED_QUEUE_LEN_KEY, JSON.stringify(countByAuthor(q)))",
    );
    expect(SRC).toContain("const FEED_QUEUE_LEN_KEY = 'feed_publish_queue_len_v2';");
  });

  test('экран не спрашивает длину «вообще»', () => {
    const screen = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'), 'utf8',
    );
    expect(screen).not.toContain('getFeedPublishQueueLength()');
    expect(screen.split('getFeedPublishQueueLength(pair)').length - 1).toBe(6);
  });
});

describe('проверка не пустая', () => {
  /** Как считали до 459-го. */
  const beforeCount = (items: readonly unknown[]): number => items.length;

  test('старое правило показало бы чужие посты', () => {
    expect(beforeCount(QUEUE)).toBe(4);
    expect(sendableCount(countByAuthor(QUEUE), MINE)).toBe(2);
  });

  test('старая строка счётчика ушла из исходника', () => {
    expect(SRC).not.toContain("kvSet(FEED_QUEUE_LEN_KEY, String(");
  });
});
