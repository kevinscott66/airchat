/**
 * Осечка при разборе конверта была окончательной (v4.32.614).
 *
 * Отметка «этот конверт уже видели» ставится ДО разбора — иначе один и тот же
 * конверт, приехавший двумя транспортами разом, обработался бы дважды, а
 * ретрансляция закольцевалась бы. Но из-за этого любая осечка посреди разбора
 * теряла запись насовсем: строка в базу не легла, конверт уже помечен, автор
 * шлёт повтор — повтор выбрасывается как дубль. У автора при этом всё
 * выглядит доставленным.
 *
 * Случаев ровно три, и все три обязаны снимать отметку: исключение при записи,
 * переключение профиля посреди разбора и незаданный профиль.
 */
import fs from 'fs';
import path from 'path';

const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Тело объявления: от строки-заголовка до первой закрывающей скобки в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  expect(start).toBeGreaterThanOrEqual(0);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`no terminator for ${head}`);
}

const RECEIVE = bodyOf(SERVICE, 'export async function receiveFeedEnvelope(');

describe('повтор конверта после осечки', () => {
  it('исключение при разборе снимает отметку', () => {
    const catchAt = RECEIVE.indexOf('feed_envelope_ingest_failed');
    expect(catchAt).toBeGreaterThan(0);
    expect(RECEIVE.slice(catchAt - 200, catchAt)).toContain('feedSeenForget(dedupKey)');
  });

  it('переключение профиля посреди разбора снимает отметку', () => {
    const at = RECEIVE.indexOf('feed_envelope_dropped_profile_switched');
    expect(at).toBeGreaterThan(0);
    expect(RECEIVE.slice(at - 300, at)).toContain('feedSeenForget(dedupKey)');
  });

  it('незаданный профиль снимает отметку', () => {
    const at = RECEIVE.indexOf('feed_envelope_profile_unset');
    expect(at).toBeGreaterThan(0);
    expect(RECEIVE.slice(at - 200, at)).toContain('feedSeenForget(dedupKey)');
  });

  it('на успешном пути отметка остаётся — иначе дубль обработается дважды', () => {
    const dedup = RECEIVE.indexOf('feed_envelope_dedup_drop');
    expect(dedup).toBeGreaterThan(0);
    // Единственный «забыть» до места дедупа означал бы, что отметка вообще
    // не держится: снимать её можно только на путях отказа, которые все ниже.
    expect(RECEIVE.slice(0, dedup)).not.toContain('feedSeenForget(');
  });
});
