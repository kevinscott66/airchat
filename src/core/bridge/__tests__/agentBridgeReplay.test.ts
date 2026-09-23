/**
 * Повтор команды моста (v4.32.723).
 *
 * Это не умозрительная атака, а обычная работа подписки: ретранслятор хранит
 * сообщения до 30 суток, подписка открывается с `?since=`, и при каждом
 * переподключении история приезжает заново. Без защиты команда «включи
 * туннель», отправленная агентом неделю назад, исполнялась бы сама собой при
 * каждом запуске приложения.
 *
 * Данные здесь синтетические: секрет — это 32 байта нулей и единиц, в сеть
 * тест не ходит, публичного ретранслятора не касается.
 */
const kv: Record<string, string> = {};
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => kv[k] ?? null),
  kvSet: jest.fn(async (k: string, v: string) => {
    kv[k] = v;
  }),
}));

const secureStore: Record<string, string> = {};
jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: jest.fn(async (k: string) => secureStore[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    secureStore[k] = v;
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    delete secureStore[k];
  }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({})),
}));

/** Исполнение команд подменено: здесь проверяется допуск до него, а не оно само. */
const mockRunBridgeCommand = jest.fn(async (c: { cmd: string }) => ({
  ok: true as const,
  cmd: c.cmd,
  result: {},
}));
jest.mock('../agentBridgeCommands', () => ({
  KNOWN_COMMANDS: ['whoami'],
  runBridgeCommand: (c: { cmd: string }) => mockRunBridgeCommand(c),
  parseCommand: (p: unknown) =>
    p && typeof p === 'object' && typeof (p as { cmd?: unknown }).cmd === 'string'
      ? { cmd: (p as { cmd: string }).cmd }
      : null,
}));

import { deriveBridgeKeys } from '../agentBridgeKeys';
import { sealFrame } from '../agentBridgeFrame';
import { BridgeGuard, FRESHNESS_WINDOW_MS, RATE_LIMIT_MAX } from '../agentBridgeGuard';
import { handleBridgeFrameForTest } from '../agentBridge';
import type { BridgeReply } from '../agentBridgeCommands';

const SECRET = new Uint8Array(32).fill(7);
const OTHER_SECRET = new Uint8Array(32).fill(9);

function keys() {
  return deriveBridgeKeys(SECRET);
}

async function feed(
  guard: BridgeGuard,
  frame: string,
): Promise<{ replies: BridgeReply[]; ranBefore: number }> {
  const replies: BridgeReply[] = [];
  const ranBefore = mockRunBridgeCommand.mock.calls.length;
  await handleBridgeFrameForTest(keys(), guard, frame, (r) => replies.push(r));
  return { replies, ranBefore };
}

beforeEach(() => {
  mockRunBridgeCommand.mockClear();
  for (const k of Object.keys(secureStore)) delete secureStore[k];
});

