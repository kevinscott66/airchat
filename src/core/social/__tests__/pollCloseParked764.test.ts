/**
 * Завершение опроса, обогнавшее сам опрос, больше не пропадает (v4.32.764).
 *
 * Дефект. Опрос едет обычным сообщением, а конверт завершения — служебным:
 * разные размеры, разные дороги, разная скорость, и порядок между ними не
 * гарантирован ничем. У голоса на этот случай с v4.32.573 есть полка, а у
 * завершения не было: приёмник не находил в базе сообщения-опроса и отбрасывал
 * конверт навсегда — `poll_close_unknown_message` в группе и
 * `poll_close_not_author_drop` в личном (там «строки нет» и «прислал не автор»
 * были одной веткой).
 *
 * Чем это кончалось. Второй посылки у завершения нет — опрос закрывают один
 * раз, и переспросить автора нечем. Опрос оставался открытым у получателя
 * НАВСЕГДА: тот продолжал в нём голосовать, а его голоса на другой стороне
 * отбрасывались как «в закрытый опрос» (v4.32.252). Ни одна из сторон этого
 * расхождения не видит.
 *
 * Правка. Такой конверт ложится на полку рядом с голосами и снимается тем же
 * приёмом — когда сообщение-опрос записано. Все проверки прав проходят заново:
 * на полке лежит конверт, а не разрешение. Порядок разбора обязателен: сперва
 * голоса, потом завершение, иначе завершение отбросило бы голоса, которые
 * отправитель сделал ДО него.
 */

import type { LookupResult } from '../../utils/lookupResult';

type Target = { groupId: string; senderPubB64: string; text: string | null };
type Author = { contactPubB64: string; direction: string };

/** Что ответит чтение строки группового сообщения. */
let mockGroupTarget: LookupResult<Target> = { state: 'missing' };
/** Что ответит чтение автора личной строки. */
let mockDmAuthor: LookupResult<Author> = { state: 'missing' };
/** Состав группы: роль отправителя ищется по нему. */
let mockMembers: { peerPubB64: string; role: string }[] = [];
/** Записанные голоса — по ним видно, применён голос или нет. */
const mockVotes: string[] = [];
/**
 * kv здесь с памятью, а не заглушка: порядок разбора полок проверяется именно
 * тем, что записанный флаг «завершён» виден следующему чтению.
 */
const mockKv = new Map<string, string>();
/** Отказ записи флага — отдельно от его отсутствия. */
let mockKvSetOk = true;

