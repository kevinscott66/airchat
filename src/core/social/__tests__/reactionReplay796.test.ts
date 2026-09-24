/**
 * Сохранённый кадр больше не возвращает снятую реакцию (v4.32.796).
 *
 * Дефект. Последнее скалярное состояние, оставшееся без водяного знака.
 * Оговорка у {@link ControlKind} числила реакции «не скалярными вовсе» — а
 * они скалярны, просто не на пару собеседников, а на тройку «автор +
 * сообщение + эмодзи»: `toggleReaction` получает из кадра не «переключи», а
 * готовое положение `on`. Проверки свежести перед записью не было никакой.
 *
 * Цена. Тема relay выводится из открытых DID, конверт живёт тридцать суток,
 * повтора у служебного конверта нет — значит перехваченный кадр можно подать
 * снова, и он вернёт под сообщение снятую реакцию или уберёт поставленную,
 * столько раз, сколько его подадут. Видно это только жертве: у всех остальных
 * получателей под тем же сообщением своя, верная картина, поэтому ни автор
 * реакции, ни кто-либо ещё расхождения не заметит. В группе к этому добавляется
 * подпись «кто поставил» — чужое имя под реакцией, которую человек снял.
 *
 * Правка. Ячейка на тройку: реакций у одного человека под одним сообщением
 * несколько, сообщений много, порядка между ними relay не держит, и общий знак
 * на собеседника выбросил бы законное «👍 на B», пришедшее следом за более
 * поздним «❤️ на A». Проверка до записи, сдвиг после: обе причины отложить
 * кадр (состав группы не прочитался, запрос упал) проходят сами, и знак не
 * должен хоронить перезапрос, ради которого сказано `deferred` (v4.32.754).
 */
import type { LookupResult } from '../../utils/lookupResult';

type FakeMember = { peerPubB64: string; role: string };

/** Что ответит запись реакции: null — записалось, иначе названная причина. */
let mockWriteFail: 'failed' | 'missing' | null = null;
let mockGroupRead: LookupResult<{ id: string }> = { state: 'missing' };
let mockMembers: FakeMember[] | null = [];

/** Кто и чем отметил сообщение: msgId → автор → набор эмодзи. */
const mockMarks = new Map<string, Map<string, Set<string>>>();
/** Настоящая ячейка kv: водяной знак обязан её переживать. */
const mockKv = new Map<string, string>();

