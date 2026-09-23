/**
 * Занятая база больше не стирает чужую реакцию навсегда (v4.32.754).
 *
 * Дефект. `handleIncomingReaction` возвращала `true` в любом исходе — и
 * применив реакцию, и уронив её. Ветка в `messaging.ts` этот ответ не читала
 * вовсе: `await handleIncomingReaction(...)` и сразу `return 'consumed'`.
 * «Разобрано» значит «метку докуда прочитано можно двигать», а relay отдаёт
 * накопленное только по метке. Значит любая секунда занятой базы стоила
 * реакции насовсем: кадр лежит на relay ещё тридцать суток, но его больше
 * никогда не запросят, а повтора у служебного конверта нет. Собеседник видит
 * реакцию у себя и уверен, что она стоит у обоих.
 *
 * Два входа в эту беду. Первый — `toggleReaction` с причиной `'failed'`: сам
 * запрос упал. Второй — групповая реакция: роль отправителя бралась через
 * `lookupGroupActor`, а он схлопывает отказ базы в «группа незнакомая», и
 * реакция участника отбрасывалась ровно потому, что в эту секунду базу читал
 * кто-то ещё.
 *
 * Правка. Обработчик отвечает словом `EnvelopeIntake`, развилка в `messaging`
 * отдаёт его наверх, состав читается различающим `lookupGroupActorRead`.
 * Откладывается ровно то, что пройдёт само. «Сообщения нет», «столбец не
 * открылся» и оба потолка реакций постоянны: держать на них метку значило бы
 * остановить приём всего остального навсегда — это была бы беда крупнее той,
 * что лечим.
 */
import type { LookupResult } from '../../utils/lookupResult';

type FakeMember = { peerPubB64: string; role: string };
type FailReason = 'missing' | 'unreadable' | 'limit' | 'ownLimit' | 'failed';

/** Что ответит запись реакции: `null` — записалось, иначе названная причина. */
let mockWriteFail: FailReason | null = null;
/** Строка группы: 'failed' — база не ответила, 'missing' — такой группы нет. */
let mockGroupRead: LookupResult<{ id: string }> = { state: 'missing' };
/** Состав группы. `null` — состав не прочитался, как у listGroupMembersRead. */
let mockMembers: FakeMember[] | null = [];