jest.mock('../../storage/local', () => ({
  setPollVote: jest.fn(async (msgId: string) => {
    mockVotes.push(msgId);
  }),
  deletePollVote: jest.fn(async () => {}),
  getGroupMessageTargetRead: jest.fn(async () => mockGroupTarget),
  getChatMessageTargetRead: jest.fn(async () => mockGroupTarget),
  getChatMessageAuthorRead: jest.fn(async () => mockDmAuthor),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  notifyChatStorageChanged: jest.fn(),
}));
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async (_pid: number, key: string) => ({
    value: mockKv.get(key) ?? null,
  })),
  scopedKvSetCheckedFor: jest.fn(async (_pid: number, key: string, value: string) => {
    if (!mockKvSetOk) return false;
    mockKv.set(key, value);
    return true;
  }),
}));
jest.mock('../groupActor', () => {
  const roleOf = (members: { peerPubB64: string; role: string }[], pub: string) =>
    members.find((m) => m.peerPubB64 === pub)?.role ?? null;
  return {
    roleOf,
    lookupGroupActorRead: jest.fn(async (gid: string, actorPub: string) => ({
      group: { id: gid, type: 'group', adminOnlyPosting: false },
      members: mockMembers,
      role: roleOf(mockMembers, actorPub),
    })),
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

import { makePollText } from '../pollEnvelope';
import {
  PENDING_VOTE_MAX,
  PENDING_VOTE_TTL_MS,
  createPendingPollCloses,
} from '../pollVotePending';
import {
  encodePollCloseEnvelope,
  encodePollVoteEnvelope,
  flushPendingPollCloses,
  flushPendingPollEnvelopes,
  handleIncomingPollClose,
  handleIncomingPollVote,
  pollClosedKey,
} from '../pollVoteSync';

const PID = 1;
const SENDER = 'S'.repeat(43);
const OTHER = 'O'.repeat(43);
const GID = 'g-764';
const POLL = makePollText('Куда?', ['Лес', 'Море']);

/**
 * Полка живёт в модуле и переживает соседний тест. Чтобы тесты не подбирали
 * чужие конверты, у каждого свой номер сообщения.
 */
let msgSeq = 0;
const nextMsg = (): string => `msg-764-${++msgSeq}`;

const groupClose = (msgId: string, from = SENDER): Promise<string> =>
  handleIncomingPollClose(encodePollCloseEnvelope({ msgId, ts: 10, groupId: GID }), from, PID);

const dmClose = (msgId: string, from = SENDER): Promise<string> =>
  handleIncomingPollClose(encodePollCloseEnvelope({ msgId, ts: 10 }), from, PID);

const groupVote = (msgId: string): Promise<string> =>
  handleIncomingPollVote(
    encodePollVoteEnvelope({ msgId, idx: 0, on: true, multi: false, ts: 10, groupId: GID }),
    SENDER,
    PID
  );

/** Опрос доехал: строка читается и принадлежит той же группе и автору. */
const messageArrives = (): void => {
  mockGroupTarget = { state: 'found', value: { groupId: GID, senderPubB64: SENDER, text: POLL } };
  mockDmAuthor = { state: 'found', value: { contactPubB64: SENDER, direction: 'in' } };
};

/** Опроса ещё нет — то самое состояние, ради которого заведена полка. */
const messageNotYet = (): void => {
  mockGroupTarget = { state: 'missing' };
  mockDmAuthor = { state: 'missing' };
};

const isClosed = (msgId: string): boolean => mockKv.has(pollClosedKey(msgId));

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');

beforeEach(() => {
  messageArrives();
  mockMembers = [{ peerPubB64: SENDER, role: 'member' }];
  mockVotes.length = 0;
  mockKv.clear();
  mockKvSetOk = true;
});

describe('завершение опроса дожидается своего опроса', () => {
  it('в группе: конверт обогнал опрос — опрос закрывается, когда тот приходит', async () => {
    const msg = nextMsg();
    messageNotYet();
    expect(await groupClose(msg)).toBe('consumed');
    expect(isClosed(msg)).toBe(false);

    messageArrives();
    expect(await flushPendingPollCloses(msg, PID)).toBe(1);
    expect(isClosed(msg)).toBe(true);
  });

  it('в личном: то же самое', async () => {
    const msg = nextMsg();
    messageNotYet();
    expect(await dmClose(msg)).toBe('consumed');
    expect(isClosed(msg)).toBe(false);

    messageArrives();
    expect(await flushPendingPollCloses(msg, PID)).toBe(1);
    expect(isClosed(msg)).toBe(true);
  });

  it('права проверяются заново при снятии, а не при укладке', async () => {
    const msg = nextMsg();
    messageNotYet();
    await groupClose(msg);
    // Пока конверт лежал, выяснилось, что опрос не его и он не администратор.
    messageArrives();
    mockGroupTarget = { state: 'found', value: { groupId: GID, senderPubB64: OTHER, text: POLL } };
    expect(await flushPendingPollCloses(msg, PID)).toBe(1);
    expect(isClosed(msg)).toBe(false);
  });

  it('снятый конверт не ложится обратно на полку', async () => {
    const msg = nextMsg();
    messageNotYet();
    await groupClose(msg);
    // Сообщения по-прежнему нет: второй раз откладывать нечего и некуда.
    expect(await flushPendingPollCloses(msg, PID)).toBe(1);
    messageArrives();
    expect(await flushPendingPollCloses(msg, PID)).toBe(0);
    expect(isClosed(msg)).toBe(false);
  });

  it('конверт не переходит к чужому профилю', async () => {
    const msg = nextMsg();
    messageNotYet();
    await groupClose(msg);
    messageArrives();
    expect(await flushPendingPollCloses(msg, PID + 1)).toBe(0);
    expect(await flushPendingPollCloses(msg, PID)).toBe(1);
  });
});

describe('порядок разбора: голоса раньше завершения', () => {
  it('голос, отложенный вместе с завершением, успевает примениться', async () => {
    const msg = nextMsg();
    messageNotYet();
    expect(await groupVote(msg)).toBe('consumed');
    expect(await groupClose(msg)).toBe('consumed');
    expect(mockVotes).toEqual([]);

    messageArrives();
    await flushPendingPollEnvelopes(msg, PID);
    // Обратный порядок закрыл бы опрос до разбора голосов, и голос ушёл бы в
    // «в закрытый опрос» — то есть пропал бы ровно так же, как раньше пропадало
    // само завершение.
    expect(mockVotes).toEqual([msg]);
    expect(isClosed(msg)).toBe(true);
  });

  it('голос, пришедший ПОСЛЕ разбора, в закрытый опрос уже не идёт', async () => {
    const msg = nextMsg();
    messageNotYet();
    await groupClose(msg);
    messageArrives();
    await flushPendingPollEnvelopes(msg, PID);
    expect(await groupVote(msg)).toBe('consumed');
    expect(mockVotes).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: полка не стала складом негодных конвертов', () => {
  it('отказ базы по-прежнему откладывает КАДР, а не конверт (v4.32.763)', async () => {
    const msg = nextMsg();
    mockGroupTarget = { state: 'failed' };
    expect(await groupClose(msg)).toBe('deferred');
    messageArrives();
    expect(await flushPendingPollCloses(msg, PID)).toBe(0);
  });

  it('личное завершение от не-автора не откладывается', async () => {
    const msg = nextMsg();
    mockDmAuthor = { state: 'found', value: { contactPubB64: SENDER, direction: 'out' } };
    expect(await dmClose(msg)).toBe('consumed');
    messageArrives();
    expect(await flushPendingPollCloses(msg, PID)).toBe(0);
    expect(isClosed(msg)).toBe(false);
  });

  it('личное завершение от постороннего не откладывается', async () => {
    const msg = nextMsg();
    expect(await dmClose(msg, OTHER)).toBe('consumed');
    messageArrives();
    expect(await flushPendingPollCloses(msg, PID)).toBe(0);
  });

  it('завершение, названное чужой группой, не откладывается', async () => {
    const msg = nextMsg();
    mockGroupTarget = { state: 'found', value: { groupId: 'g-другая', senderPubB64: SENDER, text: POLL } };
    expect(await groupClose(msg)).toBe('consumed');
    messageArrives();
    expect(await flushPendingPollCloses(msg, PID)).toBe(0);
    expect(isClosed(msg)).toBe(false);
  });

  it('отказ записи флага откладывает кадр и при снятии с полки', async () => {
    const msg = nextMsg();
    messageNotYet();
    await groupClose(msg);
    messageArrives();
    mockKvSetOk = false;
    expect(await flushPendingPollCloses(msg, PID)).toBe(0);
    expect(isClosed(msg)).toBe(false);
  });
});

describe('полка завершений: границы', () => {
  const close = (msgId: string, ts: number, pid = 1): Parameters<
    ReturnType<typeof createPendingPollCloses>['park']
  >[0] => ({ pid, msgId, senderPubB64: SENDER, ts });

  it('повтор от того же человека по тому же опросу не удваивается', () => {
    const shelf = createPendingPollCloses();
    shelf.park(close('m', 1));
    shelf.park(close('m', 2));
    expect(shelf.size()).toBe(1);
    expect(shelf.take('m', 1, 3)).toHaveLength(1);
  });

  it('завершения от разных людей лежат отдельно', () => {
    const shelf = createPendingPollCloses();
    shelf.park(close('m', 1));
    shelf.park({ pid: 1, msgId: 'm', senderPubB64: OTHER, ts: 1 });
    expect(shelf.size()).toBe(2);
  });

  it('просроченный конверт не отдаётся и не остаётся лежать', () => {
    const shelf = createPendingPollCloses();
    shelf.park(close('m', 0));
    expect(shelf.take('m', 1, PENDING_VOTE_TTL_MS + 1)).toEqual([]);
    expect(shelf.size()).toBe(0);
  });

  it('переполнение вытесняет самый старый конверт', () => {
    const shelf = createPendingPollCloses(2);
    shelf.park(close('a', 1));
    shelf.park(close('b', 2));
    shelf.park(close('c', 3));
    expect(shelf.size()).toBe(2);
    expect(shelf.take('a', 1, 4)).toEqual([]);
    expect(shelf.take('c', 1, 4)).toHaveLength(1);
  });

  it('негодный конверт полка не принимает', () => {
    const shelf = createPendingPollCloses();
    expect(shelf.park(close('', 1))).toBe(false);
    expect(shelf.park({ pid: 1, msgId: 'm', senderPubB64: '', ts: 1 })).toBe(false);
    expect(shelf.park(close('m', NaN))).toBe(false);
    expect(shelf.size()).toBe(0);
  });

  it('мусор вместо границ не отключает их', () => {
    const shelf = createPendingPollCloses(0, -1);
    expect(shelf.park(close('m', 0))).toBe(true);
    expect(shelf.take('m', 1, PENDING_VOTE_TTL_MS + 1)).toEqual([]);
    const big = createPendingPollCloses(NaN);
    for (let i = 0; i < PENDING_VOTE_MAX + 5; i++) big.park(close(`m${i}`, 1));
    expect(big.size()).toBe(PENDING_VOTE_MAX);
  });

  it('полка проверяется без базы, сети и часов', () => {
    expect(read('core', 'social', 'pollVotePending.ts')).not.toMatch(/^import /m);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: оба места приёма разбирают обе полки', () => {
  it('личный приём зовёт общий разбор', () => {
    const body = codeOnly(read('core', 'social', 'messaging.ts'));
    expect(body).toContain('flushPendingPollEnvelopes(row.id, ownerPid)');
    expect(body).not.toContain('flushPendingPollVotes(row.id');
  });

  it('групповой приём зовёт общий разбор', () => {
    const body = codeOnly(read('core', 'social', 'groupMessaging.ts'));
    expect(body).toContain('flushPendingPollEnvelopes(env.msgId, pid)');
    expect(body).not.toContain('flushPendingPollVotes(env.msgId');
  });

  it('общий разбор берёт голоса первыми', () => {
    const body = codeOnly(read('core', 'social', 'pollVoteSync.ts'));
    // v4.32.797: у обеих выкладок появился номер попытки — повтор назначает
    // себя сам, и порядок «сперва голоса» он обязан повторять тоже.
    const votes = body.indexOf('await flushPendingPollVotes(msgId, pid, now, attempt);');
    const closes = body.indexOf('await flushPendingPollCloses(msgId, pid, now, attempt);');
    expect(votes).toBeGreaterThan(-1);
    expect(closes).toBeGreaterThan(votes);
  });

  it('оба места «сообщения нет» в завершении ведут на полку', () => {
    const body = codeOnly(read('core', 'social', 'pollVoteSync.ts'));
    expect(body.split("parkOrDrop('poll_close_unknown_message')").length - 1).toBe(2);
    expect(body).toContain("if (author.direction !== 'in' || author.contactPubB64 !== senderPubB64)");
  });
});
