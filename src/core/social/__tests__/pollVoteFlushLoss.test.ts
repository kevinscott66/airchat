/**
 * Отказ на одном голосе не уносит остальные (v4.32.623).
 *
 * `pendingVotes.take()` снимает голоса с полки безвозвратно: обратно они не
 * ложатся. Пока цикл разбора шёл без `try`, исключение на середине списка
 * теряло весь его хвост — и теряло молча, потому что оба вызывающих места
 * пишут в журнал один общий `poll_vote_flush_failed`.
 */
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../../storage/local', () => ({
  deletePollVote: jest.fn(),
  getChatMessageAuthor: jest.fn(),
  getChatMessageTarget: jest.fn(),
  getGroupMessageTarget: jest.fn(),
  listGroupMembers: jest.fn(async () => []),
  notifyChatStorageChanged: jest.fn(),
  setPollVote: jest.fn(),
}));
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvGetFor: jest.fn(async () => null),
  scopedKvSetFor: jest.fn(),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: jest.fn(async () => []),
  fanoutControlEnvelope: jest.fn(async () => ({ sent: 0, undelivered: [] })),
  undeliveredText: jest.fn(() => ''),
}));
jest.mock('../../identity/profileManager', () => ({ profileManager: { getActiveProfile: jest.fn() } }));

const mockTaken: Array<Record<string, unknown>> = [];
jest.mock('../pollVotePending', () => ({
  createPendingPollVotes: () => ({
    park: jest.fn(),
    take: jest.fn(() => mockTaken.splice(0, mockTaken.length)),
    size: jest.fn(() => mockTaken.length),
  }),
  isRetriablePollVoteCode: jest.fn(() => false),
}));

const mockSeen: string[] = [];
jest.mock('../groupActor', () => ({
  lookupGroupActor: jest.fn(async (groupId: string) => {
    mockSeen.push(groupId);
    if (groupId === 'g-throws') throw new Error('база недоступна');
    // Не-участник: применение штатно и без исключения заканчивается здесь.
    return { group: null, member: null, role: 'none' };
  }),
  roleOf: jest.fn(() => 'none'),
}));

import { flushPendingPollVotes } from '../pollVoteSync';

const mockLog = (jest.requireMock('../../logger') as { log: { warn: jest.Mock } }).log;

const parked = (groupId: string) => ({
  pid: 1,
  msgId: 'm1',
  senderPubB64: `pub-${groupId}`,
  idx: 0,
  on: true,
  ts: 1_000,
  groupId,
});

beforeEach(() => {
  mockTaken.length = 0;
  mockSeen.length = 0;
  mockLog.warn.mockClear();
});

it('голоса после сорвавшегося всё равно разбираются', async () => {
  mockTaken.push(parked('g-throws'), parked('g-second'), parked('g-third'));

  const applied = await flushPendingPollVotes('m1', 1, 2_000);

  // Хвост дошёл до разбора, а не сгинул вместе с первым голосом.
  expect(mockSeen).toEqual(['g-throws', 'g-second', 'g-third']);
  expect(applied).toBe(2);
  expect(mockLog.warn).toHaveBeenCalledWith('poll_vote_apply_failed', expect.objectContaining({
    err: 'база недоступна',
  }));
});

it('ПРОВЕРКА НЕ ПУСТАЯ: без отказов считаются все', async () => {
  mockTaken.push(parked('g-first'), parked('g-second'));

  const applied = await flushPendingPollVotes('m1', 1, 2_000);

  expect(applied).toBe(2);
  expect(mockLog.warn).not.toHaveBeenCalled();
});
