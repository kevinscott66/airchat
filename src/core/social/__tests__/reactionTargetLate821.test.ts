/**
 * Реакция, обогнавшая своё сообщение, больше не теряется (v4.32.821).
 *
 * Дефект. Запись реакции отвечает `missing`, когда строки сообщения в базе
 * нет, и приём считал это постоянным отказом наравне с потолками: кадр
 * разобран, метка «докуда прочитано» идёт дальше, повтора у служебного
 * конверта нет. Но `missing` — это ещё и гонка. Кадры пачки разбираются
 * параллельно (транспорт зовёт `onFrame` на каждое сообщение WS, не дожидаясь
 * предыдущего), так что реакция успевает дойти до SELECT раньше, чем рядом
 * допишется само сообщение.
 *
 * Цена. Чаще всего это случается там, где люди и замечают пропажу: человек был
 * offline, relay при подключении отдаёт и сообщение, и реакцию на него одной
 * пачкой. Реакция исчезала навсегда, а собеседник видел её у себя и был
 * уверен, что она стоит у обоих.
 *
 * Правка. `missing` откладывает кадр, как и упавший запрос. Ждать недолго:
 * приёмник даёт кадру ровно вторую попытку и после неё отпускает метку сам
 * (`internetCoordinator`, `failedOnce`), так что реакция на сообщение, которого
 * у нас не будет никогда, стоит одного повторного разбора.
 */
import type { LookupResult } from '../../utils/lookupResult';

type FailReason = 'missing' | 'unreadable' | 'limit' | 'ownLimit' | 'failed';

/** Что ответит запись реакции: `null` — записалось, иначе названная причина. */
let mockWriteFail: FailReason | null = null;
/** Сколько раз пытались записать. */
let mockWrites = 0;
/** Строка группы. */
let mockGroupRead: LookupResult<{ id: string }> = { state: 'missing' };
/** Состав группы. */
let mockMembers: { peerPubB64: string; role: string }[] | null = [];
/** Ячейки водяного знака: ключ → значение. */
let mockKv: Record<string, string> = {};

jest.mock('../../storage/local', () => ({
  toggleReaction: jest.fn(async () => {
    mockWrites += 1;
    return mockWriteFail ? { ok: false, reason: mockWriteFail } : { ok: true, on: true };
  }),
  getGroup: jest.fn(async () => (mockGroupRead.state === 'found' ? mockGroupRead.value : null)),
  getGroupRead: jest.fn(async () => mockGroupRead),
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv[k] ?? null })),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    mockKv[k] = v;
    return true;
  }),
  kvSet: jest.fn(async (k: string, v: string) => {
    mockKv[k] = v;
  }),
  kvDelete: jest.fn(async (k: string) => {
    delete mockKv[k];
  }),
}));
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

import { resetControlTsMirrorForTests } from '../controlWatermark';
import { encodeReactionEnvelope, handleIncomingReaction } from '../reactionSync';

const OWNER = 1;
const SENDER = 'S'.repeat(43);
const GID = 'g-821';

function envelope(groupId?: string, ts = 1000): string {
  return encodeReactionEnvelope({
    msgId: 'm-1',
    emoji: '👍',
    on: true,
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

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

beforeEach(() => {
  mockWriteFail = null;
  mockWrites = 0;
  mockGroupRead = { state: 'found', value: { id: GID } };
  mockMembers = [{ peerPubB64: SENDER, role: 'member' }];
  mockKv = {};
  // Зеркало водяных знаков живёт на уровне модуля: применённое одной проверкой
  // иначе судило бы конверты следующей — msgId и ts у них общие.
  resetControlTsMirrorForTests();
});

describe('сообщение ещё не записалось — кадр ждёт его, а не выбрасывается', () => {
  it('личная реакция без своего сообщения: отложено', async () => {
    mockWriteFail = 'missing';

    expect(await handleIncomingReaction(envelope(), SENDER, OWNER)).toBe('deferred');
  });

  it('групповая — так же', async () => {
    mockWriteFail = 'missing';

    expect(await handleIncomingReaction(envelope(GID), SENDER, OWNER)).toBe('deferred');
  });

  it('сообщение дописалось — тот же кадр применяется со второго раза', async () => {
    const env = envelope();
    mockWriteFail = 'missing';
    expect(await handleIncomingReaction(env, SENDER, OWNER)).toBe('deferred');

    mockWriteFail = null;
    expect(await handleIncomingReaction(env, SENDER, OWNER)).toBe('consumed');
    expect(mockWrites).toBe(2);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Починить это можно и голым `return 'deferred'` на любой отказ записи —
 * правка в одну строку, и она выглядит надёжнее. Метку такая версия не
 * заклинит: приёмник даёт кадру вторую попытку и отпускает сам. Но каждый
 * заведомо мёртвый кадр она разбирает дважды и кладёт в журнал
 * `internet_frame_deferred_again` — строку, по которой ищут настоящие
 * отсрочки. Слово `deferred` стоит ровно столько, сколько значит.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: постоянные причины остаются постоянными', () => {
  it.each<FailReason>(['unreadable', 'limit', 'ownLimit'])(
    'причина %s повтором не лечится — разобрано',
    async (reason) => {
      mockWriteFail = reason;

      expect(await handleIncomingReaction(envelope(), SENDER, OWNER)).toBe('consumed');
    }
  );

  it('реакция применилась — разобрано, и вторая попытка не нужна', async () => {
    expect(await handleIncomingReaction(envelope(), SENDER, OWNER)).toBe('consumed');
    expect(mockWrites).toBe(1);
  });

  it('отправитель не участник — до записи дело не доходит вовсе', async () => {
    mockWriteFail = 'missing';
    mockMembers = [{ peerPubB64: 'кто-то другой', role: 'member' }];

    expect(await handleIncomingReaction(envelope(GID), SENDER, OWNER)).toBe('consumed');
    expect(mockWrites).toBe(0);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Отсрочка стоит чего-то лишь при условии, что второй разбор того же кадра
 * действительно пробует записать снова. Водяной знак реакции ставится ДО
 * записи (v4.32.796) — если бы он двигался на отложенном кадре, повтор
 * отсекался бы как несвежий, и отсрочка была бы пустым словом.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: отложенный кадр не съедает свой водяной знак', () => {
  it('после отсрочки тот же ts по-прежнему свежий', async () => {
    const env = envelope(undefined, 5000);
    mockWriteFail = 'missing';
    await handleIncomingReaction(env, SENDER, OWNER);

    mockWriteFail = null;
    await handleIncomingReaction(env, SENDER, OWNER);
    expect(mockWrites).toBe(2);
  });

  it('а применённый — съедает: повтор того же кадра до базы не доходит', async () => {
    const env = envelope(undefined, 5000);
    expect(await handleIncomingReaction(env, SENDER, OWNER)).toBe('consumed');

    expect(await handleIncomingReaction(env, SENDER, OWNER)).toBe('consumed');
    expect(mockWrites).toBe(1);
  });
});

describe('форма исходников: «нет строки» названо проходящим', () => {
  it('приём откладывает обе проходящие причины', () => {
    const body = codeOnly(read('reactionSync.ts'));
    expect(body).toContain(
      "return res.reason === 'failed' || res.reason === 'missing' ? 'deferred' : 'consumed';"
    );
  });

  it('словарь причин по-прежнему один и живёт в reactionWrite', () => {
    expect(codeOnly(read('reactionWrite.ts'))).toContain(
      "export type ReactionWriteFailure = 'missing' | 'unreadable' | 'limit' | 'ownLimit' | 'failed';"
    );
  });
});
