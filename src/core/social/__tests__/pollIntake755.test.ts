/**
 * Занятая база больше не теряет голос и не оставляет опрос открытым (v4.32.755).
 *
 * Дефект тот же, что у реакции в v4.32.754, и в опросах он шире: оба
 * обработчика возвращали `boolean` со значением «конверт наш», а развилки в
 * `messaging.ts` этот ответ выбрасывали и объявляли кадр разобранным всегда.
 * «Разобрано» двигает метку «докуда прочитано», а relay отдаёт накопленное
 * только по ней — значит любая секунда занятой базы стоила голоса насовсем.
 *
 * Входов в беду у опроса четыре, и три из них лечатся сами:
 *   • роль отправителя бралась схлопывающим `lookupGroupActor` — отказ базы
 *     выглядел как «группа незнакомая», и голос участника отбрасывался;
 *   • флаг «опрос завершён» читается перед записью, и его нечитаемость
 *     трактовалась как «закрыт» — голос ронялся из осторожности, цена которой
 *     равна цене потери;
 *   • сама запись голоса на упавшем запросе бросала, и исключение уходило в
 *     общую ловушку приёмника кадра: исход был верным по случайности;
 *   • у завершения опроса — отказ `scopedKvSetCheckedFor`: конверт объявлялся
 *     разобранным, а опрос оставался открытым навсегда, и все дальнейшие
 *     голоса этого человека вторая сторона отбрасывала как «в закрытый опрос».
 *
 * Правка. Оба обработчика отвечают словом `EnvelopeIntake`, обе развилки в
 * `messaging` отдают его наверх, состав группы читается различающим
 * `lookupGroupActorRead`. Откладывается ровно то, что пройдёт само.
 */
import type { LookupResult } from '../../utils/lookupResult';

type FakeMember = { peerPubB64: string; role: string };
type FakeGroup = { id: string; type: string; adminOnlyPosting: boolean };

/** Строка группы: 'failed' — база не ответила, 'missing' — такой группы нет. */
let mockGroupRead: LookupResult<FakeGroup> = { state: 'missing' };
/** Состав группы. `null` — состав не прочитался, как у listGroupMembersRead. */
let mockMembers: FakeMember[] | null = [];
/** Ответ kv на чтение флага «завершён». `null` — прочитать не удалось. */
let mockClosedRead: { value: string | null } | null = { value: null };
/** Ляжет ли запись флага «завершён» (scopedKvSetCheckedFor). */
let mockKvSetOk = true;
/** Бросит ли запись голоса — так ведёт себя упавший запрос к базе. */
let mockVoteWriteThrows = false;
/** Строка сообщения-опроса в группе. `null` — такого сообщения у нас нет. */
let mockGroupTarget: { groupId: string; senderPubB64: string; text: string } | null = null;
/** Строка личного сообщения-опроса. */
let mockDmTarget: { contactPubB64: string; text: string } | null = null;
/** Автор личного сообщения — для проверки прав на завершение. */
let mockDmAuthor: { direction: string; contactPubB64: string } | null = null;

jest.mock('../../storage/local', () => ({
  setPollVote: jest.fn(async () => {
    if (mockVoteWriteThrows) throw new Error('database is locked');
  }),
  deletePollVote: jest.fn(async () => {
    if (mockVoteWriteThrows) throw new Error('database is locked');
  }),
  getGroupMessageTarget: jest.fn(async () => mockGroupTarget),
  getChatMessageTarget: jest.fn(async () => mockDmTarget),
  getChatMessageAuthor: jest.fn(async () => mockDmAuthor),
  // v4.32.763: тот же набор в различающей форме. Здесь база исправна, поэтому
  // `null` означает ровно «такой строки нет» — 'missing', не 'failed'.
  getGroupMessageTargetRead: jest.fn(async () =>
    mockGroupTarget ? { state: 'found', value: mockGroupTarget } : { state: 'missing' }
  ),
  getChatMessageTargetRead: jest.fn(async () =>
    mockDmTarget ? { state: 'found', value: mockDmTarget } : { state: 'missing' }
  ),
  getChatMessageAuthorRead: jest.fn(async () =>
    mockDmAuthor ? { state: 'found', value: mockDmAuthor } : { state: 'missing' }
  ),
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  notifyChatStorageChanged: jest.fn(),
}));
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async () => mockClosedRead),
  scopedKvSetCheckedFor: jest.fn(async () => mockKvSetOk),
}));
jest.mock('../groupActor', () => {
  const roleOf = (members: FakeMember[], pub: string) =>
    members.find((m) => m.peerPubB64 === pub)?.role ?? null;
  return {
    roleOf,
    // Поведение настоящего чтения: null — «проверять нечем».
    lookupGroupActorRead: jest.fn(async (_gid: string, actorPub: string) => {
      if (mockGroupRead.state === 'failed') return null;
      const group = mockGroupRead.state === 'found' ? mockGroupRead.value : null;
      if (!group) return { group: null, members: [], role: null };
      if (!mockMembers) return null;
      return { group, members: mockMembers, role: roleOf(mockMembers, actorPub) };
    }),
  };
});
// Приём конверта в сеть не ходит; воронка подменена, чтобы не тянуть службу
// переписки со всем её деревом зависимостей (uuid там — ESM).
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
  encodePollCloseEnvelope,
  encodePollVoteEnvelope,
  handleIncomingPollClose,
  handleIncomingPollVote,
} from '../pollVoteSync';

