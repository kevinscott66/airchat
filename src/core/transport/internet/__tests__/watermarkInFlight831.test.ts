/**
 * Отметка перешагивала кадр, разбор которого ещё шёл (v4.32.831).
 *
 * Дефект. Транспорт зовёт `onFrame` на каждое сообщение WS, не дожидаясь
 * предыдущего, — это записано в самом координаторе. Удержание отметки
 * появлялось у кадра только тогда, когда его разбор УПАЛ. А между приёмом и
 * провалом лежит вся работа: ECDH, поиск контакта, несколько походов в SQLite.
 * Всё это время кадр для отметки не существовал: ни в `failedOnce`, ни в
 * `held`. Сосед по пачке, которому разбирать нечего, успевал ответить
 * «разобрано», и отметка уходила за ещё разбираемый кадр. Когда тот наконец
 * отвечал «отложено», вернуть её было уже некуда — назад она не ходит
 * (`if (target <= watermark) return`).
 *
 * Второй путь в ту же дыру — потолок: `if (failedOnce.size > 512) { …
 * held.clear(); }` снимал все удержания разом, ничего не продвинув, и
 * следующий же удачный кадр перешагивал все пятьсот отложенных.
 *
 * Цена. Ночь без сети; утром relay отдаёт накопленное пачкой. Личное сообщение
 * от 02:00 ещё расшифровывается, отброс от 07:00 уже ответил — отметка 07:00.
 * Сообщения от 02:00 не будет НИКОГДА: следующая подписка попросит
 * `?since=06:59`, страховки там одна минута на пачку длиной в часы. Отправитель
 * при этом видит «Доставлено». Через потолок — то же самое, но разом: первые
 * сотни кадров после долгого офлайна отложены (службы ещё не поднялись), и
 * недели переписки, групп и ленты пропадают одним шагом. В журнале ни слова.
 *
 * Правка. Кадр держит отметку с первой строки разбора и до тех пор, пока с ним
 * не закончили; потолок остался только у памяти о провалах. Плюс память
 * `doneUpTo`: кадры пачки заканчиваются не в том порядке, в каком пришли, и без
 * неё отметка, дождавшись раннего, встала бы на нём, а разобранный поздний
 * качался бы заново.
 */
import { saveBacklogWatermark } from '../relayBacklog';
import type { EnvelopeIntake } from '../../envelopeIntake';

type StartOpts = { since: () => string; onFrame: (did: string, p: Uint8Array, at: number) => void };

let started: StartOpts | null = null;

jest.mock('../internetTransport', () => ({
  getInternetTransportSingleton: () => ({
    start: (o: StartOpts) => {
      started = o;
    },
    stop: () => undefined,
  }),
}));

jest.mock('../relayBacklog', () => {
  const actual = jest.requireActual('../relayBacklog');
  return {
    ...actual,
    loadBacklogWatermark: jest.fn(async () => null),
    saveBacklogWatermark: jest.fn(async () => undefined),
  };
});

jest.mock('../../../config', () => ({ loadConfig: jest.fn(async () => ({ internet: {} })) }));
jest.mock('../../../identity/did', () => ({ publicKeyToDidKey: () => 'did:key:zTEST' }));
jest.mock('../../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../social/feedTransport', () => ({ isFeedFrame: () => false }));
jest.mock('../../../social/feedService', () => ({ receiveFeedEnvelope: jest.fn() }));
jest.mock('../../../social/groupMessaging', () => ({ getGroupMessagingService: () => null }));

/**
 * Разбор, который не заканчивается сам.
 *
 * Здесь вся суть проверки: настоящий приёмник не отвечает мгновенно, и
 * дефект жил ровно в той щели, где один кадр ещё разбирается, а другой уже
 * ответил. Существующий прогон (backlogIntake730) щели не видит — он ждёт
 * каждый кадр перед следующим.
 */
const mockAwaiting: { res: (v: EnvelopeIntake) => void; rej: (e: unknown) => void }[] = [];
jest.mock('../../../social/messaging', () => ({
  getMessagingService: () => ({
    receiveDirectLanEnvelope: () =>
      new Promise<EnvelopeIntake>((res, rej) => {
        mockAwaiting.push({ res, rej });
      }),
  }),
}));

import fs from 'fs';
import path from 'path';

import { startInternetTransportIfEnabled, stopInternetTransportStack } from '../internetCoordinator';

const PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) };
const DM = new TextEncoder().encode('{"type":"dm"}');

/** Ночная пачка: раннее сообщение и поздний сосед. */
const EARLY = 1_700_000_000_000;
const LATE = 1_700_000_300_000;

const saved = saveBacklogWatermark as jest.MockedFunction<typeof saveBacklogWatermark>;

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Отдать кадр, не дожидаясь его разбора, — как это делает транспорт. */
function send(atMs: number): void {
  started?.onFrame('did:key:zPEER', DM, atMs);
}

