/**
 * Конверт «таймер исчезающих сообщений».
 *
 * Тесты обязательны: конверт приходит от собеседника и ведёт к УДАЛЕНИЮ
 * переписки. Ошибка в разборе — это не кривой интерфейс, а потеря истории.
 */

import {
  DISAPPEAR_PREFIX,
  encodeDisappearEnvelope,
  decodeDisappearEnvelope,
  formatDisappearLabel,
} from '../disappearEnvelope';
import { MIN_AUTO_DELETE_MS, MAX_AUTO_DELETE_MS } from '../../storage/autoDeletePolicy';

describe('disappearEnvelope', () => {
  it('туда и обратно', () => {
    for (const ms of [0, 60_000, 3_600_000, 86_400_000, 7 * 86_400_000]) {
      const wire = encodeDisappearEnvelope({ ms, ts: 1_700_000_000_000 });
      expect(wire.startsWith(DISAPPEAR_PREFIX)).toBe(true);
      expect(decodeDisappearEnvelope(wire)).toEqual({ ms, ts: 1_700_000_000_000 });
    }
  });

  it('префикс не пересекается с занятыми байтами', () => {
    const taken = [
      '\x01', '\x02', '\x03', '\x04', '\x05', '\x06', '\x07', '\x08',
      '\x09', '\x0a', '\x0b', '\x0c', '\x0d', '\x0e', '\x0f', '\x10',
    ];
    expect(taken).not.toContain(DISAPPEAR_PREFIX[0]);
  });

  it('чужие префиксы и обычный текст не разбираются', () => {
    expect(decodeDisappearEnvelope('привет')).toBeNull();
    expect(decodeDisappearEnvelope('\x10dmpin:{"msgId":"a","on":true,"ts":1}')).toBeNull();
    expect(decodeDisappearEnvelope('')).toBeNull();
  });

  it('мусор вместо JSON', () => {
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + 'null')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '[]')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '"600000"')).toBeNull();
  });

  it('слишком длинный конверт отбрасывается', () => {
    const fat = DISAPPEAR_PREFIX + JSON.stringify({ ms: 60_000, ts: 1, pad: 'x'.repeat(600) });
    expect(decodeDisappearEnvelope(fat)).toBeNull();
  });

  it('ms обязателен и должен быть целым числом', () => {
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ts":1}')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":"86400000","ts":1}')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":null,"ts":1}')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":60000.5,"ts":1}')).toBeNull();
  });

  it('ts обязателен', () => {
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":60000}')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":60000,"ts":null}')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":60000,"ts":"вчера"}')).toBeNull();
  });

  it('дистанционное уничтожение истории невозможно', () => {
    // Ключевой случай: собеседник присылает «удалять через 1 мс». Приняв
    // такое, клиент стёр бы переписку целиком по чужой команде.
    for (const ms of [1, 100, 59_999, MIN_AUTO_DELETE_MS - 1]) {
      expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + `{"ms":${ms},"ts":1}`)).toBeNull();
    }
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":-60000,"ts":1}')).toBeNull();
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + `{"ms":${MAX_AUTO_DELETE_MS + 1},"ts":1}`)).toBeNull();
  });

  it('границы включительно, 0 — это «выключить»', () => {
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + `{"ms":${MIN_AUTO_DELETE_MS},"ts":1}`)?.ms).toBe(MIN_AUTO_DELETE_MS);
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + `{"ms":${MAX_AUTO_DELETE_MS},"ts":1}`)?.ms).toBe(MAX_AUTO_DELETE_MS);
    expect(decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":0,"ts":1}')?.ms).toBe(0);
  });

  it('лишние поля не протаскиваются дальше', () => {
    const d = decodeDisappearEnvelope(DISAPPEAR_PREFIX + '{"ms":60000,"ts":1,"text":"взлом","peer":"чужой"}');
    expect(d).toEqual({ ms: 60_000, ts: 1 });
  });
});

describe('formatDisappearLabel', () => {
  it('русские окончания', () => {
    expect(formatDisappearLabel(86_400_000)).toBe('1 день');
    expect(formatDisappearLabel(2 * 86_400_000)).toBe('2 дня');
    expect(formatDisappearLabel(7 * 86_400_000)).toBe('7 дней');
    expect(formatDisappearLabel(3_600_000)).toBe('1 час');
    expect(formatDisappearLabel(2 * 3_600_000)).toBe('2 часа');
    expect(formatDisappearLabel(12 * 3_600_000)).toBe('12 часов');
    expect(formatDisappearLabel(60_000)).toBe('1 минута');
    expect(formatDisappearLabel(5 * 60_000)).toBe('5 минут');
    expect(formatDisappearLabel(30 * 60_000)).toBe('30 минут');
  });

  it('выключено', () => {
    expect(formatDisappearLabel(0)).toBe('Выкл');
    expect(formatDisappearLabel(null)).toBe('Выкл');
    expect(formatDisappearLabel(undefined)).toBe('Выкл');
  });
});