const OWNER = 1;
const SENDER = 'S'.repeat(43);
const GID = 'g-755';
/**
 * Текст самого опроса — собран его же кодировщиком, а не набран от руки:
 * иначе строка, которую pollVoteGuard не признаёт опросом, сделала бы весь
 * «удачный» путь ниже проверкой отказа, тихо и незаметно.
 */
const POLL_TEXT = makePollText('Куда?', ['сюда', 'туда']);

/** Конверт голоса — личный, если группу не назвали. */
function voteEnvelope(groupId?: string): string {
  return encodePollVoteEnvelope({
    msgId: 'm-1',
    idx: 0,
    on: true,
    multi: false,
    ts: 1000,
    ...(groupId ? { groupId } : {}),
  });
}

/** Конверт завершения — личный, если группу не назвали. */
function closeEnvelope(groupId?: string): string {
  return encodePollCloseEnvelope({ msgId: 'm-1', ts: 1000, ...(groupId ? { groupId } : {}) });
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const storage = jest.requireMock('../../storage/local') as {
  setPollVote: jest.Mock;
  notifyChatStorageChanged: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGroupRead = { state: 'found', value: { id: GID, type: 'group', adminOnlyPosting: false } };
  mockMembers = [{ peerPubB64: SENDER, role: 'member' }];
  mockClosedRead = { value: null };
  mockKvSetOk = true;
  mockVoteWriteThrows = false;
  mockGroupTarget = { groupId: GID, senderPubB64: SENDER, text: POLL_TEXT };
  mockDmTarget = { contactPubB64: SENDER, text: POLL_TEXT };
  mockDmAuthor = { direction: 'in', contactPubB64: SENDER };
});

describe('голос: причина уйдёт сама — кадр откладываем', () => {
  it('строка группы не прочиталась: это не «группа незнакомая»', async () => {
    mockGroupRead = { state: 'failed' };

    expect(await handleIncomingPollVote(voteEnvelope(GID), SENDER, OWNER)).toBe('deferred');
  });

  it('состав группы не прочитался: проверять роль нечем', async () => {
    mockMembers = null;

    expect(await handleIncomingPollVote(voteEnvelope(GID), SENDER, OWNER)).toBe('deferred');
  });

  it('флаг «завершён» не прочитался: осторожность не должна стоить голоса', async () => {
    mockClosedRead = null;

    expect(await handleIncomingPollVote(voteEnvelope(), SENDER, OWNER)).toBe('deferred');
  });

  it('запись голоса упала: исход назван, а не пойман общей ловушкой', async () => {
    mockVoteWriteThrows = true;

    expect(await handleIncomingPollVote(voteEnvelope(), SENDER, OWNER)).toBe('deferred');
  });
});

