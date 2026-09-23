/**
 * v4.32.730: отметка «докуда прочитано» больше не перешагивает неразобранное.
 *
 * Relay хранит накопленное тридцать суток и отдаёт его по `?since=<отметка>`.
 * Отметка двигалась по кадрам, разбор которых «не бросил», — а приёмники о
 * временной беде сообщали одним `return`: справочник контактов не прочитался,
 * служба переписки ещё не поднята (холодный старт, а накопленное уже пришло),
 * состав группы недоступен, профиль переключился посреди разбора. Снаружи это
 * было неотличимо от удачи, отметка уходила вперёд — и сообщение, лежащее на
 * relay ещё месяц, не запрашивалось больше никогда. Отправитель видел
 * «Доставлено».
 *
 * Второй дефект того же места: удержание отметки при провале не работало ни в
 * одной пачке длиннее одного кадра. Транспорт зовёт `onFrame` на каждое
 * сообщение WS, не дожидаясь разбора предыдущего, а отметка двигалась только
 * вперёд — поэтому соседний удачный кадр уносил её за тот, который мы
 * собирались перезапросить. То есть защита отказывала ровно там, где нужна:
 * при догрузке накопленного после долгого офлайна.
 *
 * Проверяется поведением: координатор поднимается с поддельным транспортом, а
 * отметка читается там же, где она и живёт, — в записи `saveBacklogWatermark`.
 * Через `since()` её не увидеть точно: значение срезается по сроку хранения
 * relay, и любая отметка старше месяца превратилась бы в одно и то же число.
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

/** Кадр — личный конверт: ни feed-magic, ни «type»:«group». */
jest.mock('../../../social/feedTransport', () => ({ isFeedFrame: () => false }));
jest.mock('../../../social/feedService', () => ({ receiveFeedEnvelope: jest.fn() }));

/** Чем ответит приёмник на следующий кадр. Это и есть предмет проверки. */
let mockDmIntake: EnvelopeIntake = 'consumed';
let mockDmService = true;
let mockGroupService = true;

jest.mock('../../../social/messaging', () => ({
  getMessagingService: () =>
    mockDmService ? { receiveDirectLanEnvelope: async () => mockDmIntake } : null,
}));
jest.mock('../../../social/groupMessaging', () => ({
  getGroupMessagingService: () =>
    mockGroupService ? { receiveGroupEnvelope: async () => mockDmIntake } : null,
}));

import { startInternetTransportIfEnabled, stopInternetTransportStack } from '../internetCoordinator';

const PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) };
const DM = new TextEncoder().encode('{"type":"dm"}');
const GROUP = new TextEncoder().encode('{"type":"group_msg"}');

/** Ранний и поздний кадры одной пачки накопленного. */
const EARLY = 1_700_000_000_000;
const LATE = 1_700_000_300_000;

const saved = saveBacklogWatermark as jest.MockedFunction<typeof saveBacklogWatermark>;

/**
 * Отметка, дошедшая до базы.
 *
 * Останавливаем стек: отметка уходит в базу не чаще раза в десять секунд, а
 * остаток дописывается на остановке — тем самым `stop`, который вызывает уход
 * приложения в фон. Так видно итог, а не то, успел ли таймер.
 */
function watermark(): number | null {
  stopInternetTransportStack();
  const calls = saved.mock.calls;
  return calls.length === 0 ? null : Number(calls[calls.length - 1][1]);
}

/** Отдать кадр и дождаться разбора: координатор запускает его через `void`. */
async function frame(atMs: number, payload: Uint8Array = DM): Promise<void> {
  started?.onFrame('did:key:zPEER', payload, atMs);
  await new Promise((r) => setImmediate(r));
}

beforeEach(async () => {
  stopInternetTransportStack();
  started = null;
  saved.mockClear();
  mockDmIntake = 'consumed';
  mockDmService = true;
  mockGroupService = true;
  await startInternetTransportIfEnabled(PAIR);
});

afterEach(() => stopInternetTransportStack());

describe('отметка идёт только по разобранному', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: разобранный кадр отметку двигает', async () => {
    await frame(EARLY);
    expect(watermark()).toBe(EARLY);
  });

  it('отложенный кадр отметку не двигает', async () => {
    mockDmIntake = 'deferred';
    await frame(EARLY);
    // Отметки нет вовсе: при следующем подключении кадр будет перезапрошен.
    expect(watermark()).toBeNull();
  });

  it('службы переписки ещё нет — кадр не разобран, а отложен', async () => {
    // Холодный старт: накопленное приходит раньше, чем поднялась переписка.
    mockDmService = false;
    await frame(EARLY);
    expect(watermark()).toBeNull();
  });

  it('группового приёмника ещё нет — то же самое', async () => {
    mockGroupService = false;
    await frame(EARLY, GROUP);
    expect(watermark()).toBeNull();
  });
});

describe('соседний кадр не уносит отметку за отложенный', () => {
  it('удачный поздний кадр останавливается перед ранним отложенным', async () => {
    mockDmIntake = 'deferred';
    await frame(EARLY); // ранний — отложен
    mockDmIntake = 'consumed';
    await frame(LATE); // поздний той же пачки — разобран
    // Отметка встала ПЕРЕД отложенным: иначе его не перезапросят никогда.
    expect(watermark()).toBe(EARLY - 1);
  });

  it('разобранный со второго раза кадр отпускает удержание', async () => {
    mockDmIntake = 'deferred';
    await frame(EARLY);
    mockDmIntake = 'consumed';
    await frame(LATE);
    // Перезапрос удался — держать больше нечего, и отметка догоняет пачку.
    await frame(EARLY);
    await frame(LATE);
    expect(watermark()).toBe(LATE);
  });

  it('второй отказ того же кадра отпускает отметку: иначе месяц по кругу', async () => {
    mockDmIntake = 'deferred';
    await frame(EARLY);
    await frame(EARLY);
    mockDmIntake = 'consumed';
    await frame(LATE);
    expect(watermark()).toBe(LATE);
  });
});
