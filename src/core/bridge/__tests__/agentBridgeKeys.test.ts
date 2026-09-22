/**
 * Ключ доступа моста и его отзыв (v4.32.723).
 *
 * Проверяется то, ради чего секрет сделан отдельным от seed-фразы: отзыв. И
 * то, ради чего мост выключен по умолчанию: канал управления приложением не
 * должен открыться оттого, что записи в хранилище не нашлось.
 *
 * Данные синтетические, в сеть тест не ходит.
 */
const mockKv: Record<string, string> = {};
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv[k] ?? null),
  kvSet: jest.fn(async (k: string, v: string) => {
    mockKv[k] = v;
  }),
}));

const mockSecure: Record<string, string> = {};
jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: jest.fn(async (k: string) => mockSecure[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockSecure[k] = v;
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    delete mockSecure[k];
  }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../config', () => ({ loadConfig: jest.fn(async () => ({})) }));
jest.mock('../agentBridgeCommands', () => ({
  KNOWN_COMMANDS: [],
  runBridgeCommand: jest.fn(),
  parseCommand: jest.fn(),
}));

import {
  BRIDGE_SECRET_BYTES,
  deriveBridgeKeys,
  formatAccessKey,
  loadBridgeSecret,
  loadOrCreateBridgeSecret,
  parseAccessKey,
  readAcceptedSeq,
  rotateBridgeSecret,
  writeAcceptedSeq,
} from '../agentBridgeKeys';
import { isBridgeEnabled, setBridgeEnabled, startAgentBridgeIfEnabled, isBridgeRunning } from '../agentBridge';
import { bytesToBase64Url } from '../../utils/base64url';

beforeEach(() => {
  for (const k of Object.keys(mockKv)) delete mockKv[k];
  for (const k of Object.keys(mockSecure)) delete mockSecure[k];
});

describe('мост: выключен по умолчанию', () => {
  it('на чистом устройстве мост выключен', async () => {
    expect(await isBridgeEnabled()).toBe(false);
  });

  it('мусор в хранилище не считается за «включено»', async () => {
    mockKv['agent_bridge_enabled'] = 'yes';
    expect(await isBridgeEnabled()).toBe(false);
    mockKv['agent_bridge_enabled'] = '';
    expect(await isBridgeEnabled()).toBe(false);
  });

  it('включается только явно', async () => {
    await setBridgeEnabled(true);
    expect(await isBridgeEnabled()).toBe(true);
    await setBridgeEnabled(false);
    expect(await isBridgeEnabled()).toBe(false);
  });

  it('выключенный мост не поднимает сокет', async () => {
    expect(await startAgentBridgeIfEnabled()).toBe(false);
    expect(isBridgeRunning()).toBe(false);
  });

  it('включённый без ключа доступа мост не поднимается', async () => {
    await setBridgeEnabled(true);
    expect(await startAgentBridgeIfEnabled()).toBe(false);
  });
});

describe('мост: производные от секрета', () => {
  const a = new Uint8Array(BRIDGE_SECRET_BYTES).fill(1);
  const b = new Uint8Array(BRIDGE_SECRET_BYTES).fill(2);

  it('из одного секрета всегда одни и те же темы и ключ', () => {
    expect(deriveBridgeKeys(a)).toEqual(deriveBridgeKeys(a));
  });

  it('темы команд и ответов различаются', () => {
    const k = deriveBridgeKeys(a);
    expect(k.commandTopic).not.toBe(k.replyTopic);
  });

  it('разные секреты дают разные темы', () => {
    expect(deriveBridgeKeys(a).commandTopic).not.toBe(deriveBridgeKeys(b).commandTopic);
  });

  it('тема не содержит самого секрета', () => {
    const k = deriveBridgeKeys(a);
    expect(k.commandTopic).not.toContain(bytesToBase64Url(a));
    expect(k.commandTopic).not.toContain('01010101');
  });

  it('секрет неверной длины отвергается, а не обрезается', () => {
    expect(() => deriveBridgeKeys(new Uint8Array(16))).toThrow();
  });
});

describe('мост: строка ключа доступа', () => {
  const secret = new Uint8Array(BRIDGE_SECRET_BYTES).fill(3);

  it('разбирается обратно вместе с адресом ретранслятора', () => {
    const parsed = parseAccessKey(formatAccessKey(secret, 'https://relay.example.invalid/ntfy'));
    expect(parsed).not.toBeNull();
    expect(Array.from(parsed!.secret)).toEqual(Array.from(secret));
    expect(parsed!.relayBase).toBe('https://relay.example.invalid/ntfy');
  });

  it('чужие строки не разбираются', () => {
    expect(parseAccessKey('')).toBeNull();
    expect(parseAccessKey('airchat-bridge://v1?k=короткий&r=https://x')).toBeNull();
    expect(parseAccessKey('https://example.invalid')).toBeNull();
  });
});

describe('мост: отзыв ключа', () => {
  it('новый секрет меняет тему и обнуляет счётчик команд', async () => {
    const first = await loadOrCreateBridgeSecret();
    await writeAcceptedSeq(17);
    expect(await readAcceptedSeq()).toBe(17);

    const second = await rotateBridgeSecret();
    expect(Array.from(second)).not.toEqual(Array.from(first));
    // Старый агент стучится в тему, которой больше нет.
    expect(deriveBridgeKeys(second).commandTopic).not.toBe(deriveBridgeKeys(first).commandTopic);
    expect(await readAcceptedSeq()).toBe(0);
    expect(Array.from((await loadBridgeSecret())!)).toEqual(Array.from(second));
  });

  it('испорченная запись не подменяется молча новой', async () => {
    mockSecure['airchat_agent_bridge_secret'] = bytesToBase64Url(new Uint8Array(8));
    expect(await loadBridgeSecret()).toBeNull();
  });
});
