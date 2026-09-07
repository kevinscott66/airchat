/**
 * v4.32.581 — рэтчет: таймаут рассылки не отменяет саму рассылку.
 *
 * `Promise.race` в `_flushFeedPublishQueueImpl` перестаёт ЖДАТЬ
 * `republishQueuedItem`, но не прекращает её: конверты продолжают уходить.
 * Отсюда две беды, каждая из которых видна пользователю как дубликат поста в
 * чужой ленте.
 *
 * Первая: `republishQueuedItem` не дополняет `item.deliveredTo` на месте, а
 * ПЕРЕПРИСВАИВАЕТ поле. Решение, снятое в момент таймаута, — это `{ ...item }`
 * со списком доставленных на тот момент; всё, что рассылка добила потом,
 * терялось при записи, и следующая попытка стреляла в уже получивших.
 *
 * Вторая: мьютекс `runFlushExclusively` держит следующий проход до ВОЗВРАТА
 * предыдущего, то есть ровно до таймаута. Следующий проход брал ту же запись и
 * начинал вторую рассылку поверх ещё не кончившейся первой.
 *
 * Тест держит обе развязки на месте. Инстанцировать `feedService` в jest
 * нечем — модуль тянет за собой сеть, ключи и хранилище целиком, — поэтому
 * проверка идёт по исходнику, как в остальных рэтчетах этого репозитория.
 *
 * v4.32.615: проходов два. Нацеленный на одного контакта
 * (`_flushFeedQueueForPeerImpl`, его зовёт обнаружение контакта в сети) жил
 * без этой развязки: он брал запись, чья рассылка ещё шла после таймаута
 * общего прохода, и начинал вторую поверх первой. Теперь дисциплина
 * проверяется в каждом из двух тел отдельно.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Тело функции: от её заголовка до строки `\n}` на нулевом отступе. */
function bodyOf(head: string): string {
  const start = src.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Оба прохода по очереди — общий и нацеленный на одного контакта. */
const PASSES: ReadonlyArray<readonly [string, string]> = [
  ['общий', 'async function _flushFeedPublishQueueImpl('],
  ['нацеленный на контакт', 'async function _flushFeedQueueForPeerImpl('],
];

describe('рассылка, пережившая свой таймаут', () => {
  it.each(PASSES)('%s проход: запись, чья рассылка ещё идёт, не берётся вторым', (_name, head) => {
    expect(src).toContain('const inFlightQueueItems = new Set<string>();');
    const body = bodyOf(head);
    const guard = body.indexOf('if (inFlightQueueItems.has(item.id)) {');
    const add = body.indexOf('inFlightQueueItems.add(item.id);');
    expect(guard).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(-1);
    // Проверка стоит ДО постановки на учёт — иначе она всегда истинна.
    expect(guard).toBeLessThan(add);
  });

  it.each(PASSES)('%s проход: пропущенная запись не тратит попытку', (_name, head) => {
    const body = bodyOf(head);
    const guard = body.indexOf('if (inFlightQueueItems.has(item.id)) {');
    const tail = body.slice(guard, guard + 240);
    // Возвращается сама запись, а не { ...item, retries: item.retries + 1 }.
    expect(tail).toContain('return item;');
    expect(tail).not.toContain('retries: item.retries + 1');
  });

  it.each(PASSES)('%s проход: учёт снимается на обоих исходах рассылки', (_name, head) => {
    const body = bodyOf(head);
    const add = body.indexOf('inFlightQueueItems.add(item.id);');
    const tail = body.slice(add, add + 900);
    // И на успехе, и на ошибке — иначе запись залипнет в наборе навсегда.
    expect(tail.split('inFlightQueueItems.delete(item.id);').length - 1).toBe(2);
  });

  it.each(PASSES)('%s проход: доставленные после таймаута дописываются в очередь', (_name, head) => {
    expect(src).toContain('async function mergeLateDelivery(item: QueuedFeedItem): Promise<void> {');
    const body = bodyOf(head);
    const add = body.indexOf('inFlightQueueItems.add(item.id);');
    const merge = body.indexOf('mergeLateDelivery(item)', add);
    const race = body.indexOf('await Promise.race([', add);
    expect(merge).toBeGreaterThan(-1);
    // Продолжение вешается на рассылку ДО гонки: после таймаута вешать уже некому.
    expect(merge).toBeLessThan(race);
    // И только если таймаут действительно случился.
    expect(body.slice(add, race)).toContain('timedOut ? mergeLateDelivery(item)');
  });

  it('слияние объединяет списки и не воскрешает выбывшую запись', () => {
    const body = src.slice(
      src.indexOf('async function mergeLateDelivery'),
      src.indexOf('export async function flushFeedPublishQueue'),
    );
    // Проход по УЖЕ лежащим в очереди записям: чего нет — то и не появится.
    expect(body).toContain('next: q.map((stored) => {');
    expect(body).toContain('if (stored.id !== item.id) return stored;');
    // Объединение, а не замена.
    expect(body).toContain('const acc = new Set(stored.deliveredTo ?? []);');
    expect(body).toContain('for (const d of delivered) acc.add(d);');
  });

  it.each(PASSES)('%s проход: будильник таймаута гасится на обоих выходах', (_name, head) => {
    // Иначе таймер держит ссылку на замыкание до конца FLUSH_ITEM_TIMEOUT_MS
    // на каждую запись очереди — а их до MAX_QUEUE_RETRIES сотен.
    expect(bodyOf(head).split('if (timer) clearTimeout(timer);').length - 1).toBe(2);
  });
});
