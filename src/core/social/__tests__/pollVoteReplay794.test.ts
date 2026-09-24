/**
 * Голос в опросе получил знак свежести (v4.32.794).
 *
 * Дефект. Конверт голоса называет вариант и положение (`on`), а применялся без
 * всякой проверки времени. Тема relay выводится из открытых DID, писать в неё
 * может кто угодно, конверт живёт тридцать суток — значит перехваченный кадр
 * можно подать снова хоть через месяц.
 *
 * Цена. В одиночном опросе это не «лишний голос», а подмена: `setPollVote`
 * вытесняет прошлый выбор, поэтому сохранённый кадр «за вариант A» СТИРАЕТ тот
 * вариант, за который человек проголосовал потом. Кадр с `on:false` снимает
 * голос вовсе. Заметить нечем: пузырь опроса показывает счётчики, а не историю,
 * и у остальных получателей они свои — расхождение видно только при сверке
 * вживую.
 *
 * Правка. Ячейка на тройку «голосующий + вариант + сообщение». Не на опрос:
 * общий знак выбросил бы законный голос за B, поданный следом за более поздним
 * кадром про A, — relay отдаёт накопленное пачкой и порядка не держит. Не на
 * пару «голосующий + опрос» по той же причине. Проверка до записи, сдвиг
 * после: обе причины отказа (база занята, флаг не прочитался) проходят сами, и
 * знак не должен хоронить перезапрос, ради которого сказано `deferred`
 * (v4.32.755).
 */
import type { LookupResult } from '../../utils/lookupResult';

type FakeMember = { peerPubB64: string; role: string };
type FakeGroup = { id: string; type: string; adminOnlyPosting: boolean };

/** Голоса в базе: msgId → голосующий → набор выбранных вариантов. */
const mockVotes = new Map<string, Map<string, Set<number>>>();
/** Профильное kv — и флаг «завершён», и водяные знаки живут здесь. */
const mockKv = new Map<string, string>();
/** Бросит ли запись голоса — так ведёт себя упавший запрос к базе. */
let mockVoteWriteThrows = false;
let mockGroupRead: LookupResult<FakeGroup> = { state: 'missing' };
let mockMembers: FakeMember[] | null = [];
let mockGroupTarget: { groupId: string; senderPubB64: string; text: string } | null = null;
let mockDmTarget: { contactPubB64: string; text: string } | null = null;

/** Что лежит в базе за этого человека — в порядке возрастания варианта. */
const mockChosen = (msgId: string, who: string): number[] =>
  [...(mockVotes.get(msgId)?.get(who) ?? new Set<number>())].sort((a, b) => a - b);

