/**
 * Занятая секунда на выкладке с полки больше не стоит голоса (v4.32.797).
 *
 * Дефект. `take()` снимает конверты с полки безвозвратно, а `canPark = false`
 * не даёт им лечь обратно — так и задумано для причины «сообщения нет»: опрос
 * пришёл, второй раз ждать нечего. Но `applyIncoming*` отвечает и «сейчас не
 * смогли»: база занята, состав группы не прочитался, kv не ответил. Это слово
 * выкладка складывала в счётчик `failed` и на том заканчивала.
 *
 * Цена. Перезапросить такой кадр нельзя ничем. Он разобран давно — ещё когда
 * ложился на полку, — и метка «докуда прочитано» у ретранслятора его прошла.
 * Позвать выкладку заново тоже некому: зовут её приёмники сообщения-опроса, а
 * второй раз то же сообщение они не запишут (`duplicate` уходит раньше). То
 * есть отсрочка ровно в этот миг означала молчаливую потерю: у голоса —
 * разошедшиеся навсегда счётчики, у завершения — опрос, который у получателя
 * останется открытым до конца времён.
 *
 * Правка. Отложенный конверт возвращается на полку (срок ему идёт от первой
 * укладки, а не от возврата), и выкладка назначает себе повтор — три попытки с
 * растущей паузой. Постоянные отказы не возвращаются и повтора не просят:
 * иначе полка крутила бы заведомо негодный конверт до самого срока.
 */
import type { LookupResult } from '../../utils/lookupResult';

type Target = LookupResult<{ contactPubB64: string; text: string | null }>;
type Author = LookupResult<{ direction: 'in' | 'out'; contactPubB64: string }>;

/** Что отвечает база на запрос самого опроса. */
let mockTarget: Target = { state: 'missing' };
/** Что отвечает база на запрос автора опроса (нужен завершению в личке). */
let mockAuthor: Author = { state: 'missing' };
/** Записанные голоса: msgId|автор|вариант. */
const mockVotes: string[] = [];
/** Ключи kv, записанные успешно. */
const mockKvWrites: string[] = [];

jest.mock('../../storage/local', () => ({
  setPollVote: jest.fn(async (msgId: string, actor: string, idx: number) => {
    mockVotes.push(`${msgId}|${actor}|${idx}`);
  }),
  deletePollVote: jest.fn(async () => {}),
  notifyChatStorageChanged: jest.fn(),
  getChatMessageTargetRead: jest.fn(async () => mockTarget),
  getChatMessageAuthorRead: jest.fn(async () => mockAuthor),
  getGroupMessageTargetRead: jest.fn(async () => ({ state: 'missing' })),
  listGroupMembersRead: jest.fn(async () => []),
}));
jest.mock('../../storage/profileScopedKv', () => ({
  // Пусто и записывается: предмет набора — судьба конверта, а не kv. Водяной
  // знак (v4.32.794) на пустой ячейке пропускает всё.
  scopedKvTryGetFor: jest.fn(async () => ({ value: null })),
  scopedKvSetCheckedFor: jest.fn(async (_pid: number, key: string) => {
    mockKvWrites.push(key);
    return true;
  }),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: () => [],
  fanoutControlEnvelope: jest.fn(async () => ({ sent: true, recipients: 0 })),
  undeliveredText: () => null,
}));
jest.mock('../groupActor', () => ({
  lookupGroupActorRead: jest.fn(async () => null),
  roleOf: () => 'none',
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1 }),
    getActiveIdentity: () => ({ pid: 1, myPubB64: 'me' }),
  },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { resetControlTsMirrorForTests } from '../controlWatermark';
import { makePollText } from '../pollEnvelope';
import {
  encodePollCloseEnvelope,
  encodePollVoteEnvelope,
  flushPendingPollCloses,
  flushPendingPollEnvelopes,
  flushPendingPollVotes,
  handleIncomingPollClose,
  handleIncomingPollVote,
  resetPollFlushRetriesForTests,
} from '../pollVoteSync';

const PID = 1;
const SENDER = 'S'.repeat(43);
const MSG = 'm-797';
const POLL = makePollText('Пойдём?', ['Да', 'Нет']);

const mockLog = (jest.requireMock('../../logger') as { log: { warn: jest.Mock; info: jest.Mock } })
  .log;

/** Голос в личном опросе от собеседника. */
function vote(idx = 0): string {
  return encodePollVoteEnvelope({ msgId: MSG, idx, on: true, multi: false, ts: 1000 });
}

/** Завершение личного опроса от его автора. */
function close(): string {
  return encodePollCloseEnvelope({ msgId: MSG, ts: 1000 });
}

