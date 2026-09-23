/**
 * Неизвестное состояние опроса не считается «открыт» (v4.32.644).
 *
 * Дефект. Флаг «опрос завершён» читался через scopedKvGetFor, а тот отвечает
 * одним null и на «флага нет», и на «база не ответила». Значит сбой чтения
 * читался как «опрос открыт»:
 *
 * - свой голос записывался в завершённый опрос и уходил конвертом. У себя
 *   человек видел +1, а все, у кого флаг прочитался, тот же конверт молча
 *   отбрасывали — ровно то расхождение, которое чинила v4.32.273;
 * - на приёме это рычаг в чужих руках: голос собеседника попадал в счётчики
 *   закрытого опроса, стоило у нас не прочитаться одной строке kv.
 *
 * Рядом тот же класс на записи: scopedKvSetFor отдаёт void, поэтому «Опрос
 * завершён» печаталось и тогда, когда флаг не лёг, — а конверт при этом
 * закрывал опрос всем остальным.
 *
 * Правка: обе проверки идут через pollIsClosed (null — «не знаем», и по нему
 * не голосуют), обе записи — через scopedKvSetCheckedFor.
 */

const mockKv = new Map<string, string>();
/** Записи, чтение которых «не удалось»: kvTryGet отвечает на них null. */
let mockFailClosedRead = false;
/** Записи, которые «не влезли»: kvSetChecked отвечает на них false. */
let mockFailClosedWrite = false;
const mockVotesSet: string[] = [];
const mockVotesDeleted: string[] = [];
let mockFanouts = 0;
let mockNotifies = 0;

function mockIsClosedKey(k: string): boolean {
  return k.includes('poll_closed_');
}

const MSG = 'msg-poll-1';
const mockGroup = 'g1';
const mockPeer = 'peer-pub-b64-aaaa';
const mockMe = 'me-pub';
const PID = 7;
const CLOSED_KEY = `p${PID}:poll_closed_${MSG}`;
const mockPollText = `\x04poll:${JSON.stringify({ question: 'Кофе или чай?', options: ['Кофе', 'Чай'] })}`;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => {
    if (mockFailClosedRead && mockIsClosedKey(k)) return null;
    return { value: mockKv.get(k) ?? null };
  },
  kvSetChecked: async (k: string, v: string) => {
    if (mockFailClosedWrite && mockIsClosedKey(k)) return false;
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvDeleteChecked: async (k: string) => {
    mockKv.delete(k);
    return true;
  },
  kvListKeysByPrefix: async () => [],
  setPollVote: async (msgId: string, voter: string, idx: number) => {
    mockVotesSet.push(`${msgId}/${voter}/${idx}`);
  },
  deletePollVote: async (msgId: string, voter: string, idx: number) => {
    mockVotesDeleted.push(`${msgId}/${voter}/${idx}`);
  },
  // Сообщение-опрос есть и в личке, и в группе: предмет теста — только флаг.
  getChatMessageTarget: async () => ({ contactPubB64: mockPeer, text: mockPollText }),
  getGroupMessageTarget: async () => ({ groupId: mockGroup, text: mockPollText }),
  getChatMessageAuthor: async () => ({ direction: 'in', contactPubB64: mockPeer }),
  // v4.32.763: те же строки в различающей форме — база здесь исправна.
  getChatMessageTargetRead: async () => ({
    state: 'found',
    value: { contactPubB64: mockPeer, text: mockPollText },
  }),
  getGroupMessageTargetRead: async () => ({
    state: 'found',
    value: { groupId: mockGroup, text: mockPollText },
  }),
  getChatMessageAuthorRead: async () => ({
    state: 'found',
    value: { direction: 'in', contactPubB64: mockPeer },
  }),
  listGroupMembers: async () => [
    { peerPubB64: mockMe, role: 'owner' },
    { peerPubB64: mockPeer, role: 'member' },
  ],
  listGroupMembersRead: async () => [
    { peerPubB64: mockMe, role: 'owner' },
    { peerPubB64: mockPeer, role: 'member' },
  ],
  getGroup: async () => ({ id: mockGroup, type: 'group', adminOnlyPosting: false }),
  // v4.32.755: приёмники конвертов опроса читают строку группы различающим
  // getGroupRead: «группы нет» и «база не ответила» — больше не одно и то же.
  getGroupRead: async () => ({
    state: 'found',
    value: { id: mockGroup, type: 'group', adminOnlyPosting: false },
  }),
  notifyChatStorageChanged: () => {
    mockNotifies += 1;
  },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 7, name: 'Рабочий' }),
    getActiveIdentity: () => ({ pid: 7, myPubB64: 'me-pub' }),
  },
}));

jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => {
    mockFanouts += 1;
    return { sent: true, recipients: 1 };
  },
  activeRecipients: () => ['peer-pub-b64-aaaa'],
  undeliveredText: (head: string) => `${head}, но разослать не вышло.`,
  fanoutReasonText: () => '',
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  castAndSyncPollVote,
  closeAndSyncPoll,
  encodePollCloseEnvelope,
  encodePollVoteEnvelope,
  handleIncomingPollClose,
  handleIncomingPollVote,
} from '../pollVoteSync';
import {
  scopedKvGetFor,
  scopedKvSetCheckedFor,
  scopedKvTryGetFor,
} from '../../storage/profileScopedKv';

const voteEnvelope = (on: boolean): string =>
  encodePollVoteEnvelope({ msgId: MSG, idx: 0, on, multi: false, ts: Date.now() });

const closeEnvelope = (): string => encodePollCloseEnvelope({ msgId: MSG, ts: Date.now() });

const castMine = (): ReturnType<typeof castAndSyncPollVote> =>
  castAndSyncPollVote({ msgId: MSG, idx: 0, on: true, multi: false, myPubB64: mockMe, peerPubB64: mockPeer });

beforeEach(() => {
  mockKv.clear();
  mockFailClosedRead = false;
  mockFailClosedWrite = false;
  mockVotesSet.length = 0;
  mockVotesDeleted.length = 0;
  mockFanouts = 0;
  mockNotifies = 0;
});

describe('повод для правки жив', () => {
  it('scopedKvGetFor отвечает одинаково на «флага нет» и на сбой чтения', async () => {
    expect(await scopedKvGetFor(PID, `poll_closed_${MSG}`)).toBeNull();
    mockFailClosedRead = true;
    expect(await scopedKvGetFor(PID, `poll_closed_${MSG}`)).toBeNull();
  });

  it('scopedKvTryGetFor эти два случая различает', async () => {
    expect(await scopedKvTryGetFor(PID, `poll_closed_${MSG}`)).toEqual({ value: null });
    mockFailClosedRead = true;
    expect(await scopedKvTryGetFor(PID, `poll_closed_${MSG}`)).toBeNull();
  });

  it('scopedKvSetCheckedFor отличает «легло» от «не влезло»', async () => {
    expect(await scopedKvSetCheckedFor(PID, `poll_closed_${MSG}`, '1')).toBe(true);
    mockFailClosedWrite = true;
    expect(await scopedKvSetCheckedFor(PID, `poll_closed_${MSG}`, '1')).toBe(false);
  });
});

describe('проверка не пустая: флаг читается — всё как было', () => {
  it('открытый опрос принимает свой голос и рассылает его', async () => {
    await expect(castMine()).resolves.toEqual({ ok: true });
    expect(mockVotesSet).toEqual([`${MSG}/${mockMe}/0`]);
    expect(mockFanouts).toBe(1);
  });

  it('завершённый опрос свой голос отклоняет — и говорит почему', async () => {
    mockKv.set(CLOSED_KEY, '1');
    await expect(castMine()).resolves.toEqual({ ok: false, reason: 'Опрос завершён' });
    expect(mockVotesSet).toEqual([]);
    expect(mockFanouts).toBe(0);
  });

  // v4.32.755: обработчики отвечают словом EnvelopeIntake вместо «конверт наш».
  // 'consumed' значит «метку докуда прочитано двигать можно».
  it('открытый опрос принимает чужой голос', async () => {
    const intake = await handleIncomingPollVote(voteEnvelope(true), mockPeer, PID);
    expect(intake).toBe('consumed');
    expect(mockVotesSet).toEqual([`${MSG}/${mockPeer}/0`]);
  });

  it('завершённый опрос чужой голос отбрасывает насовсем', async () => {
    mockKv.set(CLOSED_KEY, '1');
    const intake = await handleIncomingPollVote(voteEnvelope(true), mockPeer, PID);
    expect(intake).toBe('consumed');
    expect(mockVotesSet).toEqual([]);
  });

  it('завершение опроса ставит флаг, будит подписчиков и рассылает конверт', async () => {
    await expect(
      closeAndSyncPoll({ msgId: MSG, myPubB64: mockMe, peerPubB64: mockPeer })
    ).resolves.toEqual({ ok: true });
    expect(mockKv.get(CLOSED_KEY)).toBe('1');
    expect(mockNotifies).toBe(1);
    expect(mockFanouts).toBe(1);
  });

  it('чужое завершение тоже применяется', async () => {
    const intake = await handleIncomingPollClose(closeEnvelope(), mockPeer, PID);
    expect(intake).toBe('consumed');
    expect(mockKv.get(CLOSED_KEY)).toBe('1');
    expect(mockNotifies).toBe(1);
  });
});

