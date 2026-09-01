import {
  POLL_CLOSE_PREFIX,
  POLL_VOTE_PREFIX,
  encodePollCloseEnvelope,
  encodePollVoteEnvelope,
  decodePollCloseEnvelope,
  decodePollVoteEnvelope,
} from '../pollVoteEnvelope';

const base = { msgId: 'm1', idx: 2, on: true, multi: false, ts: 1 };

describe('pollVoteEnvelope', () => {
  it('кодирует и разбирает обратно', () => {
    const wire = encodePollVoteEnvelope(base);
    expect(wire.startsWith(POLL_VOTE_PREFIX)).toBe(true);
    expect(decodePollVoteEnvelope(wire)).toEqual(base);
  });

  it('групповой голос доносит groupId', () => {
    const wire = encodePollVoteEnvelope({ ...base, groupId: 'g1' });
    expect(decodePollVoteEnvelope(wire)?.groupId).toBe('g1');
  });

  it('не занимает чужой управляющий байт', () => {
    const taken = ['\x01', '\x02', '\x03', '\x04', '\x05', '\x06', '\x07', '\x08',
      '\x09', '\x0a', '\x0b', '\x0c', '\x0e', '\x0f', '\x10', '\x11', '\x12', '\x13', '\x14'];
    expect(taken).not.toContain(POLL_VOTE_PREFIX[0]);
  });

  it('чужой текст и мусор — не наш конверт', () => {
    expect(decodePollVoteEnvelope('привет')).toBeNull();
    expect(decodePollVoteEnvelope('\x0freact:{}')).toBeNull();
    expect(decodePollVoteEnvelope(POLL_VOTE_PREFIX + '{')).toBeNull();
    expect(decodePollVoteEnvelope(POLL_VOTE_PREFIX + 'null')).toBeNull();
    expect(decodePollVoteEnvelope(POLL_VOTE_PREFIX + '[]')).toBeNull();
    expect(decodePollVoteEnvelope(POLL_VOTE_PREFIX + '"true"')).toBeNull();
  });

  it('номер варианта: только целое в пределах опроса', () => {
    for (const idx of [-1, 1.5, 12, 999, NaN, Infinity, '2', null]) {
      expect(decodePollVoteEnvelope(
        POLL_VOTE_PREFIX + JSON.stringify({ ...base, idx })
      )).toBeNull();
    }
    expect(decodePollVoteEnvelope(POLL_VOTE_PREFIX + JSON.stringify({ ...base, idx: 0 }))?.idx).toBe(0);
    expect(decodePollVoteEnvelope(POLL_VOTE_PREFIX + JSON.stringify({ ...base, idx: 11 }))?.idx).toBe(11);
  });

  it('обязательные поля обязательны', () => {
    for (const patch of [
      { msgId: '' }, { msgId: 'x'.repeat(129) }, { msgId: 7 },
      { on: 'true' }, { on: null },
      { multi: 1 },
      { ts: 'вчера' }, { ts: NaN },
      { groupId: '' }, { groupId: 'g'.repeat(129) }, { groupId: 5 },
    ]) {
      expect(decodePollVoteEnvelope(
        POLL_VOTE_PREFIX + JSON.stringify({ ...base, ...patch })
      )).toBeNull();
    }
  });

  it('раздутый конверт отбрасывается до JSON.parse', () => {
    const fat = POLL_VOTE_PREFIX + JSON.stringify({ ...base, pad: 'x'.repeat(2100) });
    expect(decodePollVoteEnvelope(fat)).toBeNull();
  });

  it('лишние поля не мешают разбору и ни на что не влияют', () => {
    const d = decodePollVoteEnvelope(
      POLL_VOTE_PREFIX + JSON.stringify({ ...base, voter: 'чужой' })
    );
    expect(d).not.toBeNull();
    // Автор голоса берётся из подписанного отправителя DM, а не из конверта.
    expect((d as unknown as Record<string, unknown>).voter).toBe('чужой');
    expect(d?.msgId).toBe('m1');
  });
});

const close = { msgId: 'm1', ts: 1 };

describe('pollCloseEnvelope', () => {
  it('кодирует и разбирает обратно', () => {
    const wire = encodePollCloseEnvelope(close);
    expect(wire.startsWith(POLL_CLOSE_PREFIX)).toBe(true);
    expect(decodePollCloseEnvelope(wire)).toEqual(close);
  });

  it('групповое завершение доносит groupId', () => {
    const wire = encodePollCloseEnvelope({ ...close, groupId: 'g1' });
    expect(decodePollCloseEnvelope(wire)?.groupId).toBe('g1');
  });

  it('голос и завершение не разбираются друг за друга', () => {
    // Байт общий ('\x15'), различает метка — перепутанные конверты не должны
    // проходить: иначе голос закрывал бы опрос.
    expect(decodePollCloseEnvelope(encodePollVoteEnvelope(base))).toBeNull();
    expect(decodePollVoteEnvelope(encodePollCloseEnvelope(close))).toBeNull();
  });

  it('чужой текст и мусор — не наш конверт', () => {
    expect(decodePollCloseEnvelope('привет')).toBeNull();
    expect(decodePollCloseEnvelope(POLL_CLOSE_PREFIX + '{')).toBeNull();
    expect(decodePollCloseEnvelope(POLL_CLOSE_PREFIX + 'null')).toBeNull();
    expect(decodePollCloseEnvelope(POLL_CLOSE_PREFIX + '[]')).toBeNull();
    expect(decodePollCloseEnvelope(POLL_CLOSE_PREFIX + '"m1"')).toBeNull();
  });

  it('обязательные поля обязательны', () => {
    for (const patch of [
      { msgId: '' }, { msgId: 'x'.repeat(129) }, { msgId: 7 }, { msgId: null },
      { ts: 'вчера' }, { ts: NaN }, { ts: null },
      { groupId: '' }, { groupId: 'g'.repeat(129) }, { groupId: 5 },
    ]) {
      expect(decodePollCloseEnvelope(
        POLL_CLOSE_PREFIX + JSON.stringify({ ...close, ...patch })
      )).toBeNull();
    }
  });

  it('раздутый конверт отбрасывается до JSON.parse', () => {
    const fat = POLL_CLOSE_PREFIX + JSON.stringify({ ...close, pad: 'x'.repeat(2100) });
    expect(decodePollCloseEnvelope(fat)).toBeNull();
  });
});