describe('мост: защита от повтора', () => {
  it('исполняет команду один раз и молча отбрасывает её повтор', async () => {
    const guard = new BridgeGuard(0);
    const frame = sealFrame(keys().aeadKey, 'cmd', 1, Date.now(), { cmd: 'whoami' });

    const first = await feed(guard, frame);
    expect(mockRunBridgeCommand).toHaveBeenCalledTimes(1);
    expect(first.replies).toHaveLength(1);

    // Тот же самый кадр, каким его отдаст ретранслятор при переподключении.
    const second = await feed(guard, frame);
    expect(mockRunBridgeCommand).toHaveBeenCalledTimes(1);
    // Ответа нет намеренно: иначе каждое переподключение засыпало бы агента
    // отказами на команды, отправленные им когда-то давно.
    expect(second.replies).toHaveLength(0);
  });

  it('не исполняет команду недельной давности, даже с новым номером', async () => {
    const guard = new BridgeGuard(0);
    const week = Date.now() - 7 * 24 * 60 * 60_000;
    const frame = sealFrame(keys().aeadKey, 'cmd', 42, week, { cmd: 'whoami' });

    const { replies } = await feed(guard, frame);
    expect(mockRunBridgeCommand).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it('счётчик переживает перезапуск моста: команда не исполняется второй раз', async () => {
    const at = Date.now();
    const frame = sealFrame(keys().aeadKey, 'cmd', 5, at, { cmd: 'whoami' });
    await feed(new BridgeGuard(0), frame);
    expect(mockRunBridgeCommand).toHaveBeenCalledTimes(1);

    // Приложение перезапустили: guard поднимается из сохранённого номера.
    const saved = Number.parseInt(secureStore['airchat_agent_bridge_seq'] ?? '0', 10);
    expect(saved).toBe(5);
    await feed(new BridgeGuard(saved), frame);
    expect(mockRunBridgeCommand).toHaveBeenCalledTimes(1);
  });

  it('номер не продвигается кадром, который не расшифровался', async () => {
    const guard = new BridgeGuard(0);
    // Чужой ключ, но номер в открытом заголовке огромный: если бы счётчик
    // двигался до расшифровки, настоящий агент был бы заперт навсегда.
    const hostile = sealFrame(deriveBridgeKeys(OTHER_SECRET).aeadKey, 'cmd', 9_000_000, Date.now(), {
      cmd: 'whoami',
    });
    const hostileRun = await feed(guard, hostile);
    expect(mockRunBridgeCommand).not.toHaveBeenCalled();
    expect(hostileRun.replies).toHaveLength(0);
    expect(guard.lastAcceptedSeq()).toBe(0);

    const mine = sealFrame(keys().aeadKey, 'cmd', 1, Date.now(), { cmd: 'whoami' });
    await feed(guard, mine);
    expect(mockRunBridgeCommand).toHaveBeenCalledTimes(1);
  });
});

describe('мост: чужой ключ', () => {
  it('не исполняет и не отвечает на кадр, зашифрованный чужим ключом', async () => {
    const guard = new BridgeGuard(0);
    const frame = sealFrame(deriveBridgeKeys(OTHER_SECRET).aeadKey, 'cmd', 1, Date.now(), {
      cmd: 'whoami',
    });
    const { replies } = await feed(guard, frame);
    expect(mockRunBridgeCommand).not.toHaveBeenCalled();
    // Молчание намеренное: ответ подтвердил бы чужому, что тема угадана верно.
    expect(replies).toHaveLength(0);
  });

  it('не исполняет кадр с подменённым заголовком', async () => {
    const guard = new BridgeGuard(0);
    const at = Date.now();
    const frame = sealFrame(keys().aeadKey, 'cmd', 1, at, { cmd: 'whoami' });
    const head = JSON.parse(frame) as Record<string, unknown>;
    // Номер связан с телом через AAD: переписать его в заголовке нельзя.
    head.seq = 2;
    const { replies } = await feed(guard, JSON.stringify(head));
    expect(mockRunBridgeCommand).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });
});

describe('мост: предел частоты', () => {
  it('отказывает с внятной причиной, исчерпав квоту', async () => {
    const guard = new BridgeGuard(0);
    const at = Date.now();
    for (let i = 1; i <= RATE_LIMIT_MAX; i++) {
      await feed(guard, sealFrame(keys().aeadKey, 'cmd', i, at, { cmd: 'whoami' }));
    }
    expect(mockRunBridgeCommand).toHaveBeenCalledTimes(RATE_LIMIT_MAX);

    const over = await feed(
      guard,
      sealFrame(keys().aeadKey, 'cmd', RATE_LIMIT_MAX + 1, at, { cmd: 'whoami' }),
    );
    expect(mockRunBridgeCommand).toHaveBeenCalledTimes(RATE_LIMIT_MAX);
    expect(over.replies).toHaveLength(1);
    const reply = over.replies[0];
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error).toBe('rate_limited');
      // Отказ по частоте не съедает номер: агент вправе повторить.
      expect(guard.lastAcceptedSeq()).toBe(RATE_LIMIT_MAX);
      expect(reply.message).toMatch(/Слишком часто/);
    }
  });
});

describe('мост: окно свежести', () => {
  it('пять минут — ровно та величина, с которой согласована подписка', () => {
    expect(FRESHNESS_WINDOW_MS).toBe(5 * 60_000);
  });
});