/** База отвечает как полагается: опрос лежит в переписке с отправителем. */
function dbHealthy(): void {
  mockTarget = { state: 'found', value: { contactPubB64: SENDER, text: POLL } };
  mockAuthor = { state: 'found', value: { direction: 'in', contactPubB64: SENDER } };
}

/** База занята: оба чтения отвечают отказом, а не «ничего нет». */
function dbBusy(): void {
  mockTarget = { state: 'failed' };
  mockAuthor = { state: 'failed' };
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
  // Уборки в `afterEach` мало: таймер повтора зовёт выкладку и не ждёт её, так
  // что назначить следующий повтор та успевает уже после уборки.
  resetPollFlushRetriesForTests();
  // А это — причина редких красных прогонов, пойманная с поличным. Отложенный
  // голос уносит с собой метку времени своей укладки, и знак свежести
  // (`controlWatermark`) держит принятые метки в зеркале уровня модуля —
  // одном на весь файл. Проверки здесь укладывают голоса по одному и тому же
  // сообщению и от одного отправителя, а идут они быстрее, чем тикает
  // `Date.now()`. Стоит двум уложиться в одну миллисекунду — и метка
  // следующей равна запомненной, `ts <= prev` срабатывает, повтор выбрасывает
  // голос как перехваченный кадр (`control_ts_replay_rejected`,
  // `poll_vote_stale_drop`). На машине побыстрее это ловилось раз в несколько
  // полных прогонов.
  resetControlTsMirrorForTests();
  mockTarget = { state: 'missing' };
  mockAuthor = { state: 'missing' };
  mockVotes.length = 0;
  mockKvWrites.length = 0;
  jest.clearAllMocks();
});

afterEach(() => {
  // Назначенные повторы и запомненные метки — состояние уровня модуля: без
  // уборки они судили бы следующую проверку.
  resetPollFlushRetriesForTests();
  resetControlTsMirrorForTests();
  jest.useRealTimers();
});

describe('отложенный на выкладке конверт возвращается на полку', () => {
  it('голос переживает занятую секунду и применяется следующей выкладкой', async () => {
    // Голос обогнал свой опрос — ложится на полку (v4.32.573).
    expect(await handleIncomingPollVote(vote(), SENDER, PID)).toBe('consumed');

    dbBusy();
    expect(await flushPendingPollVotes(MSG, PID, 2000)).toBe(0);
    expect(mockVotes).toEqual([]);

    dbHealthy();
    expect(await flushPendingPollVotes(MSG, PID, 3000)).toBe(1);
    expect(mockVotes).toEqual([`${MSG}|${SENDER}|0`]);
  });

  it('завершение переживает занятую секунду — иначе опрос открыт навсегда', async () => {
    expect(await handleIncomingPollClose(close(), SENDER, PID)).toBe('consumed');

    dbBusy();
    expect(await flushPendingPollCloses(MSG, PID, 2000)).toBe(0);
    expect(mockKvWrites.filter((k) => k.includes('poll_closed'))).toEqual([]);

    dbHealthy();
    expect(await flushPendingPollCloses(MSG, PID, 3000)).toBe(1);
    expect(mockKvWrites.filter((k) => k.includes('poll_closed'))).toHaveLength(1);
  });

  it('несколько голосов возвращаются все, а не первый', async () => {
    await handleIncomingPollVote(vote(0), SENDER, PID);
    await handleIncomingPollVote(vote(1), SENDER, PID);

    dbBusy();
    await flushPendingPollVotes(MSG, PID, 2000);
    dbHealthy();

    expect(await flushPendingPollVotes(MSG, PID, 3000)).toBe(2);
    expect(mockVotes.sort()).toEqual([`${MSG}|${SENDER}|0`, `${MSG}|${SENDER}|1`]);
  });

  it('просроченный на полке конверт возвратом не воскресает', async () => {
    // Полка помечает голос настоящими часами (Date.now() на месте укладки),
    // поэтому сроку тут нужна настоящая точка отсчёта, а не условная.
    const parkedAt = Date.now();
    await handleIncomingPollVote(vote(), SENDER, PID);
    dbBusy();
    await flushPendingPollVotes(MSG, PID, parkedAt + 1000);
    dbHealthy();

    // Срок отсчитывается от ПЕРВОЙ укладки: возврат его не продлевает, иначе
    // негодный конверт жил бы на полке столько, сколько длится сбой.
    expect(await flushPendingPollVotes(MSG, PID, parkedAt + 6 * 60 * 1000)).toBe(0);
    expect(mockVotes).toEqual([]);
  });
});