jest.mock('../../storage/local', () => ({
  toggleReaction: jest.fn(async () =>
    mockWriteFail ? { ok: false, reason: mockWriteFail } : { ok: true, on: true }
  ),
  getGroup: jest.fn(async () => (mockGroupRead.state === 'found' ? mockGroupRead.value : null)),
  getGroupRead: jest.fn(async () => mockGroupRead),
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
}));
// Приём конверта в сеть не ходит; воронка подменена, чтобы не тянуть службу
// переписки со всем её деревом зависимостей.
jest.mock('../controlFanout', () => ({
  activeRecipients: () => [],
  fanoutControlEnvelope: jest.fn(async () => ({ sent: true, recipients: 0 })),
  undeliveredText: () => null,
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveIdentity: () => ({ pid: 1, myPubB64: 'me' }) },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { encodeReactionEnvelope, handleIncomingReaction } from '../reactionSync';

const OWNER = 1;
const SENDER = 'S'.repeat(43);
const GID = 'g-754';

/** Конверт реакции — личный, если группу не назвали. */
function envelope(groupId?: string): string {
  return encodeReactionEnvelope({
    msgId: 'm-1',
    emoji: '👍',
    on: true,
    ts: 1000,
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

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

beforeEach(() => {
  mockWriteFail = null;
  mockGroupRead = { state: 'found', value: { id: GID } };
  mockMembers = [{ peerPubB64: SENDER, role: 'member' }];
});

describe('причина уйдёт сама — кадр откладываем', () => {
  it('запрос к базе упал: реакция будет перезапрошена, а не потеряна', async () => {
    mockWriteFail = 'failed';

    expect(await handleIncomingReaction(envelope(), SENDER, OWNER)).toBe('deferred');
  });

  it('строка группы не прочиталась: это не «группа незнакомая»', async () => {
    mockGroupRead = { state: 'failed' };

    expect(await handleIncomingReaction(envelope(GID), SENDER, OWNER)).toBe('deferred');
  });

  it('состав группы не прочитался: проверять роль нечем', async () => {
    mockMembers = null;

    expect(await handleIncomingReaction(envelope(GID), SENDER, OWNER)).toBe('deferred');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ — здесь она стережёт не прежний код, а перестраховку.
 *
 * Прежний код заваливает весь набор целиком: тип ответа сменился, и `.toBe`
 * не совпадёт ни в одной строке. Доказательство такое ничего не стоит. Сторож
 * нужен с другой стороны: заменить разбор причин на голое `return 'deferred'`
 * — правка в одну строку, она чинит ровно тот же дефект и выглядит надёжнее.
 * Цена у неё, однако, больше исходной: на «сообщения нет» метка встанет
 * навсегда и приём ВСЕГО остального остановится. Пять проверок ниже падают
 * именно на такой версии.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: постоянная причина держать метку не должна', () => {
  it('реакция применилась — разобрано', async () => {
    expect(await handleIncomingReaction(envelope(), SENDER, OWNER)).toBe('consumed');
  });

  it.each<FailReason>(['missing', 'unreadable', 'limit', 'ownLimit'])(
    'причина %s повтором не лечится — разобрано',
    async (reason) => {
      mockWriteFail = reason;

      expect(await handleIncomingReaction(envelope(), SENDER, OWNER)).toBe('consumed');
    }
  );

  it('группы у нас правда нет — это обычный мусор из сети', async () => {
    mockGroupRead = { state: 'missing' };

    expect(await handleIncomingReaction(envelope(GID), SENDER, OWNER)).toBe('consumed');
  });

  it('отправитель не участник — отбрасываем насовсем, метку не держим', async () => {
    mockMembers = [{ peerPubB64: 'кто-то другой', role: 'member' }];

    expect(await handleIncomingReaction(envelope(GID), SENDER, OWNER)).toBe('consumed');
  });

  it('участник в бане — тоже насовсем', async () => {
    mockMembers = [{ peerPubB64: SENDER, role: 'banned' }];

    expect(await handleIncomingReaction(envelope(GID), SENDER, OWNER)).toBe('consumed');
  });

  it('не тот префикс и мусор вместо конверта — годными они не станут', async () => {
    expect(await handleIncomingReaction('просто текст', SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingReaction('rx:{нет', SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingReaction(envelope(), undefined, OWNER)).toBe('consumed');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('развилка в messaging отдаёт ответ обработчика, а не выбрасывает его', () => {
    const body = codeOnly(read('messaging.ts'));
    expect(body).toContain(
      'return await handleIncomingReaction(textPayload.text, peerPubKeyB64, ownerPid);'
    );
  });

  it('роль в группе берётся различающим чтением', () => {
    const body = codeOnly(read('reactionSync.ts'));
    expect(body).toContain('const actor = await lookupGroupActorRead(env.groupId, senderPubB64, pid);');
    expect(body).toContain("return 'deferred';");
    // Схлопывающее чтение осталось только у своей отправки: там список участников
    // всё равно нужен целиком, и решение по нему принимает сам отправитель.
    expect(body).not.toContain('await lookupGroupActor(env.groupId');
  });

  it('откладывается ровно одна причина записи из пяти', () => {
    const body = codeOnly(read('reactionSync.ts'));
    expect(body).toContain("return res.reason === 'failed' ? 'deferred' : 'consumed';");
    // Словарь причин по-прежнему живёт в reactionWrite, а не заведён тут заново.
    expect(codeOnly(read('reactionWrite.ts'))).toContain(
      "export type ReactionWriteFailure = 'missing' | 'unreadable' | 'limit' | 'ownLimit' | 'failed';"
    );
  });
});
