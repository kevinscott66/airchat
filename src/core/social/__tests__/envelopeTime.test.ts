/**
 * Время из чужого конверта.
 *
 * Метку ставит отправитель, поэтому 1970-й и 2140-й — такие же законные
 * числа, как настоящее время. Проверяются обе величины: «когда произошло»
 * (узкое окно вокруг «сейчас») и «когда вступил в группу» (может быть и два
 * года назад, но не раньше приложения и не в будущем).
 */

import {
  APP_EPOCH_MS,
  ENVELOPE_MAX_AGE_MS,
  ENVELOPE_MAX_SKEW_MS,
  clampEnvelopeTs,
  clampJoinedAt,
} from '../envelopeTime';

const NOW = Date.UTC(2026, 5, 1);

describe('clampEnvelopeTs', () => {
  it('нормальное время проходит нетронутым', () => {
    expect(clampEnvelopeTs(NOW - 60_000, NOW)).toBe(NOW - 60_000);
    expect(clampEnvelopeTs(NOW, NOW)).toBe(NOW);
  });

  it('далёкое будущее прижимается к запасу на расхождение часов', () => {
    // 2140 год навсегда прибивал системную строку к низу переписки, а удалять
    // системные строки интерфейс не даёт.
    expect(clampEnvelopeTs(Date.UTC(2140, 0, 1), NOW)).toBe(NOW + ENVELOPE_MAX_SKEW_MS);
    expect(clampEnvelopeTs(NOW + ENVELOPE_MAX_SKEW_MS - 1, NOW)).toBe(NOW + ENVELOPE_MAX_SKEW_MS - 1);
  });

  it('далёкое прошлое прижимается к неделе назад', () => {
    expect(clampEnvelopeTs(0, NOW)).toBe(NOW - ENVELOPE_MAX_AGE_MS);
    expect(clampEnvelopeTs(-1e15, NOW)).toBe(NOW - ENVELOPE_MAX_AGE_MS);
  });

  it('не число — текущее время: событие от этого не перестаёт быть настоящим', () => {
    for (const v of [undefined, null, 'вчера', {}, [], NaN, Infinity, -Infinity]) {
      expect([String(v), clampEnvelopeTs(v, NOW)]).toEqual([String(v), NOW]);
    }
  });

  it('повторное применение ничего не меняет', () => {
    for (const v of [NOW - 60_000, Date.UTC(2140, 0, 1), 0, NaN]) {
      const once = clampEnvelopeTs(v, NOW);
      expect([String(v), clampEnvelopeTs(once, NOW)]).toEqual([String(v), once]);
    }
  });
});

describe('clampJoinedAt', () => {
  it('давняя, но настоящая дата вступления сохраняется', () => {
    // Здесь окно не «неделя»: человек мог вступить два года назад, и это
    // законно — в отличие от времени самого события.
    const twoYears = NOW - 2 * 365 * 86_400_000;
    expect(clampJoinedAt(twoYears, NOW)).toBe(twoYears);
  });

  it('дата раньше приложения прижимается к его началу', () => {
    // По joined_at сортируется состав группы; 1970-й навсегда поднимал
    // участника в начало списка, а править даты интерфейс не даёт.
    expect(clampJoinedAt(1, NOW)).toBe(APP_EPOCH_MS);
    expect(clampJoinedAt(Date.UTC(1999, 0, 1), NOW)).toBe(APP_EPOCH_MS);
  });

  it('будущее прижимается к «сейчас» с запасом на часы', () => {
    expect(clampJoinedAt(Date.UTC(2140, 0, 1), NOW)).toBe(NOW + ENVELOPE_MAX_SKEW_MS);
  });

  it('ноль и отрицательное — это «не задано», а не 1970 год', () => {
    // У колонки joined_at DEFAULT 0, и прежний код читал это как
    // `member.joinedAt || Date.now()`. Поведение сохранено.
    expect(clampJoinedAt(0, NOW)).toBe(NOW);
    expect(clampJoinedAt(-5, NOW)).toBe(NOW);
  });

  it('не число — текущее время', () => {
    for (const v of [undefined, null, '2020', {}, NaN, Infinity]) {
      expect([String(v), clampJoinedAt(v, NOW)]).toEqual([String(v), NOW]);
    }
  });

  it('часы устройства в прошлом не выворачивают окно наизнанку', () => {
    // now < APP_EPOCH: верхняя граница не должна оказаться ниже нижней.
    const past = Date.UTC(2015, 0, 1);
    expect(clampJoinedAt(Date.UTC(2026, 0, 1), past)).toBe(APP_EPOCH_MS);
    expect(clampJoinedAt(1, past)).toBe(APP_EPOCH_MS);
  });

  it('повторное применение ничего не меняет', () => {
    for (const v of [NOW - 86_400_000, 1, Date.UTC(2140, 0, 1), 0]) {
      const once = clampJoinedAt(v, NOW);
      expect([String(v), clampJoinedAt(once, NOW)]).toEqual([String(v), once]);
    }
  });
});
