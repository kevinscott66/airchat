/**
 * Кадр из локальной сети: отказ разбора называется в журнале (v4.32.780).
 *
 * По локальной сети кадр приходит живьём: накопленного у LAN нет, отметки
 * «докуда прочитано» тоже, перезапросить конверт неоткуда. Поэтому исход
 * разбора здесь намеренно выброшен — отвечает он ради интернет-координатора.
 *
 * Но вместе с исходом выбрасывалось и брошенное. Каждый из четырёх разборов
 * звался через голый `void`, и отказ — занятая база в разборе группового
 * управления, недоступный справочник контактов, испорченный кусок блоба —
 * уходил в необработанное отклонение обещания. В журнале самого приложения
 * такой записи нет вовсе: она видна лишь в системной консоли сборки, которой у
 * человека на руках не бывает. Жалоба «сообщение из соседней комнаты не дошло»
 * упиралась в пустоту — по журналу выходило, что кадр вообще не приходил.
 *
 * Теперь каждый разбор идёт через `intakeLanFrame`: потеря остаётся потерей, но
 * она названа. Ловушка берёт работу замыканием, так что ловит и брошенное
 * синхронно — до первого `await` внутри разбора.
 */
/** Что бросает разбор группового конверта (null — не бросает). */
let mockGroupThrow: Error | null = null;
/** Что бросает разбор прямого конверта. */
let mockDirectThrow: Error | null = null;
/** Что бросает разбор куска блоба. */
let mockBlobThrow: Error | null = null;
/** Что бросает разбор конверта ленты. */
let mockFeedThrow: Error | null = null;
/** Бросает ли сама выдача службы группы — то есть синхронно, до обещания. */
let mockGroupSvcThrow: Error | null = null;
/** Пойманный координатором обработчик кадра. */
let mockOnFrame: ((senderDid: string, payload: Uint8Array) => void) | null = null;

jest.mock('../lanTransport', () => ({
  getLanTransportSingleton: () => ({
    start: (opts: { onFrame: (d: string, p: Uint8Array) => void }) => {
      mockOnFrame = opts.onFrame;
    },
    stop: () => {},
  }),
}));

jest.mock('../lanBlob', () => ({
  isLanBlobFrame: (p: Uint8Array) => p[0] === 0xb1,
  receiveLanBlobFrame: async () => {
    if (mockBlobThrow) throw mockBlobThrow;
  },
}));

jest.mock('../../../social/feedTransport', () => ({
  isFeedFrame: (p: Uint8Array) => p[0] === 0xf0,
}));

jest.mock('../../../social/feedService', () => ({
  receiveFeedEnvelope: async () => {
    if (mockFeedThrow) throw mockFeedThrow;
  },
  flushFeedQueueForPeer: async () => {},
}));

jest.mock('../../../social/groupMessaging', () => ({
  getGroupMessagingService: () => {
    if (mockGroupSvcThrow) throw mockGroupSvcThrow;
    return {
      receiveGroupEnvelope: async () => {
        if (mockGroupThrow) throw mockGroupThrow;
        return 'consumed';
      },
    };
  },
}));

jest.mock('../../../social/messaging', () => ({
  getMessagingService: () => ({
    receiveDirectLanEnvelope: async () => {
      if (mockDirectThrow) throw mockDirectThrow;
      return 'consumed';
    },
  }),
}));