describe('флаг не прочитался — голосовать нельзя', () => {
  it('свой голос не записан и никуда не ушёл', async () => {
    mockFailClosedRead = true;
    const res = await castMine();
    expect(res.ok).toBe(false);
    expect(mockVotesSet).toEqual([]);
    expect(mockVotesDeleted).toEqual([]);
    expect(mockFanouts).toBe(0);
  });

  it('причина отказа названа, по-русски и отличима от «Опрос завершён»', async () => {
    mockFailClosedRead = true;
    const res = await castMine();
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.reason.length).toBeGreaterThan(0);
    expect(res.reason).toMatch(/[А-Яа-яЁё]/);
    expect(res.reason).not.toBe('Опрос завершён');
  });

  it('снятие голоса при непрочитанном флаге тоже не проходит', async () => {
    mockFailClosedRead = true;
    const res = await castAndSyncPollVote({
      msgId: MSG,
      idx: 0,
      on: false,
      multi: false,
      myPubB64: mockMe,
      peerPubB64: mockPeer,
    });
    expect(res.ok).toBe(false);
    expect(mockVotesDeleted).toEqual([]);
  });

  // v4.32.755: осторожность тут верная — в завершённый опрос голос не пускаем,
  // — но пока кадр считался разобранным, цена одной занятой секунды kv равнялась
  // цене потерянного голоса: relay держит кадр ещё тридцать суток, а
  // перезапрашивают его только по метке «докуда прочитано».
  it('чужой голос не попадает в счётчики, и кадр откладывается', async () => {
    mockFailClosedRead = true;
    const intake = await handleIncomingPollVote(voteEnvelope(true), mockPeer, PID);
    expect(intake).toBe('deferred');
    expect(mockVotesSet).toEqual([]);
    expect(mockVotesDeleted).toEqual([]);
  });

  it('групповой голос отбрасывается по тому же правилу', async () => {
    mockFailClosedRead = true;
    const env = encodePollVoteEnvelope({
      msgId: MSG,
      idx: 0,
      on: true,
      multi: false,
      ts: Date.now(),
      groupId: mockGroup,
    });
    await expect(handleIncomingPollVote(env, mockPeer, PID)).resolves.toBe('deferred');
    expect(mockVotesSet).toEqual([]);
  });
});

describe('флаг не записался — опрос не завершён', () => {
  it('своё завершение отказывает и не рассылает конверт', async () => {
    mockFailClosedWrite = true;
    const res = await closeAndSyncPoll({ msgId: MSG, myPubB64: mockMe, peerPubB64: mockPeer });
    expect(res.ok).toBe(false);
    expect(mockKv.has(CLOSED_KEY)).toBe(false);
    expect(mockFanouts).toBe(0);
    expect(mockNotifies).toBe(0);
  });

  it('причина отказа названа и по-русски', async () => {
    mockFailClosedWrite = true;
    const res = await closeAndSyncPoll({ msgId: MSG, myPubB64: mockMe, peerPubB64: mockPeer });
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.reason.length).toBeGreaterThan(0);
    expect(res.reason).toMatch(/[А-Яа-яЁё]/);
  });

  // v4.32.755: второй посылки у конверта завершения нет. Пока он объявлялся
  // разобранным, занятая база оставляла опрос открытым навсегда.
  it('чужое завершение без удачной записи не будит подписчиков и откладывается', async () => {
    mockFailClosedWrite = true;
    const intake = await handleIncomingPollClose(closeEnvelope(), mockPeer, PID);
    expect(intake).toBe('deferred');
    expect(mockKv.has(CLOSED_KEY)).toBe(false);
    expect(mockNotifies).toBe(0);
  });

  it('после отказа записи опрос по-прежнему принимает голоса', async () => {
    mockFailClosedWrite = true;
    await closeAndSyncPoll({ msgId: MSG, myPubB64: mockMe, peerPubB64: mockPeer });
    mockFailClosedWrite = false;
    await expect(castMine()).resolves.toEqual({ ok: true });
  });
});
