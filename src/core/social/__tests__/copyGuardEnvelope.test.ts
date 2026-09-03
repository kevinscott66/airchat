/**
 * Конверт двухстороннего запрета копирования и пересылки ('\x16cg:',
 * v4.32.571).
 *
 * Конверт приходит от собеседника и меняет состояние переписки без участия
 * человека: у него молча пропадают «Копировать» и «Переслать». Всё, что не
 * прошло проверку, обязано отбрасываться до записи — иначе чужой клиент
 * запирает переписку мусором, а разобраться в этом изнутри приложения нечем.
 */

import {
  COPY_GUARD_PREFIX,
  encodeCopyGuardEnvelope,
  decodeCopyGuardEnvelope,
} from '../copyGuardEnvelope';

describe('copyGuardEnvelope', () => {
  it('round-trip в обе стороны', () => {
    for (const on of [true, false]) {
      const env = { on, ts: 1_700_000_000_000 };
      expect(decodeCopyGuardEnvelope(encodeCopyGuardEnvelope(env))).toEqual(env);
    }
  });

  it('чужой префикс — не наш конверт', () => {
    expect(decodeCopyGuardEnvelope('привет')).toBeNull();
    expect(decodeCopyGuardEnvelope('\x11dis:{}')).toBeNull();
    expect(decodeCopyGuardEnvelope('\x10dmpin:{}')).toBeNull();
    expect(decodeCopyGuardEnvelope('\x15pv:{}')).toBeNull();
  });

  it('байт префикса не занят другими конвертами', () => {
    // '\x0d' пропущен намеренно: это CR, слишком легко получаемый из обычного
    // текста. Остальные заняты — от голоса до голосов в опросе.
    const taken = ['\x01', '\x02', '\x03', '\x04', '\x05', '\x06', '\x07', '\x08',
      '\x09', '\x0a', '\x0b', '\x0c', '\x0d', '\x0e', '\x0f',
      '\x10', '\x11', '\x12', '\x13', '\x14', '\x15'];
    expect(taken).not.toContain(COPY_GUARD_PREFIX[0]);
    expect(COPY_GUARD_PREFIX).toBe('\x16cg:');
  });

  it('мусор вместо JSON отбрасывается', () => {
    expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + 'не json')).toBeNull();
    expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + 'null')).toBeNull();
    expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + '[]')).toBeNull();
    expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + '"строка"')).toBeNull();
    expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + '')).toBeNull();
  });

  it('«включено» — только настоящий boolean', () => {
    // Иначе '1', 'true' и {} запирали бы переписку по правилам JS.
    for (const on of ['1', 'true', 1, 0, null, {}, []]) {
      expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + JSON.stringify({ on, ts: 1 }))).toBeNull();
    }
    expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + JSON.stringify({ ts: 1 }))).toBeNull();
  });

  it('время обязано быть конечным числом', () => {
    for (const ts of ['1', null, {}, undefined]) {
      expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + JSON.stringify({ on: true, ts }))).toBeNull();
    }
    // NaN и Infinity в JSON превращаются в null — проверяем и это.
    expect(decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + '{"on":true,"ts":null}')).toBeNull();
  });

  it('гигантский конверт не доходит до JSON.parse', () => {
    const huge = COPY_GUARD_PREFIX + JSON.stringify({ on: true, ts: 1, pad: 'x'.repeat(4096) });
    expect(decodeCopyGuardEnvelope(huge)).toBeNull();
  });

  it('лишние поля не переносятся в результат', () => {
    const d = decodeCopyGuardEnvelope(COPY_GUARD_PREFIX + '{"on":true,"ts":5,"text":"тык"}');
    expect(d).toEqual({ on: true, ts: 5 });
  });
});
