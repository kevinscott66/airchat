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
    const ancient = NOW - 5 * 24 * 60 * 60 * 1000;
    expect(sinceParam(ancient, NOW)).toBe(String(Math.floor((NOW - RELAY_RETENTION_MS) / 1000)));
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