jest.mock('../../../storage/sync', () => ({ runSyncIfOnline: async () => {} }));
jest.mock('../../../config', () => ({
  loadConfig: async () => ({ lan: { enabled: true, port: 9000 } }),
}));
jest.mock('../../../identity/did', () => ({
  publicKeyToDidKey: () => 'did:key:zMe',
}));
jest.mock('../../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { startLanTransportIfEnabled, stopLanTransportStack } from '../lanCoordinator';
import type { KeyPairBytes } from '../../../crypto/keyManager';

const mockLog = (jest.requireMock('../../../logger') as { log: { warn: jest.Mock } }).log;

const PAIR = {
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(64),
} as unknown as KeyPairBytes;

const SENDER = 'did:key:zPeerAbcdefghijklmnop';

/** Кадр группового конверта: regex координатора ищет `"type":"group`. */
const GROUP = new TextEncoder().encode('{"type":"groupMsg","groupId":"g"}');
/** Кадр прямого конверта: ни блоб, ни лента, ни группа. */
const DIRECT = new TextEncoder().encode('{"type":"dm"}');
/** Кусок блоба: первый байт 0xB1. */
const BLOB = new Uint8Array([0xb1, 1, 2, 3]);
/** Конверт ленты: первый байт 0xF0. */
const FEED = new Uint8Array([0xf0, 1, 2, 3]);

/** Поднять координатор заново и вернуть пойманный обработчик кадра. */
async function frameHandler(): Promise<(senderDid: string, payload: Uint8Array) => void> {
  stopLanTransportStack();
  mockOnFrame = null;
  await startLanTransportIfEnabled(PAIR);
  if (!mockOnFrame) throw new Error('координатор не отдал обработчик кадра');
  return mockOnFrame;
}

/** Дать пойманным обещаниям дойти до ловушки. */
const settle = () => new Promise((r) => setImmediate(r));

/** Записи об отказе разбора кадра. */
const failures = () =>
  mockLog.warn.mock.calls.filter((c) => c[0] === 'lan_frame_handle_failed');

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const LAN = codeOnly(readFileSync(join(__dirname, '..', 'lanCoordinator.ts'), 'utf8'));

beforeEach(() => {
  mockGroupThrow = null;
  mockDirectThrow = null;
  mockBlobThrow = null;
  mockFeedThrow = null;
  mockGroupSvcThrow = null;
  jest.clearAllMocks();
});

afterEach(() => {
  stopLanTransportStack();
});

describe('отказ разбора кадра попадает в журнал, а не в пустоту', () => {
  it('групповой конверт: причина названа вместе с видом кадра', async () => {
    mockGroupThrow = new Error('database is locked');
    const onFrame = await frameHandler();

    onFrame(SENDER, GROUP);
    await settle();

    expect(failures()).toHaveLength(1);
    expect(failures()[0][1]).toMatchObject({ kind: 'group', err: 'database is locked' });
  });

  it('прямой конверт разбирается под той же ловушкой', async () => {
    mockDirectThrow = new Error('contacts unreadable');
    const onFrame = await frameHandler();

    onFrame(SENDER, DIRECT);
    await settle();

    expect(failures()).toHaveLength(1);
    expect(failures()[0][1]).toMatchObject({ kind: 'direct', err: 'contacts unreadable' });
  });

  it('кусок блоба тоже', async () => {
    mockBlobThrow = new Error('chunk out of order');
    const onFrame = await frameHandler();

    onFrame(SENDER, BLOB);
    await settle();

    expect(failures()).toHaveLength(1);
    expect(failures()[0][1]).toMatchObject({ kind: 'blob' });
  });

  it('конверт ленты тоже', async () => {
    mockFeedThrow = new Error('bad signature');
    const onFrame = await frameHandler();

    onFrame(SENDER, FEED);
    await settle();

    expect(failures()).toHaveLength(1);
    expect(failures()[0][1]).toMatchObject({ kind: 'feed' });
  });

  it('отправитель назван обрезанным, целиком ключ в журнал не уходит', async () => {
    mockGroupThrow = new Error('database is locked');
    const onFrame = await frameHandler();

    onFrame(SENDER, GROUP);
    await settle();

    expect(failures()[0][1].from).toBe(SENDER.slice(0, 24));
    expect(failures()[0][1].from.length).toBeLessThan(SENDER.length);
  });

  it('брошенное синхронно — до первого ожидания — ловится той же ловушкой', async () => {
    mockGroupSvcThrow = new Error('service not ready');
    const onFrame = await frameHandler();

    expect(() => onFrame(SENDER, GROUP)).not.toThrow();
    await settle();

    expect(failures()).toHaveLength(1);
    expect(failures()[0][1]).toMatchObject({ kind: 'group', err: 'service not ready' });
  });

  it('отказ одного кадра не мешает разобрать следующий', async () => {
    mockGroupThrow = new Error('database is locked');
    const onFrame = await frameHandler();

    onFrame(SENDER, GROUP);
    await settle();
    mockGroupThrow = null;
    onFrame(SENDER, GROUP);
    await settle();

    expect(failures()).toHaveLength(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удачный разбор в журнале не шумит', () => {
  it('разобранный групповой конверт записи об отказе не оставляет', async () => {
    const onFrame = await frameHandler();

    onFrame(SENDER, GROUP);
    await settle();

    expect(failures()).toEqual([]);
  });

  it('разобранный прямой конверт тоже', async () => {
    const onFrame = await frameHandler();

    onFrame(SENDER, DIRECT);
    await settle();

    expect(failures()).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ни один разбор кадра не зовётся голым void', () => {
    const at = LAN.indexOf('if (isLanBlobFrame(payload))');
    expect(at).toBeGreaterThan(0);
    const block = LAN.slice(at, LAN.indexOf('onPeerDiscovered:', at));
    expect(block).not.toContain('void ');
    expect(block.match(/intakeLanFrame\(/g)).toHaveLength(4);
  });

  it('ловушка берёт работу замыканием, а не готовым обещанием', () => {
    const body = LAN.slice(
      LAN.indexOf('function intakeLanFrame('),
      LAN.indexOf('export async function startLanTransportIfEnabled(')
    );
    expect(body).toContain('run: () => Promise<unknown> | undefined');
    // Обещание — под .catch, синхронно брошенное — под try/catch: без обоих
    // половина отказов осталась бы незамеченной.
    expect(body).toContain('void run()?.catch(failed);');
    expect(body).toContain('} catch (e) {');
  });
});