describe('завершение: причина уйдёт сама — кадр откладываем', () => {
  it('строка группы не прочиталась', async () => {
    mockGroupRead = { state: 'failed' };

    expect(await handleIncomingPollClose(closeEnvelope(GID), SENDER, OWNER)).toBe('deferred');
  });

  it('состав группы не прочитался', async () => {
    mockMembers = null;

    expect(await handleIncomingPollClose(closeEnvelope(GID), SENDER, OWNER)).toBe('deferred');
  });

  it('пометка не легла — опрос у нас остался открытым, и это не «разобрано»', async () => {
    mockKvSetOk = false;

    expect(await handleIncomingPollClose(closeEnvelope(), SENDER, OWNER)).toBe('deferred');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ — сторож стоит со стороны перестраховки.
 *
 * Прежний код заваливает набор целиком: тип ответа сменился, и `.toBe` не
 * совпадёт ни в одной строке — такое «доказательство» ничего не стоит. Опасна
 * здесь другая правка, в одну строку: `return 'deferred'` на любом отказе. Она
 * чинит тот же дефект и выглядит надёжнее. Метку она не заклинит — приёмник
 * (`internetCoordinator`, `failedOnce`) даёт кадру ровно одну вторую попытку и
 * после неё отпускает сам, — но каждый заведомо мёртвый кадр разбирается
 * дважды, а в журнал ложится `internet_frame_deferred_again`: строка, по
 * которой ищут настоящие отсрочки. Проверки ниже падают именно на такой версии.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: постоянная причина держать метку не должна', () => {
  it('голос применился — разобрано', async () => {
    expect(await handleIncomingPollVote(voteEnvelope(), SENDER, OWNER)).toBe('consumed');
    // Слово 'consumed' одинаково у «записали» и у «отбросили»: без этой строки
    // весь удачный путь мог бы сойтись на любом отказе — и сошёлся однажды,
    // пока текст опроса в этом наборе был набран от руки.
    expect(storage.setPollVote).toHaveBeenCalled();
  });

  it('завершение применилось — разобрано', async () => {
    expect(await handleIncomingPollClose(closeEnvelope(), SENDER, OWNER)).toBe('consumed');
    expect(storage.notifyChatStorageChanged).toHaveBeenCalled();
  });

  it('опрос правда завершён — голос в него не примут и завтра', async () => {
    mockClosedRead = { value: '1' };

    expect(await handleIncomingPollVote(voteEnvelope(), SENDER, OWNER)).toBe('consumed');
  });

  it('группы у нас правда нет — это обычный мусор из сети', async () => {
    mockGroupRead = { state: 'missing' };

    expect(await handleIncomingPollVote(voteEnvelope(GID), SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingPollClose(closeEnvelope(GID), SENDER, OWNER)).toBe('consumed');
  });

  it('отправитель не участник — отбрасываем насовсем, метку не держим', async () => {
    mockMembers = [{ peerPubB64: 'кто-то другой', role: 'member' }];

    expect(await handleIncomingPollVote(voteEnvelope(GID), SENDER, OWNER)).toBe('consumed');
  });

  it('участник в бане — тоже насовсем', async () => {
    mockMembers = [{ peerPubB64: SENDER, role: 'banned' }];

    expect(await handleIncomingPollVote(voteEnvelope(GID), SENDER, OWNER)).toBe('consumed');
  });

  it('завершение чужого опроса рядовым участником — анти-спуф, а не отсрочка', async () => {
    mockGroupTarget = { groupId: GID, senderPubB64: 'автор опроса', text: POLL_TEXT };

    expect(await handleIncomingPollClose(closeEnvelope(GID), SENDER, OWNER)).toBe('consumed');
  });

  it('сообщение из другой группы — тот же анти-спуф', async () => {
    mockGroupTarget = { groupId: 'другая-группа', senderPubB64: SENDER, text: POLL_TEXT };

    expect(await handleIncomingPollClose(closeEnvelope(GID), SENDER, OWNER)).toBe('consumed');
  });

  it('личное завершение не от автора опроса — отбрасываем насовсем', async () => {
    mockDmAuthor = { direction: 'out', contactPubB64: SENDER };

    expect(await handleIncomingPollClose(closeEnvelope(), SENDER, OWNER)).toBe('consumed');
  });

  it('не тот префикс и мусор вместо конверта — годными они не станут', async () => {
    expect(await handleIncomingPollVote('просто текст', SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingPollVote('\x15pv:{нет', SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingPollVote(voteEnvelope(), undefined, OWNER)).toBe('consumed');
    expect(await handleIncomingPollClose('просто текст', SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingPollClose(closeEnvelope(), undefined, OWNER)).toBe('consumed');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('обе развилки в messaging отдают ответ обработчика, а не выбрасывают его', () => {
    const body = codeOnly(read('messaging.ts'));
    expect(body).toContain(
      'return await handleIncomingPollVote(textPayload.text, peerPubKeyB64, ownerPid);'
    );
    expect(body).toContain(
      'return await handleIncomingPollClose(textPayload.text, peerPubKeyB64, ownerPid);'
    );
  });

  it('роль в группе берётся различающим чтением в обоих обработчиках', () => {
    const body = codeOnly(read('pollVoteSync.ts'));
    expect(body.split('await lookupGroupActorRead(env.groupId, senderPubB64, pid);')).toHaveLength(3);
    // Схлопывающей формы, отвечающей «группа незнакомая» на отказ базы, здесь
    // больше нет — её словарь для приёма конвертов не годится.
    expect(body).not.toContain('await lookupGroupActor(');
  });

  it('отказ пометки «завершён» не выдаётся за применённое завершение', () => {
    const body = codeOnly(read('pollVoteSync.ts'));
    expect(body).toContain(
      "if (!(await scopedKvSetCheckedFor(pid, pollClosedKey(env.msgId), '1'))) {"
    );
    // Отказ записи и отсрочка стоят рядом: между ними не должно появиться
    // ни «применено», ни побудки подписчиков.
    expect(body).toContain(
      "    log.warn('poll_close_not_applied', { group: !!env.groupId });\n    return 'deferred';"
    );
  });

  it('снятый с полки голос учитывается по слову, а не по факту возврата', () => {
    const body = codeOnly(read('pollVoteSync.ts'));
    // v4.32.797: у отсрочки появилось второе действие — вернуть голос на полку;
    // счётчик по-прежнему двигает само слово, а не удавшаяся запись.
    expect(body).toMatch(/if \(intake === 'deferred'\) \{\n\s+failed \+= 1;\n\s+repark\(v\);\n\s+\} else applied \+= 1;/);
    expect(body).toMatch(/if \(intake === 'deferred'\) \{\n\s+failed \+= 1;\n\s+repark\(c\);\n\s+\} else applied \+= 1;/);
  });
});
