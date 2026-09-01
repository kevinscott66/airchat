import * as fs from 'fs';
import * as path from 'path';
import { mergeQueue, type QueueEntry } from '../feedQueueCommit';

/**
 * Раунд 456: пост, поставленный в очередь во время рассылки, больше не исчезает.
 *
 * Очередь публикации — одна запись в kv. Рассылка читала её целиком, ходила по
 * сети (до 20 секунд на пост, десятки на всю очередь) и записывала свой снимок
 * поверх. Всё, что попало в очередь за это время, стиралось: пользователь видел
 * «пост поставлен в очередь» и сам пост в своей ленте, а записи уже не было —
 * ретраев не будет никогда, контакты не получат пост вовсе. Ровно те же условия
 * (нет связи) и порождают запись в очередь, и запускают рассылку.
 *
 * Теперь файл очереди меняют только через `updateQueue` — чтение и запись одной
 * неделимой операцией, — а рассылка приносит решения и сливает их с очередью,
 * перечитанной в момент записи.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Тело объявления: от строки-заголовка до первой закрывающей скобки в колонке 0. */
function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  if (start < 0) return '';
  const end = src.indexOf('\n}', start);
  return end < 0 ? '' : src.slice(start, end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

type Item = QueueEntry & { postId?: string };
const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, retries: 0, ...extra });

describe('рассылка не затирает то, что добавили пока она шла', () => {
  test('пост, попавший в очередь во время рассылки, остаётся', () => {
    const snapshot = [item('a')];
    const current = [item('a'), item('new')];
    const decisions = new Map([['a', null]]);
    expect(mergeQueue(current, decisions).map((x) => x.id)).toEqual(['new']);
    expect(snapshot).toHaveLength(1);
  });

  test('доставленная запись уходит из очереди', () => {
    expect(mergeQueue([item('a'), item('b')], new Map([['a', null]])).map((x) => x.id)).toEqual(['b']);
  });

  test('решение о записи, которой уже нет, её не воскрешает', () => {
    const decided = item('gone', { retries: 3 });
    expect(mergeQueue([item('a')], new Map([['gone', decided]]))).toEqual([item('a')]);
  });

  test('порядок очереди сохраняется', () => {
    const current = [item('a'), item('b'), item('c')];
    const decisions = new Map<string, Item | null>([
      ['a', item('a', { retries: 1 })],
      ['c', item('c', { retries: 1 })],
    ]);
    expect(mergeQueue(current, decisions).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('слияние не теряет того, что узнали обе стороны', () => {
  test('deliveredTo объединяется — уже получившим не шлём повторно', () => {
    const current = [item('a', { deliveredTo: ['did:key:new'] })];
    const decided = item('a', { retries: 1, deliveredTo: ['did:key:old'] });
    const merged = mergeQueue(current, new Map([['a', decided]]));
    expect(merged[0].deliveredTo?.slice().sort()).toEqual(['did:key:new', 'did:key:old']);
  });

  test('deliveredTo без дублей', () => {
    const current = [item('a', { deliveredTo: ['did:key:x'] })];
    const decided = item('a', { deliveredTo: ['did:key:x'] });
    expect(mergeQueue(current, new Map([['a', decided]]))[0].deliveredTo).toEqual(['did:key:x']);
  });

  test('счётчик попыток не откатывается назад', () => {
    const current = [item('a', { retries: 5 })];
    const decided = item('a', { retries: 1 });
    expect(mergeQueue(current, new Map([['a', decided]]))[0].retries).toBe(5);
  });

  test('поля записи переносятся из решения', () => {
    const current = [item('a', { postId: 'p1' })];
    const decided = item('a', { postId: 'p1', retries: 2 });
    expect(mergeQueue(current, new Map([['a', decided]]))[0].postId).toBe('p1');
  });
});

describe('у файла очереди один владелец', () => {
  test('записывает только транзакция', () => {
    // Объявление + единственный вызов внутри updateQueue.
    expect(count(SRC, 'await savePublishQueue(')).toBe(1);
    expect(bodyOf(SRC, 'async function updateQueue<T>')).toContain('await savePublishQueue(next);');
  });

  test('транзакция не позволяет ждать сеть, держа очередь', () => {
    // `apply` синхронная: асинхронное «прочитал → сходил в сеть → записал»
    // внутрь неё не напишешь, оно не скомпилируется.
    expect(SRC).toContain('apply: (q: QueuedFeedItem[]) => { next: QueuedFeedItem[]; value: T }');
  });

  test('обе рассылки записывают итог слиянием, а не снимком', () => {
    for (const head of ['async function _flushFeedPublishQueueImpl', 'async function _flushFeedQueueForPeerImpl']) {
      const body = bodyOf(SRC, head);
      expect(body).toContain('await commitFlushOutcomes(list, outcomes);');
      expect(body).not.toContain('savePublishQueue');
    }
  });

  test('точечная рассылка по пиру идёт через тот же гейт', () => {
    expect(bodyOf(SRC, 'export async function flushFeedQueueForPeer(')).toContain(
      'return runFlushExclusively(() => _flushFeedQueueForPeerImpl(pair, peerDid));',
    );
    expect(bodyOf(SRC, 'export async function flushFeedPublishQueue(')).toContain(
      'runFlushExclusively(() => _flushFeedPublishQueueImpl(pair))',
    );
  });
});

describe('проверка не пустая', () => {
  /** Хвост рассылки, каким он был до 456-го: запись снимка поверх файла. */
  const BEFORE = `  const remaining = outcomes.filter((r): r is QueuedFeedItem => r !== null);
  await savePublishQueue(remaining);`;

  test('старый хвост рассылки был бы пойман', () => {
    expect(BEFORE).toContain('await savePublishQueue(remaining);');
    expect(SRC).not.toContain(BEFORE);
  });

  test('старое слияние теряло пост: снимок вместо текущей очереди', () => {
    // То, что делал прежний код: `remaining` из снимка — записи «new» в нём нет.
    const snapshot = [item('a'), item('b')];
    const remaining = snapshot.filter((x) => x.id !== 'a');
    expect(remaining.map((x) => x.id)).toEqual(['b']);
    const current = [...snapshot, item('new')];
    expect(mergeQueue(current, new Map([['a', null]])).map((x) => x.id)).toEqual(['b', 'new']);
  });
});
