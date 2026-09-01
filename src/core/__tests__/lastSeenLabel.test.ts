/**
 * «Был(а) в сети…» — подпись, которую собеседник читает как факт.
 *
 * v4.32.421. Раньше она считалась внутри getPresenceState, поверх модульных
 * кэшей и Date.now(), и проверить её было нечем. Здесь она чистая функция:
 * «сейчас» приходит аргументом.
 */
import { lastSeenLabel } from '../time/lastSeenLabel';

const at = (y: number, m: number, d: number, hh = 12, mm = 0): number =>
  new Date(y, m, d, hh, mm, 0, 0).getTime();

const now = at(2026, 7, 17, 23, 0); // понедельник

describe('lastSeenLabel', () => {
  it('минута — «в сети», пять минут — «недавно»', () => {
    expect(lastSeenLabel(now - 30_000, now)).toEqual({ bucket: 'online', label: 'в сети' });
    expect(lastSeenLabel(now - 3 * 60_000, now)).toEqual({ bucket: 'recently', label: 'недавно' });
  });

  it('минуты и часы склоняются', () => {
    expect(lastSeenLabel(now - 20 * 60_000, now).label).toBe('был(а) 20 мин назад');
    expect(lastSeenLabel(now - 1 * 3_600_000, now).label).toBe('был(а) 1 час назад');
    expect(lastSeenLabel(now - 3 * 3_600_000, now).label).toBe('был(а) 3 часа назад');
    expect(lastSeenLabel(now - 9 * 3_600_000, now).label).toBe('был(а) 9 часов назад');
  });

  it('в пределах суток — часы, а не название дня', () => {
    // Ветка `today` остаётся ниже часов намеренно: «был(а) 22 часа назад»
    // полезнее, чем «сегодня в 01:00». Сработать она может только в сутки
    // перехода на зимнее время, когда местный день длится 25 часов, — там
    // она и не даёт подписи выродиться в «был(а) 17 августа».
    const state = lastSeenLabel(at(2026, 7, 17, 1, 0), now);
    expect(state.bucket).toBe('hours');
    expect(state.label).toBe('был(а) 22 часа назад');
  });

  it('вчера и на этой неделе — день недели со временем', () => {
    expect(lastSeenLabel(at(2026, 7, 16, 22, 0), now).bucket).toBe('days');
    expect(lastSeenLabel(at(2026, 7, 16, 22, 0), now).label).toMatch(/^вс в /);
    expect(lastSeenLabel(at(2026, 7, 12, 10, 0), now).label).toMatch(/^ср в /);
  });

  it('неделю назад — дата, а не сегодняшний день недели', () => {
    // Именно эта подпись и врала: разность 6 суток 23.5 часа проходила порог
    // `< 7 суток`, и «пн в 23:30» читалось как «полчаса назад».
    const weekAgo = at(2026, 7, 10, 23, 30);
    expect(now - weekAgo).toBeLessThan(7 * 24 * 3_600_000);
    expect(new Date(weekAgo).getDay()).toBe(new Date(now).getDay());
    const state = lastSeenLabel(weekAgo, now);
    expect(state.bucket).toBe('long_ago');
    expect(state.label).not.toMatch(/^пн в /);
    expect(state.label).toMatch(/^был\(а\) /);
  });

  it('давнее — дата с месяцем словом', () => {
    expect(lastSeenLabel(at(2026, 2, 3, 10), now).bucket).toBe('long_ago');
  });
});
