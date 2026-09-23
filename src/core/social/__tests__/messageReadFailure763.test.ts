/**
 * Занятая база больше не выдаёт себя за чужое или отсутствующее сообщение
 * (v4.32.763).
 *
 * Дефект. Три чтения строки сообщения — `getChatMessageAuthor`,
 * `getChatMessageTarget`, `getGroupMessageTarget` — отвечали `null` и на «такой
 * строки нет», и на «базу не удалось спросить». По этому `null` решается, ЧЬЁ
 * сообщение правит входящий конверт, и вывод из него делался один: «строка не
 * его» либо «сообщения у нас нет». Оба вывода кончаются одинаково — кадр
 * объявляется разобранным, метка «докуда прочитано» перешагивает его, relay
 * отдаёт накопленное только по метке, а повтора у служебного конверта нет.
 *
 * Шесть мест, и в каждом секунда занятой базы стоила действия целиком:
 *
 *   • удаление «у всех» от собеседника: у нас сообщение остаётся навсегда, а
 *     он видит пустое место и уверен, что стёр его у обоих;
 *   • правка текста: у нас навсегда остаётся прежний текст, у него — новый;
 *   • отметка о прочтении: галочка не появится уже никогда, второй отметки по
 *     тому же сообщению собеседник не шлёт;
 *   • живая геолокация: `null` уводил очередную посылку в ветку «строки ещё
 *     нет», и в переписке заводилась ВТОРАЯ живая геолокация того же человека;
 *   • голос в опросе: отказ базы приходил в pollVoteGuard как `missing`, то
 *     есть «голос обогнал свой опрос», и голос ложился на полку — худший из
 *     исходов: сообщение уже в базе, полку разбирать некому, голос умирает по
 *     сроку, но уже молча и с отметкой «конверт разобран»;
 *   • завершение опроса: и в группе, и в личке — опрос остаётся открытым
 *     навсегда, а дальнейшие голоса второй стороной отбрасываются как «в
 *     закрытый опрос».
 *
 * Правка. У всех трёх чтений есть различающая обёртка (`...Read`), отказ базы
 * отвечает `'deferred'` — приёмник даёт кадру вторую попытку, — а «сообщения
 * нет» остаётся тем, чем было: полкой для голоса и молчаливым отказом для
 * остального.
 */

import type { LookupResult } from '../../utils/lookupResult';

type Target = { groupId: string; senderPubB64: string; text: string | null };
type DmTarget = { contactPubB64: string; text: string | null };
type Author = { contactPubB64: string; direction: string };

/** Что ответит чтение строки группового сообщения. */
let mockGroupTarget: LookupResult<Target> = { state: 'missing' };
/** Что ответит чтение строки личного сообщения. */
let mockDmTarget: LookupResult<DmTarget> = { state: 'missing' };
/** Что ответит чтение автора личной строки. */
let mockDmAuthor: LookupResult<Author> = { state: 'missing' };
/** Состав группы: роль отправителя ищется по нему. */
let mockMembers: { peerPubB64: string; role: string }[] = [];
/** Что ответит kv на чтение флага «опрос завершён». */
let mockClosedRead: { value: string | null } | null = { value: null };
/** Легла ли запись флага «завершён». */
let mockKvSetOk = true;
/** Записанные голоса — по ним видно, применён голос или нет. */
const mockVotes: string[] = [];

