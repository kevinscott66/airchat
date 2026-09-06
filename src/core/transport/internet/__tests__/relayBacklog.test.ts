import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BACKLOG_FALLBACK,
  BACKLOG_OVERLAP_MS,
  RELAY_RETENTION_MS,
  sinceParam,
} from '../relayBacklog';

const NOW = 1_700_000_000_000;

describe('sinceParam', () => {
  it('без отметки просит всю глубину хранения relay', () => {
    expect(sinceParam(null, NOW)).toBe(BACKLOG_FALLBACK);
    expect(sinceParam(undefined, NOW)).toBe(BACKLOG_FALLBACK);
    expect(sinceParam(0, NOW)).toBe(BACKLOG_FALLBACK);
    expect(sinceParam(Number.NaN, NOW)).toBe(BACKLOG_FALLBACK);
  });

  it('от отметки отступает назад на нахлёст', () => {
    const last = NOW - 30 * 60 * 1000;
    expect(sinceParam(last, NOW)).toBe(String(Math.floor((last - BACKLOG_OVERLAP_MS) / 1000)));
  });

  it('старую отметку обрезает по сроку хранения relay: просить глубже нечего', () => {
    const ancient = NOW - 60 * 24 * 60 * 60 * 1000;
    expect(sinceParam(ancient, NOW)).toBe(String(Math.floor((NOW - RELAY_RETENTION_MS) / 1000)));
  });

  // v4.32.611. Раньше окно было 12 часов, и отсутствие длиной в неделю
  // упиралось в этот пол: relay уже хранил сообщение месяц, а мы просили
  // последние полсуток.
  it('после недели отсутствия просит с самой отметки, а не с последних часов', () => {
    const weekAgo = NOW - 7 * 24 * 60 * 60 * 1000;
    expect(sinceParam(weekAgo, NOW)).toBe(String(Math.floor((weekAgo - BACKLOG_OVERLAP_MS) / 1000)));
  });

  // Формат проверяется здесь, а не глазами: ntfy разбирает `since` как
  // go-duration, где суток нет вовсе, и на `30d` отвечает 400 — то есть
  // подписка молча открылась бы без накопленного.
  it('запасное значение записано в понятном ntfy формате', () => {
    expect(BACKLOG_FALLBACK).toMatch(/^\d+[hms]$/);
    expect(BACKLOG_FALLBACK).toBe(`${RELAY_RETENTION_MS / 3_600_000}h`);
  });

  it('отметку из будущего (переведённые часы) обрезает по «сейчас»', () => {
    expect(sinceParam(NOW + 60 * 60 * 1000, NOW)).toBe(String(Math.floor(NOW / 1000)));
  });

  it('перерыв в ночь возвращает точку внутри окна хранения, а не десять минут', () => {
    const evening = NOW - 9 * 60 * 60 * 1000;
    const since = Number(sinceParam(evening, NOW)) * 1000;
    expect(since).toBeGreaterThan(NOW - RELAY_RETENTION_MS);
    expect(since).toBeLessThan(NOW - 8 * 60 * 60 * 1000);
  });
});

/**
 * v4.32.611. Весь механизм выше опирается на то, что relay сообщение хранит.
 * А транспорт с самого первого коммита слал `Cache: no` — заголовок, который
 * велит ntfy не сохранять его вовсе: доходило только до сокета, открытого
 * прямо сейчас. Проверено на живом ntfy.sh: публикация с этим заголовком по
 * `?since=` не возвращается, без него — возвращается.
 *
 * Проверка идёт по исходнику: транспорт помечен `@stable`, тянуть его в тест
 * значит поднимать сеть и WebSocket ради одной строки заголовков.
 */
describe('relay обязан сохранять отправленное', () => {
  const source = readFileSync(
    join(__dirname, '..', 'internetTransport.ts'),
    'utf8',
  );

  it('заголовок Cache не отправляется', () => {
    expect(source).not.toMatch(/^\s*Cache:\s*'no'/m);
  });

  it('запасное окно подписки совпадает со сроком хранения', () => {
    expect(source).toContain(`this.since?.() ?? '${BACKLOG_FALLBACK}'`);
  });
});