jest.mock('../../storage/local', () => ({
  // Копия настоящей семантики: положение приходит из кадра, а не считается
  // здесь. Именно поэтому повтор кадра и переключал реакцию.
  toggleReaction: jest.fn(
    async (msgId: string, emoji: string, actor: string, on: boolean) => {
      if (mockWriteFail) return { ok: false, reason: mockWriteFail };
      const perMsg = mockMarks.get(msgId) ?? new Map<string, Set<string>>();
      const set = perMsg.get(actor) ?? new Set<string>();
      if (on) set.add(emoji);
      else set.delete(emoji);
      perMsg.set(actor, set);
      mockMarks.set(msgId, perMsg);
      return { ok: true, on };
    },
  ),
  getGroup: jest.fn(async () => (mockGroupRead.state === 'found' ? mockGroupRead.value : null)),
  getGroupRead: jest.fn(async () => mockGroupRead),
  listGroupMembers: jest.fn(async () => mockMembers ?? []),
  listGroupMembersRead: jest.fn(async () => mockMembers),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvListKeysByPrefix: jest.fn(async () => []),
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

import { reactionWatermarkKey, resetControlTsMirrorForTests } from '../controlWatermark';
import { encodeReactionEnvelope, handleIncomingReaction } from '../reactionSync';

const OWNER = 1;
const SENDER = 'S'.repeat(43);
const OTHER = 'O'.repeat(43);
const GID = 'g-796';
const MSG = 'm-796';
const TS = 1_700_000_000_000;

/** Конверт реакции — личный, если группу не назвали. */
function react(
  opts: { emoji?: string; on?: boolean; ts?: number; msgId?: string; groupId?: string } = {},
): string {
  return encodeReactionEnvelope({
    msgId: opts.msgId ?? MSG,
    emoji: opts.emoji ?? '👍',
    on: opts.on ?? true,
    ts: opts.ts ?? TS,
    ...(opts.groupId ? { groupId: opts.groupId } : {}),
  });
}

/** Что сейчас стоит под сообщением от названного автора. */
function marks(actor = SENDER, msgId = MSG): string[] {
  return [...(mockMarks.get(msgId)?.get(actor) ?? new Set<string>())].sort();
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
  // Зеркало знака живёт на уровне модуля и уборку базы переживает (v4.32.791).
  resetControlTsMirrorForTests();
  mockWriteFail = null;
  mockGroupRead = { state: 'missing' };
  mockMembers = [];
  mockMarks.clear();
  mockKv.clear();
  jest.clearAllMocks();
});

describe('перехваченный кадр больше не переключает реакцию', () => {
  it('тот же кадр, поданный второй раз, не применяется', async () => {
    expect(await handleIncomingReaction(react(), SENDER, OWNER)).toBe('consumed');
    expect(marks()).toEqual(['👍']);

    // Автор снял реакцию — законно и позже.
    expect(await handleIncomingReaction(react({ on: false, ts: TS + 1000 }), SENDER, OWNER))
      .toBe('consumed');
    expect(marks()).toEqual([]);

    // А вот тот самый первый кадр, сохранённый и поданный снова.
    expect(await handleIncomingReaction(react(), SENDER, OWNER)).toBe('consumed');
    expect(marks()).toEqual([]);
  });

  it('сохранённое «снять» не убирает нынешнюю реакцию', async () => {
    await handleIncomingReaction(react({ on: false }), SENDER, OWNER);
    await handleIncomingReaction(react({ on: true, ts: TS + 1000 }), SENDER, OWNER);
    expect(marks()).toEqual(['👍']);

    expect(await handleIncomingReaction(react({ on: false }), SENDER, OWNER)).toBe('consumed');
    expect(marks()).toEqual(['👍']);
  });

  it('повтор не доходит до записи вовсе', async () => {
    const { toggleReaction } = jest.requireMock('../../storage/local') as {
      toggleReaction: jest.Mock;
    };
    await handleIncomingReaction(react(), SENDER, OWNER);
    toggleReaction.mockClear();
    await handleIncomingReaction(react(), SENDER, OWNER);
    expect(toggleReaction).not.toHaveBeenCalled();
  });

  it('в группе тоже: подпись «кто поставил» не вернётся повтором', async () => {
    mockGroupRead = { state: 'found', value: { id: GID } };
    mockMembers = [{ peerPubB64: SENDER, role: 'member' }];

    expect(await handleIncomingReaction(react({ groupId: GID }), SENDER, OWNER)).toBe('consumed');
    await handleIncomingReaction(react({ groupId: GID, on: false, ts: TS + 1 }), SENDER, OWNER);
    expect(marks()).toEqual([]);

    expect(await handleIncomingReaction(react({ groupId: GID }), SENDER, OWNER)).toBe('consumed');
    expect(marks()).toEqual([]);
  });
});

describe('ячейка узкая: законное не выбрасывается', () => {
  it('у каждого эмодзи своя отметка', async () => {
    await handleIncomingReaction(react({ emoji: '❤️', ts: TS + 5000 }), SENDER, OWNER);
    // Кадр про ДРУГОЙ эмодзи с меньшей меткой — законный: relay отдаёт
    // накопленное пачкой, порядка между реакциями нет.
    expect(await handleIncomingReaction(react({ emoji: '👍', ts: TS }), SENDER, OWNER))
      .toBe('consumed');
    expect(marks()).toEqual(['❤️', '👍'].sort());
  });

  it('у каждого сообщения своя отметка', async () => {
    await handleIncomingReaction(react({ msgId: 'm-A', ts: TS + 5000 }), SENDER, OWNER);
    expect(await handleIncomingReaction(react({ msgId: 'm-B', ts: TS }), SENDER, OWNER))
      .toBe('consumed');
    expect(marks(SENDER, 'm-B')).toEqual(['👍']);
  });

  it('у каждого автора своя отметка', async () => {
    await handleIncomingReaction(react({ ts: TS + 5000 }), SENDER, OWNER);
    expect(await handleIncomingReaction(react({ ts: TS }), OTHER, OWNER)).toBe('consumed');
    expect(marks(OTHER)).toEqual(['👍']);
    expect(reactionWatermarkKey(SENDER, '👍', MSG)).not.toBe(
      reactionWatermarkKey(OTHER, '👍', MSG),
    );
  });

  it('подобрать чужую ячейку нечем: неограниченная часть в имени одна', () => {
    // Отправитель управляет эмодзи и идентификатором сообщения. Эмодзи кодек
    // держит в эмодзи-диапазонах, двоеточия (U+003A) среди них нет; значит
    // хвост имени принадлежит идентификатору целиком, сколько бы двоеточий в
    // него ни вписали.
    expect(reactionWatermarkKey(SENDER, '👍', 'a:b')).not.toBe(
      reactionWatermarkKey(SENDER, '👍', 'a'),
    );
    expect(reactionWatermarkKey(SENDER, '👍', 'a:b')).not.toBe(
      reactionWatermarkKey(SENDER, '👍', 'b'),
    );
  });

  it('двоеточие в конверт эмодзи не протащить', async () => {
    const bad = encodeReactionEnvelope({ msgId: MSG, emoji: ':', on: true, ts: TS });
    // Кодек такой конверт не признаёт вовсе — разделитель в имя не попадёт.
    expect(await handleIncomingReaction(bad, SENDER, OWNER)).toBe('consumed');
    expect(marks()).toEqual([]);
  });
});

describe('знак не хоронит перезапрос (v4.32.754 цел)', () => {
  it('запрос упал — кадр отложен, знак не поставлен', async () => {
    mockWriteFail = 'failed';
    expect(await handleIncomingReaction(react(), SENDER, OWNER)).toBe('deferred');

    mockWriteFail = null;
    expect(await handleIncomingReaction(react(), SENDER, OWNER)).toBe('consumed');
    expect(marks()).toEqual(['👍']);
  });

  it('состав группы не прочитался — кадр отложен, знак не поставлен', async () => {
    mockGroupRead = { state: 'found', value: { id: GID } };
    mockMembers = null;
    expect(await handleIncomingReaction(react({ groupId: GID }), SENDER, OWNER)).toBe('deferred');

    mockMembers = [{ peerPubB64: SENDER, role: 'member' }];
    expect(await handleIncomingReaction(react({ groupId: GID }), SENDER, OWNER)).toBe('consumed');
    expect(marks()).toEqual(['👍']);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная работа не задета', () => {
  it('реакция применяется', async () => {
    expect(await handleIncomingReaction(react(), SENDER, OWNER)).toBe('consumed');
    expect(marks()).toEqual(['👍']);
  });

  it('поток честных кадров проходит целиком', async () => {
    expect(await handleIncomingReaction(react({ ts: TS }), SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingReaction(react({ ts: TS + 1, on: false }), SENDER, OWNER))
      .toBe('consumed');
    expect(await handleIncomingReaction(react({ ts: TS + 2, on: true }), SENDER, OWNER))
      .toBe('consumed');
    expect(marks()).toEqual(['👍']);
  });

  it('мусор и конверт без отправителя годными не станут', async () => {
    expect(await handleIncomingReaction('просто текст', SENDER, OWNER)).toBe('consumed');
    expect(await handleIncomingReaction(react(), undefined, OWNER)).toBe('consumed');
    expect(marks()).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('положение берётся из кадра — потому повтор его и переключает', () => {
    const body = codeOnly(read('reactionSync.ts'));
    expect(body).toContain('toggleReaction(env.msgId, env.emoji, senderPubB64, env.on, scope)');
    // Хранилище умеет и «переключи», и готовое значение; приём шлёт второе.
    expect(codeOnly(read('..', 'storage', 'local.ts'))).toContain("on: boolean | 'toggle',");
  });

  it('конверт живёт достаточно долго, чтобы повтор был не теорией', () => {
    expect(codeOnly(read('messaging.ts'))).toContain(
      'const ENVELOPE_MAX_AGE_MS = RELAY_RETENTION_MS;',
    );
    expect(codeOnly(read('..', 'transport', 'retentionWindow.ts'))).toContain(
      'export const RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;',
    );
  });

});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('автор ячейки берётся из подписанного отправителя, а не из поля конверта', () => {
    expect(codeOnly(read('reactionSync.ts'))).toContain(
      'reactionTsFresh(senderPubB64, env.emoji, env.msgId, pid, env.ts)',
    );
  });

  it('знак ставится после удавшейся записи, а не вместо неё', () => {
    const body = codeOnly(read('reactionSync.ts'));
    const fresh = body.indexOf('reactionTsFresh(');
    const write = body.indexOf('await toggleReaction(env.msgId');
    const commit = body.indexOf('commitReactionTs(');
    expect(fresh).toBeGreaterThan(-1);
    expect(fresh).toBeLessThan(write);
    expect(commit).toBeGreaterThan(write);
    // Между записью и сдвигом стоит разбор причин отказа: отложенный кадр
    // знака не получает.
    expect(commit).toBeGreaterThan(body.indexOf("return res.reason === 'failed'"));
  });

  it('оговорка про реакции у ControlKind закрыта, а не переписана мимо дела', () => {
    const body = read('controlWatermark.ts');
    expect(body).toContain('reactionWatermarkKey');
    expect(body).not.toContain('остаются реакции');
  });
});