jest.mock('../../storage/local', () => ({
  setPollVote: jest.fn(async (msgId: string) => {
    mockVotes.push(msgId);
  }),
  deletePollVote: jest.fn(async () => {}),
  getGroupMessageTargetRead: jest.fn(async () => mockGroupTarget),
  getChatMessageTargetRead: jest.fn(async () => mockDmTarget),
  getChatMessageAuthorRead: jest.fn(async () => mockDmAuthor),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  notifyChatStorageChanged: jest.fn(),
}));
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(async () => mockClosedRead),
  scopedKvSetCheckedFor: jest.fn(async () => mockKvSetOk),
}));
jest.mock('../groupActor', () => {
  const roleOf = (members: { peerPubB64: string; role: string }[], pub: string) =>
    members.find((m) => m.peerPubB64 === pub)?.role ?? null;
  return {
    roleOf,
    lookupGroupActorRead: jest.fn(async (_gid: string, actorPub: string) => ({
      group: { id: _gid, type: 'group', adminOnlyPosting: false },
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
import { checkIncomingPollVote } from '../pollVoteGuard';
import {
  encodePollCloseEnvelope,
  encodePollVoteEnvelope,
  handleIncomingPollClose,
  handleIncomingPollVote,
} from '../pollVoteSync';

const PID = 1;
const SENDER = 'S'.repeat(43);
const GID = 'g-763';
const MSG = 'msg-763';

/** Текст опроса собран его же кодировщиком, а не набран от руки. */
const POLL = makePollText('Куда?', ['Лес', 'Море']);

/** Голос в групповом опросе — от участника, права в порядке. */
const groupVote = (): Promise<string> =>
  handleIncomingPollVote(
    encodePollVoteEnvelope({ msgId: MSG, idx: 0, on: true, multi: false, ts: 10, groupId: GID }),
    SENDER,
    PID
  );

/** Голос в личном опросе. */
const dmVote = (): Promise<string> =>
  handleIncomingPollVote(
    encodePollVoteEnvelope({ msgId: MSG, idx: 0, on: true, multi: false, ts: 10 }),
    SENDER,
    PID
  );

const groupClose = (): Promise<string> =>
  handleIncomingPollClose(encodePollCloseEnvelope({ msgId: MSG, ts: 10, groupId: GID }), SENDER, PID);

const dmClose = (): Promise<string> =>
  handleIncomingPollClose(encodePollCloseEnvelope({ msgId: MSG, ts: 10 }), SENDER, PID);

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
  mockGroupTarget = { state: 'found', value: { groupId: GID, senderPubB64: SENDER, text: POLL } };
  mockDmTarget = { state: 'found', value: { contactPubB64: SENDER, text: POLL } };
  mockDmAuthor = { state: 'found', value: { contactPubB64: SENDER, direction: 'in' } };
  mockMembers = [{ peerPubB64: SENDER, role: 'member' }];
  mockClosedRead = { value: null };
  mockKvSetOk = true;
  mockVotes.length = 0;
});

describe('голос: отказ базы — не «опрос ещё не доехал»', () => {
  it('групповой голос при нечитаемой строке откладывается, а не ложится на полку', async () => {
    mockGroupTarget = { state: 'failed' };
    expect(await groupVote()).toBe('deferred');
    expect(mockVotes).toEqual([]);
  });

  it('личный голос — так же', async () => {
    mockDmTarget = { state: 'failed' };
    expect(await dmVote()).toBe('deferred');
    expect(mockVotes).toEqual([]);
  });

  it('база освободилась — тот же голос применяется', async () => {
    mockGroupTarget = { state: 'failed' };
    await groupVote();
    mockGroupTarget = { state: 'found', value: { groupId: GID, senderPubB64: SENDER, text: POLL } };
    expect(await groupVote()).toBe('consumed');
    expect(mockVotes).toEqual([MSG]);
  });

  it('решение принимает сам разборщик прав: у отказа свой код', () => {
    expect(checkIncomingPollVote({ kind: 'failed' }, { idx: 0 }, SENDER)).toEqual({
      ok: false,
      code: 'read_failed',
    });
    // А «сообщения нет» осталось прежним — на нём и держится полка.
    expect(checkIncomingPollVote({ kind: 'missing' }, { idx: 0 }, SENDER)).toEqual({
      ok: false,
      code: 'unknown_message',
    });
  });
});

describe('завершение опроса: отказ базы — не «сообщения нет» и не «не автор»', () => {
  it('групповое завершение при нечитаемой строке откладывается', async () => {
    mockGroupTarget = { state: 'failed' };
    expect(await groupClose()).toBe('deferred');
  });

  it('личное завершение при нечитаемом авторе откладывается', async () => {
    mockDmAuthor = { state: 'failed' };
    expect(await dmClose()).toBe('deferred');
  });

  it('база освободилась — то же завершение применяется', async () => {
    mockDmAuthor = { state: 'failed' };
    await dmClose();
    mockDmAuthor = { state: 'found', value: { contactPubB64: SENDER, direction: 'in' } };
    expect(await dmClose()).toBe('consumed');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Откладывать полагается только то, что пройдёт само. Все остальные отказы —
 * постоянные: вторая попытка их не изменит, а приёмник даёт кадру ровно одну
 * (`internetCoordinator`, `failedOnce`). Откладывать их значит разбирать
 * заведомо мёртвый кадр дважды и засорять журнал отсрочками, за которыми
 * перестанут видеть настоящие. И главное — проверки прав обязаны остаться
 * проверками, а не превратиться в отсрочку.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: постоянные отказы остались постоянными', () => {
  it('сообщения правда нет — голос по-прежнему ложится на полку, кадр разобран', async () => {
    mockGroupTarget = { state: 'missing' };
    expect(await groupVote()).toBe('consumed');
    expect(mockVotes).toEqual([]);
  });

  it('сообщения правда нет — завершение по-прежнему отбрасывается', async () => {
    mockGroupTarget = { state: 'missing' };
    expect(await groupClose()).toBe('consumed');
  });

  it('опрос из другой группы — завершение отбрасывается, а не откладывается', async () => {
    mockGroupTarget = {
      state: 'found',
      value: { groupId: 'g-чужая', senderPubB64: SENDER, text: POLL },
    };
    expect(await groupClose()).toBe('consumed');
  });

  it('личное завершение прислал не автор — отбрасывается', async () => {
    mockDmAuthor = { state: 'found', value: { contactPubB64: SENDER, direction: 'out' } };
    expect(await dmClose()).toBe('consumed');
  });

  it('голос в чужую переписку отбрасывается', async () => {
    mockDmTarget = { state: 'found', value: { contactPubB64: 'X'.repeat(43), text: POLL } };
    expect(await dmVote()).toBe('consumed');
    expect(mockVotes).toEqual([]);
  });

  it('своя копия опроса не открылась — это не отказ базы и не отсрочка', async () => {
    mockGroupTarget = { state: 'found', value: { groupId: GID, senderPubB64: SENDER, text: null } };
    expect(await groupVote()).toBe('consumed');
    expect(mockVotes).toEqual([]);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Сплющивающие обёртки никуда не делись — они нужны там, где `null` и правда
 * ответ. Проверяем, что на путях, где по строке решается судьба конверта, их
 * больше нет: вернуть их значит вернуть все шесть последствий разом.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('личные конверты читают автора различающей обёрткой', () => {
    const body = codeOnly(read('core/social/messaging.ts'));
    expect(body.split('getChatMessageAuthorRead(').length - 1).toBe(4);
    // Удаление, правка, отметка о прочтении и живая геолокация — каждое
    // отвечает отсрочкой на отказ базы.
    expect(body).toContain("log.warn('delete_payload_author_unreadable'");
    expect(body).toContain("log.warn('edit_payload_author_unreadable'");
    expect(body).toContain("log.warn('read_receipts_author_unreadable'");
    expect(body).toContain("log.warn('liveloc_author_unreadable'");
    expect(body.split("return 'deferred';").length - 1).toBeGreaterThanOrEqual(4);
  });

  it('сплющенных чтений в личке не осталось ни одного', () => {
    const body = codeOnly(read('core/social/messaging.ts'));
    // v4.32.763 оставляла здесь одно: счётчик непрочитанного спрашивал базу ДО
    // записи, и отказ выбирал меньший из двух перекосов. v4.32.767 сняла и его —
    // на тот же вопрос точно отвечает сама запись (`INSERT OR IGNORE`).
    expect(body).not.toContain('await getChatMessageAuthor(');
    expect(body).toContain("const alreadyStored = stored === 'duplicate';");
  });

  it('опрос читает строку сообщения различающими обёртками', () => {
    const body = codeOnly(read('core/social/pollVoteSync.ts'));
    expect(body).toContain('await getGroupMessageTargetRead(');
    expect(body).toContain('await getChatMessageTargetRead(');
    expect(body).toContain('await getChatMessageAuthorRead(');
    expect(body).not.toContain('await getGroupMessageTarget(');
    expect(body).not.toContain('await getChatMessageTarget(');
    expect(body).not.toContain('await getChatMessageAuthor(');
    expect(body).toContain("return target.code === 'read_failed' ? 'deferred' : 'consumed';");
  });

  it('полка по-прежнему разбирается только по «сообщения нет»', () => {
    const body = codeOnly(read('core/social/pollVotePending.ts'));
    expect(body).toContain("return code === 'unknown_message';");
    expect(body).not.toContain('read_failed');
  });

  it('обе обёртки живут в хранилище и отличают три исхода', () => {
    const body = codeOnly(read('core/storage/local.ts'));
    for (const fn of [
      'getGroupMessageTargetRead',
      'getChatMessageTargetRead',
      'getChatMessageAuthorRead',
    ]) {
      const at = body.indexOf(`export async function ${fn}(`);
      expect(at).toBeGreaterThan(-1);
      const tail = body.slice(at, body.indexOf('\n}', at));
      expect(tail).toContain('missingResult()');
      expect(tail).toContain('failedResult()');
    }
    // Прежние имена остались — но как однострочные оболочки над теми же
    // чтениями, а не как вторая копия запроса.
    expect(body).toContain('return lookupValue(await getChatMessageAuthorRead(id, ownerProfileId));');
  });
});
