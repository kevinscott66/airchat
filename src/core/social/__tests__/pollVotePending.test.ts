/**
 * Голос, обогнавший свой опрос (v4.32.573).
 *
 * Конверт голоса маленький и едет служебной дорогой, сам опрос — обычным
 * сообщением. Порядок не гарантирован; раньше опередивший голос отбрасывался
 * с кодом `unknown_message` навсегда, и счётчики опроса у разных участников
 * расходились. Здесь проверяется полка: что она хранит, что отвергает, что
 * забывает, и что оба места приёма сообщения её разгружают.
 */
import fs from 'fs';
import path from 'path';
import {
  createPendingPollVotes,
  isRetriablePollVoteCode,
  PENDING_VOTE_MAX,
  PENDING_VOTE_TTL_MS,
  type ParkedVote,
} from '../pollVotePending';

const vote = (over: Partial<ParkedVote> = {}): ParkedVote => ({
  pid: 1,
  msgId: 'm1',
  senderPubB64: 'pubAAA',
  idx: 0,
  on: true,
  ts: 1_000,
  ...over,
});

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const SYNC = () => read('pollVoteSync.ts');
const MSG = () => read('messaging.ts');
const GRP = () => read('groupMessaging.ts');
const PENDING = () => read('pollVotePending.ts');

/** Тело функции от её объявления до следующего верхнеуровневого объявления. */
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe('pollVotePending — полка', () => {
  it('кладёт и отдаёт голос по своему сообщению', () => {
    const shelf = createPendingPollVotes();
    expect(shelf.park(vote())).toBe(true);
    expect(shelf.size()).toBe(1);
    const got = shelf.take('m1', 1, 1_000);
    expect(got).toHaveLength(1);
    expect(got[0].idx).toBe(0);
    expect(shelf.size()).toBe(0);
  });

  it('не отдаёт голос чужому сообщению и чужому профилю', () => {
    const shelf = createPendingPollVotes();
    shelf.park(vote());
    expect(shelf.take('m2', 1, 1_000)).toHaveLength(0);
    expect(shelf.take('m1', 2, 1_000)).toHaveLength(0);
    // Ни то, ни другое голос не съело.
    expect(shelf.size()).toBe(1);
    expect(shelf.take('m1', 1, 1_000)).toHaveLength(1);
  });

  it('отдаёт все голоса разных людей по одному опросу разом', () => {
    const shelf = createPendingPollVotes();
    shelf.park(vote({ senderPubB64: 'a' }));
    shelf.park(vote({ senderPubB64: 'b', idx: 1 }));
    shelf.park(vote({ senderPubB64: 'c', idx: 2 }));
    expect(shelf.take('m1', 1, 1_000)).toHaveLength(3);
    expect(shelf.size()).toBe(0);
  });

  it('передумавший не применяется дважды: тот же выбор заменяет прежний', () => {
    const shelf = createPendingPollVotes();
    shelf.park(vote({ on: true, ts: 1_000 }));
    shelf.park(vote({ on: false, ts: 1_100 }));
    expect(shelf.size()).toBe(1);
    const got = shelf.take('m1', 1, 1_100);
    expect(got).toHaveLength(1);
    expect(got[0].on).toBe(false);
  });

  it('разные варианты одного человека — разные записи', () => {
    const shelf = createPendingPollVotes();
    shelf.park(vote({ idx: 0 }));
    shelf.park(vote({ idx: 1 }));
    expect(shelf.size()).toBe(2);
    expect(shelf.take('m1', 1, 1_000)).toHaveLength(2);
  });

  it('просроченный голос не отдаётся и не остаётся лежать', () => {
    const shelf = createPendingPollVotes(200, 1_000);
    shelf.park(vote({ ts: 0 }));
    expect(shelf.take('m1', 1, 1_001)).toHaveLength(0);
    expect(shelf.size()).toBe(0);
  });

  it('ровно на границе срока голос ещё жив', () => {
    const shelf = createPendingPollVotes(200, 1_000);
    shelf.park(vote({ ts: 0 }));
    expect(shelf.take('m1', 1, 1_000)).toHaveLength(1);
  });

  it('уборка по сроку задевает и чужие записи, а не только запрошенные', () => {
    const shelf = createPendingPollVotes(200, 1_000);
    shelf.park(vote({ msgId: 'old', ts: 0 }));
    shelf.park(vote({ msgId: 'new', ts: 900 }));
    shelf.take('new', 1, 1_001);
    expect(shelf.size()).toBe(0);
  });

  it('переполнение вытесняет самый старый голос, а не самый новый', () => {
    const shelf = createPendingPollVotes(2);
    shelf.park(vote({ msgId: 'a' }));
    shelf.park(vote({ msgId: 'b' }));
    shelf.park(vote({ msgId: 'c' }));
    expect(shelf.size()).toBe(2);
    expect(shelf.take('a', 1, 1_000)).toHaveLength(0);
    expect(shelf.take('c', 1, 1_000)).toHaveLength(1);
  });

  it('поток выдуманных id не выедает память сверх предела', () => {
    const shelf = createPendingPollVotes();
    for (let i = 0; i < 5_000; i++) shelf.park(vote({ msgId: 'junk' + i }));
    expect(shelf.size()).toBe(PENDING_VOTE_MAX);
  });

  it('негодный конверт полка не берёт', () => {
    const shelf = createPendingPollVotes();
    expect(shelf.park(vote({ msgId: '' }))).toBe(false);
    expect(shelf.park(vote({ senderPubB64: '' }))).toBe(false);
    expect(shelf.park(vote({ idx: -1 }))).toBe(false);
    expect(shelf.park(vote({ idx: 1.5 }))).toBe(false);
    expect(shelf.park(vote({ ts: Number.NaN }))).toBe(false);
    expect(shelf.size()).toBe(0);
  });

  it('бессмысленные границы заменяются умолчаниями', () => {
    const shelf = createPendingPollVotes(0, -1);
    for (let i = 0; i < PENDING_VOTE_MAX + 5; i++) shelf.park(vote({ msgId: 'x' + i }));
    expect(shelf.size()).toBe(PENDING_VOTE_MAX);
    expect(shelf.take('x10', 1, PENDING_VOTE_TTL_MS)).toHaveLength(1);
  });

  it('откладывается только «сообщения нет»', () => {
    expect(isRetriablePollVoteCode('unknown_message')).toBe(true);
    // unreadable_message (v4.32.574) тоже не откладывается: строка уже в базе
    // и сама собой не расшифруется.
    for (const code of [
      'unreadable_message',
      'wrong_group',
      'not_in_chat',
      'not_a_poll',
      'index_out_of_range',
      '',
    ]) {
      expect(isRetriablePollVoteCode(code)).toBe(false);
    }
  });

  it('модуль без импортов — проверяется без базы и сети', () => {
    expect(PENDING()).not.toMatch(/^import\s/m);
  });
});