/** Ответить за разбор, начатый n-м по счёту. */
async function answer(n: number, intake: EnvelopeIntake): Promise<void> {
  mockAwaiting[n].res(intake);
  await tick();
}

/** Уронить n-й разбор — занятой базой, например. */
async function fail(n: number, err: string): Promise<void> {
  mockAwaiting[n].rej(new Error(err));
  await tick();
}

/** Отметка, дошедшая до базы: остановка стека дописывает остаток. */
function watermark(): number | null {
  stopInternetTransportStack();
  const calls = saved.mock.calls;
  return calls.length === 0 ? null : Number(calls[calls.length - 1][1]);
}

beforeEach(async () => {
  stopInternetTransportStack();
  started = null;
  saved.mockClear();
  mockAwaiting.length = 0;
  await startInternetTransportIfEnabled(PAIR);
});

afterEach(() => stopInternetTransportStack());

describe('отметка ждёт кадр, который ещё разбирается', () => {
  it('поздний сосед не уносит отметку за разбираемый ранний', async () => {
    send(EARLY);
    send(LATE);
    await tick();
    expect(mockAwaiting).toHaveLength(2);

    // Поздний отвечает первым — ему разбирать нечего.
    await answer(1, 'consumed');
    // Ранний только теперь говорит «отложено».
    await answer(0, 'deferred');

    // Отметка обязана стоять ПЕРЕД ранним: иначе его не перезапросят никогда.
    expect(watermark()).toBe(EARLY - 1);
  });

  it('и если ранний упал с исключением — то же самое', async () => {
    send(EARLY);
    send(LATE);
    await tick();
    await answer(1, 'consumed');
    await fail(0, 'SQLITE_BUSY');
    expect(watermark()).toBe(EARLY - 1);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Удержание, которое не снимается, не лучше отметки, которая перешагивает: оно
 * заставляет качать накопленное по кругу при каждом подключении.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: закончив, отметка идёт дальше', () => {
  it('оба кадра разобраны — отметка на позднем, даже если он ответил первым', async () => {
    send(EARLY);
    send(LATE);
    await tick();
    await answer(1, 'consumed');
    await answer(0, 'consumed');
    // Не EARLY: поздний разобран, качать его заново незачем.
    expect(watermark()).toBe(LATE);
  });

  it('одинокий разобранный кадр двигает отметку', async () => {
    send(EARLY);
    await tick();
    await answer(0, 'consumed');
    expect(watermark()).toBe(EARLY);
  });

  it('перезапрошенный и разобранный кадр отпускает удержание', async () => {
    send(EARLY);
    send(LATE);
    await tick();
    await answer(1, 'consumed');
    await answer(0, 'deferred');
    // Следующее подключение приносит ранний снова — и он разбирается.
    send(EARLY);
    await tick();
    await answer(2, 'consumed');
    expect(watermark()).toBe(LATE);
  });

  it('стабильно падающий кадр отпускается со второго раза', async () => {
    send(EARLY);
    await tick();
    await answer(0, 'deferred');
    send(EARLY);
    await tick();
    await answer(1, 'deferred');
    // Иначе накопленный месяц качался бы по кругу при каждом подключении.
    expect(watermark()).toBe(EARLY);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Всё держится на одном свойстве транспорта: кадры разбираются внахлёст. Если
 * бы он ждал каждый разбор, дефекта бы не было — и правки тоже.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: кадры разбираются внахлёст', () => {
  it('транспорт не ждёт разбора предыдущего кадра', async () => {
    send(EARLY);
    send(LATE);
    await tick();
    // Два разбора идут одновременно — именно это и делает щель возможной.
    expect(mockAwaiting).toHaveLength(2);
  });

  it('отметка назад не ходит — вернуть её после промаха нечем', async () => {
    send(LATE);
    await tick();
    await answer(0, 'consumed');
    send(EARLY);
    await tick();
    await answer(1, 'consumed');
    expect(watermark()).toBe(LATE);
  });
});

/** Рэтчет формы: потолок не снимает удержаний. */
describe('форма исходников: потолок только у памяти о провалах', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'internetCoordinator.ts'), 'utf8');

  it('кадр держит отметку с первой строки разбора', () => {
    expect(SRC).toContain('hold(frameAtMs);');
    expect(SRC).toContain('release(frameAtMs);');
    expect(SRC).toContain('for (const h of inFlight.keys()) if (h <= target) target = h - 1;');
  });

  it('потолок не трогает удержаний', () => {
    expect(SRC).toContain('if (failedOnce.size > 512) failedOnce.clear();');
    expect(SRC).not.toContain('held.clear();');
  });
});
