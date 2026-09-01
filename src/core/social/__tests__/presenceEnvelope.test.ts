/**
 * Конверт «показывай / не показывай моё время входа».
 */

import {
  PRESENCE_PREF_PREFIX,
  encodePresencePrefEnvelope,
  decodePresencePrefEnvelope,
} from '../presenceEnvelope';

describe('presenceEnvelope', () => {
  it('туда и обратно', () => {
    for (const show of [true, false]) {
      const wire = encodePresencePrefEnvelope({ show, ts: 1_700_000_000_000 });
      expect(wire.startsWith(PRESENCE_PREF_PREFIX)).toBe(true);
      expect(decodePresencePrefEnvelope(wire)).toEqual({ show, ts: 1_700_000_000_000 });
    }
  });

  it('префикс не пересекается с занятыми байтами', () => {
    const taken = [
      '\x01', '\x02', '\x03', '\x04', '\x05', '\x06', '\x07', '\x08',
      '\x09', '\x0a', '\x0b', '\x0c', '\x0d', '\x0e', '\x0f', '\x10', '\x11',
    ];
    expect(taken).not.toContain(PRESENCE_PREF_PREFIX[0]);
  });

  it('чужие префиксы и обычный текст не разбираются', () => {
    expect(decodePresencePrefEnvelope('привет')).toBeNull();
    expect(decodePresencePrefEnvelope('\x11dis:{"ms":0,"ts":1}')).toBeNull();
    expect(decodePresencePrefEnvelope('')).toBeNull();
  });

  it('мусор вместо JSON', () => {
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '{')).toBeNull();
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + 'null')).toBeNull();
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '[]')).toBeNull();
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '"true"')).toBeNull();
  });

  it('show обязателен и строго логический', () => {
    // «"show":"false"» — строка, а она истинна: приняв её как есть, клиент
    // показывал бы того, кто просил себя спрятать.
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '{"ts":1}')).toBeNull();
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '{"show":"false","ts":1}')).toBeNull();
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '{"show":0,"ts":1}')).toBeNull();
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '{"show":null,"ts":1}')).toBeNull();
  });

  it('ts обязателен', () => {
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '{"show":false}')).toBeNull();
    expect(decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '{"show":false,"ts":"вчера"}')).toBeNull();
  });

  it('слишком длинный конверт отбрасывается', () => {
    const fat = PRESENCE_PREF_PREFIX + JSON.stringify({ show: false, ts: 1, pad: 'x'.repeat(600) });
    expect(decodePresencePrefEnvelope(fat)).toBeNull();
  });

  it('чужие поля не протаскиваются — спрятать можно только себя', () => {
    // Поля «за кого» в конверте нет намеренно: решение относится к
    // подписанному отправителю, иначе один контакт прятал бы другого.
    const d = decodePresencePrefEnvelope(PRESENCE_PREF_PREFIX + '{"show":false,"ts":1,"peer":"чужой"}');
    expect(d).toEqual({ show: false, ts: 1 });
  });
});