describe('pollVoteSync — куда положили и когда сняли', () => {
  it('на полку кладёт только тот путь, что пришёл из сети', () => {
    const body = slice(SYNC(), 'async function applyIncomingPollVote(', '\nexport async function flushPendingPollVotes');
    expect(body).toContain('if (canPark && isRetriablePollVoteCode(target.code)) {');
    expect(body).toContain('pendingVotes.park(vote)');
  });

  it('снятый с полки голос обратно не ложится', () => {
    const flush = slice(SYNC(), 'export async function flushPendingPollVotes(', '\n}\n');
    expect(flush).toContain('pendingVotes.take(msgId, pid, now)');
    // Последний аргумент applyIncomingPollVote — canPark.
    expect(flush).toContain('false\n    );');
  });

  it('пришедший из сети голос идёт тем же телом, что и снятый с полки', () => {
    const h = slice(SYNC(), 'export async function handleIncomingPollVote(', '\n/**');
    expect(h).toContain('await applyIncomingPollVote(env, senderPubB64, ownerPid, Date.now(), true);');
  });

  it('снятый голос проходит проверки прав заново, а не пишется в базу напрямую', () => {
    const flush = slice(SYNC(), 'export async function flushPendingPollVotes(', '\n}\n');
    expect(flush).not.toContain('setPollVote');
    expect(flush).not.toContain('deletePollVote');
    expect(flush).toContain('applyIncomingPollVote');
  });

  it('multi берётся из текста опроса, а не из отложенного конверта', () => {
    const flush = slice(SYNC(), 'export async function flushPendingPollVotes(', '\n}\n');
    expect(flush).toContain('multi: false');
  });

  it('полка одна на процесс', () => {
    expect(SYNC().split('createPendingPollVotes(').length - 1).toBe(1);
    expect(SYNC()).toContain('const pendingVotes = createPendingPollVotes();');
  });
});

describe('приём сообщения разгружает полку', () => {
  it('личный приём зовёт снятие после записи строки', () => {
    const s = MSG();
    const at = s.indexOf('await saveChatMessage(row);');
    expect(at).toBeGreaterThan(0);
    const after = s.slice(at, at + 700);
    expect(after).toContain('isPollMessage(row.text)');
    expect(after).toContain('flushPendingPollVotes(row.id, ownerPid)');
    // Не для своего же отправленного и не для повторной доставки.
    expect(after).toContain('inbound && !alreadyStored');
  });

  it('групповой приём зовёт снятие после записи строки', () => {
    const s = GRP();
    const at = s.indexOf('await insertGroupMessage(row);');
    expect(at).toBeGreaterThan(0);
    const after = s.slice(at, at + 700);
    expect(after).toContain('isPollMessage(env.text)');
    expect(after).toContain('flushPendingPollVotes(env.msgId, pid)');
  });

  it('оба места грузят pollVoteSync динамически — иначе замкнётся круг импортов', () => {
    expect(MSG()).toContain("void import('./pollVoteSync')");
    expect(GRP()).toContain("void import('./pollVoteSync')");
    expect(MSG()).not.toContain("from './pollVoteSync'");
    expect(GRP()).not.toContain("from './pollVoteSync'");
  });

  it('осечка снятия не проглатывается молча', () => {
    for (const s of [MSG(), GRP()]) {
      const at = s.indexOf("void import('./pollVoteSync')");
      const after = s.slice(at, at + 400);
      expect(after).toContain("log.warn('poll_vote_flush_failed'");
      expect(after).not.toContain('.catch(() => {})');
    }
  });
});
