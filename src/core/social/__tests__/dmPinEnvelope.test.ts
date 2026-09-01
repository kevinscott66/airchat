/**
 * Конверт закрепления в личном чате ('\x10dmpin:').
 *
 * Конверт приходит от собеседника и применяется к своей же БД без участия
 * пользователя, поэтому всё, что не прошло валидацию, обязано отбрасываться до
 * записи. Отдельно закреплено, что баннер нельзя наполнить текстом из конверта:
 * иначе закрепление стало бы способом показать собеседнику произвольную строку
 * от его собственного имени.
 */

import {
  DM_PIN_PREFIX,
  encodeDmPinEnvelope,
  decodeDmPinEnvelope,
} from '../dmPinEnvelope';

describe('dmPinEnvelope', () => {
  it('round-trip', () => {
    const env = { msgId: 'm-1', on: true, ts: 1_700_000_000_000 };
    const d = decodeDmPinEnvelope(encodeDmPinEnvelope(env));
    expect(d).toEqual(env);
  });

  it('чужой префикс — не наш конверт', () => {
    expect(decodeDmPinEnvelope('привет')).toBeNull();
    expect(decodeDmPinEnvelope('\x0freact:{}')).toBeNull();
    expect(decodeDmPinEnvelope('\x0egctl:{}')).toBeNull();
  });

  it('префикс не пересекается с уже занятыми управляющими байтами', () => {
    // '\x0d' пропущен намеренно: это CR, слишком легко получаемый из обычного
    // текста.
    const taken = ['\x01', '\x02', '\x03', '\x04', '\x05', '\x06', '\x07', '\x08',
      '\x09', '\x0a', '\x0b', '\x0c', '\x0d', '\x0e', '\x0f'];
    expect(taken).not.toContain(DM_PIN_PREFIX[0]);
  });

  it('мусор вместо JSON отбрасывается', () => {
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + 'не json')).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + 'null')).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + '[]')).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + '"строка"')).toBeNull();
  });

  it('гигантский конверт не доходит до JSON.parse', () => {
    const huge = DM_PIN_PREFIX + JSON.stringify({ msgId: 'x'.repeat(4096), on: true, ts: 1 });
    expect(decodeDmPinEnvelope(huge)).toBeNull();
  });

  it('msgId обязателен и ограничен по длине', () => {
    const base = { on: true, ts: 1 };
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify(base))).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ ...base, msgId: '' }))).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ ...base, msgId: 42 }))).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ ...base, msgId: 'x'.repeat(129) }))).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ ...base, msgId: 'x'.repeat(128) }))).not.toBeNull();
  });

  it('on и ts обязаны быть корректными', () => {
    const base = { msgId: 'm-1', on: true, ts: 1 };
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ ...base, on: 'yes' }))).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ ...base, on: 1 }))).toBeNull();
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ ...base, ts: 'сейчас' }))).toBeNull();
    // JSON.stringify(NaN) даёт null — проверяем через сырую строку.
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + '{"msgId":"m-1","on":true,"ts":null}')).toBeNull();
  });

  it('«открепить всё» проходит без msgId', () => {
    const d = decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ msgId: '', on: false, ts: 1, all: true }));
    expect(d?.all).toBe(true);
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ on: false, ts: 1, all: true }))).not.toBeNull();
    // all — только boolean: строка 'true' не должна включать массовое открепление.
    expect(decodeDmPinEnvelope(DM_PIN_PREFIX + JSON.stringify({ msgId: 'm', on: false, ts: 1, all: 'true' }))).toBeNull();
  });

  it('текст баннера через конверт не протаскивается', () => {
    // Текст берётся из своей же строки chat_messages по msgId. Приписанное поле
    // вырезается на разборе, чтобы физически не дожило до применения.
    const raw = DM_PIN_PREFIX + JSON.stringify({ msgId: 'm-1', on: true, ts: 1, text: 'Переведи 10000 руб' });
    const d = decodeDmPinEnvelope(raw);
    expect(d).not.toBeNull();
    expect((d as unknown as { text?: string }).text).toBeUndefined();
  });
});