jest.mock('../../storage/local', () => ({
  setPollVote: jest.fn(
    async (msgId: string, who: string, idx: number, _pid: number, allowMultiple: boolean) => {
      if (mockVoteWriteThrows) throw new Error('database is locked');
      const perMsg = mockVotes.get(msgId) ?? new Map<string, Set<number>>();
      // Одиночный опрос вытесняет прошлый выбор — ровно это и делает подмену
      // повтора разрушительной.
      const set = allowMultiple ? (perMsg.get(who) ?? new Set<number>()) : new Set<number>();
      set.add(idx);
      perMsg.set(who, set);
      mockVotes.set(msgId, perMsg);
    }
  ),
  deletePollVote: jest.fn(async (msgId: string, who: string, idx: number) => {
    if (mockVoteWriteThrows) throw new Error('database is locked');
    mockVotes.get(msgId)?.get(who)?.delete(idx);
  }),
  getGroupMessageTarget: jest.fn(async () => mockGroupTarget),
  getChatMessageTarget: jest.fn(async () => mockDmTarget),
  getChatMessageAuthor: jest.fn(async () => null),
  getGroupMessageTargetRead: jest.fn(async () =>
    mockGroupTarget ? { state: 'found', value: mockGroupTarget } : { state: 'missing' }
  ),
  getChatMessageTargetRead: jest.fn(async () =>
    mockDmTarget ? { state: 'found', value: mockDmTarget } : { state: 'missing' }
  ),
  getChatMessageAuthorRead: jest.fn(async () => ({ state: 'missing' })),
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  notifyChatStorageChanged: jest.fn(),
}));
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async (pid: number, k: string) => ({
    value: mockKv.get(`p${pid}:${k}`) ?? null,
  })),
  scopedKvSetCheckedFor: jest.fn(async (pid: number, k: string, v: string) => {
    mockKv.set(`p${pid}:${k}`, v);
    return true;
  }),
}));
jest.mock('../groupActor', () => {
  const roleOf = (members: FakeMember[], pub: string) =>
    members.find((m) => m.peerPubB64 === pub)?.role ?? null;
  return {
    roleOf,
    lookupGroupActorRead: jest.fn(async (_gid: string, actorPub: string) => {
      if (mockGroupRead.state === 'failed') return null;
      const group = mockGroupRead.state === 'found' ? mockGroupRead.value : null;
      if (!group) return { group: null, members: [], role: null };
      if (!mockMembers) return null;
      return { group, members: mockMembers, role: roleOf(mockMembers, actorPub) };
    }),
  };
});
jest.mock('../controlFanout', () => ({
  activeRecipients: () => [],
  fanoutControlEnvelope: jest.fn(async () => ({ sent: true, recipients: 0 })),
  undeliveredText: () => null,
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { pollVoteWatermarkKey, resetControlTsMirrorForTests } from '../controlWatermark';
import { makePollText } from '../pollEnvelope';
import { encodePollVoteEnvelope, handleIncomingPollVote } from '../pollVoteSync';

const OWNER = 1;
const SENDER = 'S'.repeat(43);
const OTHER = 'O'.repeat(43);
const GID = 'g-794';
const MSG = 'm-794';
const TS = 1_700_000_000_000;

/** Опрос одиночный: именно он вытесняет прошлый выбор. */
const POLL_TEXT = makePollText('Куда?', ['сюда', 'туда', 'мимо']);

/** Конверт голоса — личный, если группу не назвали. */
function vote(idx: number, ts: number, on = true, groupId?: string): string {
  return encodePollVoteEnvelope({
    msgId: MSG,
    idx,
    on,
    multi: false,
    ts,
    ...(groupId ? { groupId } : {}),
  });
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
  // Зеркало знака живёт на уровне модуля и уборку базы переживает (v4.32.791).
  resetControlTsMirrorForTests();
  mockVotes.clear();
  mockKv.clear();
  mockVoteWriteThrows = false;
  mockGroupRead = { state: 'found', value: { id: GID, type: 'group', adminOnlyPosting: false } };
  mockMembers = [{ peerPubB64: SENDER, role: 'member' }, { peerPubB64: OTHER, role: 'member' }];
  mockGroupTarget = { groupId: GID, senderPubB64: SENDER, text: POLL_TEXT };
  mockDmTarget = { contactPubB64: SENDER, text: POLL_TEXT };
});

describe('сохранённый кадр больше не подменяет чужой выбор', () => {
  it('повтор «за первый вариант» не стирает выбранный потом второй', async () => {
    expect(await handleIncomingPollVote(vote(0, TS), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([0]);

    // Человек передумал — законно и позже.
    expect(await handleIncomingPollVote(vote(1, TS + 1000), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([1]);

    // А вот перехваченный первый кадр, поданный снова.
    expect(await handleIncomingPollVote(vote(0, TS), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([1]);
  });

  it('повтор снятия голоса не снимает поданный позже', async () => {
    await handleIncomingPollVote(vote(0, TS, false), SENDER, OWNER);
    await handleIncomingPollVote(vote(0, TS + 1000, true), SENDER, OWNER);
    expect(mockChosen(MSG, SENDER)).toEqual([0]);

    expect(await handleIncomingPollVote(vote(0, TS, false), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([0]);
  });

  it('повтор ничего не пишет в базу вовсе', async () => {
    const storage = jest.requireMock('../../storage/local') as { setPollVote: jest.Mock };
    await handleIncomingPollVote(vote(0, TS), SENDER, OWNER);
    storage.setPollVote.mockClear();
    await handleIncomingPollVote(vote(0, TS), SENDER, OWNER);
    expect(storage.setPollVote).not.toHaveBeenCalled();
  });

  it('в группе — то же самое', async () => {
    await handleIncomingPollVote(vote(0, TS, true, GID), SENDER, OWNER);
    await handleIncomingPollVote(vote(1, TS + 1000, true, GID), SENDER, OWNER);
    expect(await handleIncomingPollVote(vote(0, TS, true, GID), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([1]);
  });
});

describe('ячейка узкая: законное не выбрасывается', () => {
  it('у каждого варианта своя отметка', async () => {
    // Порядок между вариантами relay не держит: кадр про второй вариант с
    // меньшей меткой — обычное дело, и выбрасывать его нельзя.
    await handleIncomingPollVote(vote(0, TS + 5000), SENDER, OWNER);
    expect(await handleIncomingPollVote(vote(1, TS), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([1]);
  });

  it('у каждого голосующего своя отметка', async () => {
    await handleIncomingPollVote(vote(0, TS + 5000, true, GID), SENDER, OWNER);
    expect(await handleIncomingPollVote(vote(0, TS, true, GID), OTHER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, OTHER)).toEqual([0]);
  });

  it('у каждого опроса своя отметка', () => {
    expect(pollVoteWatermarkKey(SENDER, 0, 'm-1')).not.toBe(pollVoteWatermarkKey(SENDER, 0, 'm-2'));
    expect(pollVoteWatermarkKey(SENDER, 0, MSG)).not.toBe(pollVoteWatermarkKey(SENDER, 1, MSG));
    expect(pollVoteWatermarkKey(SENDER, 0, MSG)).not.toBe(pollVoteWatermarkKey(OTHER, 0, MSG));
  });

  it('неограниченная часть в имени одна и стоит последней', () => {
    // Голосующий приходит из подписанного отправителя, номер варианта кодек
    // держит целым числом в пределах допустимого — подставить двоеточие можно
    // только в идентификатор сообщения, а он последний.
    expect(pollVoteWatermarkKey(SENDER, 0, 'a:b')).not.toBe(pollVoteWatermarkKey(SENDER, 0, 'a'));
    expect(codeOnly(read('pollVoteSync.ts'))).toContain(
      'pollVoteTsFresh(senderPubB64, env.idx, env.msgId, pid, env.ts)'
    );
  });
});

describe('знак не хоронит перезапрос (v4.32.755 цел)', () => {
  it('запись упала — кадр отложен, знак не поставлен', async () => {
    mockVoteWriteThrows = true;
    expect(await handleIncomingPollVote(vote(0, TS), SENDER, OWNER)).toBe('deferred');

    mockVoteWriteThrows = false;
    expect(await handleIncomingPollVote(vote(0, TS), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([0]);
  });

  it('состав группы не прочитался — знак тоже не ставится', async () => {
    mockMembers = null;
    expect(await handleIncomingPollVote(vote(0, TS, true, GID), SENDER, OWNER)).toBe('deferred');

    mockMembers = [{ peerPubB64: SENDER, role: 'member' }];
    expect(await handleIncomingPollVote(vote(0, TS, true, GID), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([0]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычное голосование не задето', () => {
  it('голос применяется', async () => {
    expect(await handleIncomingPollVote(vote(1, TS), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([1]);
  });

  it('поток честных кадров проходит целиком', async () => {
    expect(await handleIncomingPollVote(vote(0, TS), SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingPollVote(vote(0, TS + 1, false), SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingPollVote(vote(2, TS + 2), SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([2]);
  });

  it('голос от не-участника группы не проходит и знака не двигает', async () => {
    mockMembers = [{ peerPubB64: SENDER, role: 'member' }];
    expect(await handleIncomingPollVote(vote(0, TS, true, GID), OTHER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, OTHER)).toEqual([]);
  });

  it('мусор вместо конверта годным не станет', async () => {
    expect(await handleIncomingPollVote('просто текст', SENDER, OWNER)).toBe('consumed');
    expect(mockChosen(MSG, SENDER)).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('одиночный опрос вытесняет прошлый выбор — потому подмена и разрушительна', () => {
    const body = codeOnly(read('pollVoteSync.ts'));
    expect(body).toContain(
      'await setPollVote(env.msgId, senderPubB64, env.idx, pid, target.allowMultiple)'
    );
  });

  it('положение берётся из кадра', () => {
    expect(codeOnly(read('pollVoteSync.ts'))).toContain('if (env.on) await setPollVote(');
  });

  it('конверт живёт достаточно долго, чтобы повтор был не теорией', () => {
    expect(codeOnly(read('messaging.ts'))).toContain(
      'const ENVELOPE_MAX_AGE_MS = RELAY_RETENTION_MS;'
    );
    expect(codeOnly(read('..', 'transport', 'retentionWindow.ts'))).toContain(
      'export const RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;'
    );
  });
});