describe('выкладка зовёт себя сама: звать её больше некому', () => {
  it('повтор по таймеру применяет голос без единого вызова снаружи', async () => {
    jest.useFakeTimers();
    await handleIncomingPollVote(vote(), SENDER, PID);

    dbBusy();
    await flushPendingPollEnvelopes(MSG, PID, 2000);
    expect(mockVotes).toEqual([]);

    dbHealthy();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockVotes).toEqual([`${MSG}|${SENDER}|0`]);
  });

  it('попытки не бесконечны: после трёх выкладка сдаётся вслух', async () => {
    jest.useFakeTimers();
    await handleIncomingPollVote(vote(), SENDER, PID);

    dbBusy();
    await flushPendingPollEnvelopes(MSG, PID, 2000);
    // Трёх пауз (2с + 4с + 8с) с запасом хватает на весь бюджет.
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockLog.warn).toHaveBeenCalledWith('poll_flush_gave_up', expect.any(Object));
    expect(mockVotes).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: постоянный отказ на полке не крутится', () => {
  it('голос не в ту переписку выбрасывается насовсем', async () => {
    await handleIncomingPollVote(vote(), SENDER, PID);
    // Опрос нашёлся, но он из переписки с другим человеком — отказ постоянный.
    mockTarget = { state: 'found', value: { contactPubB64: 'X'.repeat(43), text: POLL } };

    expect(await flushPendingPollVotes(MSG, PID, 2000)).toBe(1);
    expect(mockVotes).toEqual([]);
    // Ничего не вернулось: второй выкладке брать уже нечего.
    dbHealthy();
    expect(await flushPendingPollVotes(MSG, PID, 3000)).toBe(0);
  });

  it('завершение не от автора выбрасывается насовсем', async () => {
    await handleIncomingPollClose(close(), SENDER, PID);
    mockAuthor = { state: 'found', value: { direction: 'out', contactPubB64: SENDER } };

    expect(await flushPendingPollCloses(MSG, PID, 2000)).toBe(1);
    dbHealthy();
    expect(await flushPendingPollCloses(MSG, PID, 3000)).toBe(0);
  });

  it('здоровая база применяет всё с первого раза и повтора не просит', async () => {
    jest.useFakeTimers();
    await handleIncomingPollVote(vote(), SENDER, PID);
    dbHealthy();

    expect(await flushPendingPollVotes(MSG, PID, 2000)).toBe(1);
    mockVotes.length = 0;
    await jest.advanceTimersByTimeAsync(60_000);
    // Повтора не было: голос не записан второй раз и никто не сдавался.
    expect(mockVotes).toEqual([]);
    expect(mockLog.warn).not.toHaveBeenCalledWith('poll_flush_gave_up', expect.any(Object));
  });

  it('пустая полка выкладку не будит', async () => {
    jest.useFakeTimers();
    expect(await flushPendingPollVotes(MSG, PID, 2000)).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('снятие с полки безвозвратно, а снятому голосу класться обратно запрещено', () => {
    const shelf = codeOnly(read('pollVotePending.ts'));
    // take отдаёт своё и вычёркивает: никакой копии на полке не остаётся.
    expect(shelf).toContain('parked = fresh.filter((p) => !(p.msgId === msgId && p.pid === pid));');
    const flush = codeOnly(read('pollVoteSync.ts'));
    // Последний аргумент применения при выкладке — canPark: false.
    expect(flush).toMatch(/pid,\n\s+now,\n\s+false\n\s+\);/);
  });

  it('вызывающие выкладку стоят вне договора о кадре', () => {
    for (const file of ['messaging.ts', 'groupMessaging.ts']) {
      const body = codeOnly(read(file));
      // `void import(...)`: ответ выкладки никуда не идёт, и сказать `deferred`
      // вызывающему нечем — кадр объявлен разобранным раньше.
      expect(body).toContain("void import('./pollVoteSync')");
    }
  });

  it('второй раз то же сообщение приёмник не запишет', () => {
    const body = codeOnly(read('groupMessaging.ts'));
    expect(body).toContain("if (stored === 'duplicate') {");
    expect(body).toContain("return 'consumed';");
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('обе выкладки возвращают конверт и просят повтор', () => {
    const body = codeOnly(read('pollVoteSync.ts'));
    expect(body).toContain('const repark = (v: ParkedVote): void => {');
    expect(body).toContain('const repark = (c: ParkedClose): void => {');
    expect(body.split('if (failed > 0) scheduleFlushRetry(msgId, pid, attempt + 1);').length - 1)
      .toBe(2);
  });

  it('бюджет попыток назван и проверяется', () => {
    const body = codeOnly(read('pollVoteSync.ts'));
    expect(body).toContain('const FLUSH_RETRY_ATTEMPTS = 3;');
    expect(body).toContain('if (attempt > FLUSH_RETRY_ATTEMPTS) {');
  });

  it('на пару «профиль + сообщение» назначается один повтор', () => {
    const body = codeOnly(read('pollVoteSync.ts'));
    expect(body).toContain('if (flushRetryTimers.has(key)) return;');
    expect(body).toContain('flushRetryTimers.delete(key);');
  });
});
