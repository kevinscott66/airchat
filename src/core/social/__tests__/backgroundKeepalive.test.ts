/**
 * Тихий звук в фоне (v4.32.559).
 *
 * Проверяется не «дёрнули ли play», а состояние: играет ли дорожка сейчас и
 * согласована ли сессия. Ошибки здесь стоят дорого в обе стороны — молчание в
 * фоне означает пропущенный звонок, лишний звук означает съеденную батарею и
 * вторую руку на аудиосессии посреди разговора.
 */

type AppStateHandler = (s: string) => void;

let mockOS = 'ios';
let mockCurrentState = 'active';
const mockAppStateListeners: AppStateHandler[] = [];
let mockRemovedCount = 0;

jest.mock('react-native', () => ({
  get Platform() { return { OS: mockOS }; },
  AppState: {
    get currentState() { return mockCurrentState; },
    addEventListener: jest.fn((_ev: string, cb: AppStateHandler) => {
      mockAppStateListeners.push(cb);
      return { remove: () => { mockRemovedCount += 1; } };
    }),
  },
}));

type FakePlayer = {
  loop: boolean;
  playing: boolean;
  removed: boolean;
  play(): void;
  pause(): void;
  remove(): void;
};
const mockPlayers: FakePlayer[] = [];
const mockAudioModes: Array<Record<string, unknown>> = [];
let mockCreateThrows = false;

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => {
    if (mockCreateThrows) throw new Error('no audio session');
    const p: FakePlayer = {
      loop: false,
      playing: false,
      removed: false,
      play() { p.playing = true; },
      pause() { p.playing = false; },
      remove() { p.removed = true; p.playing = false; },
    };
    mockPlayers.push(p);
    return p;
  }),
  setAudioModeAsync: jest.fn(async (mode: Record<string, unknown>) => { mockAudioModes.push(mode); }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let mockKeepaliveKv: string | null = null;
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async () => mockKeepaliveKv),
}));

type CallInfoLike = { state: string } | null;
let mockCallListener: ((info: CallInfoLike) => void) | null = null;
jest.mock('../callService', () => ({
  subscribeCall: jest.fn((cb: (info: CallInfoLike) => void) => {
    mockCallListener = cb;
    cb(null);
    return () => { mockCallListener = null; };
  }),
}));

type Mod = typeof import('../backgroundKeepalive');

function load(): Mod {
  let mod!: Mod;
  jest.isolateModules(() => { mod = require('../backgroundKeepalive') as Mod; });
  return mod;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function toBackground(): Promise<void> {
  for (const cb of mockAppStateListeners) cb('background');
  await flush();
}

async function toForeground(): Promise<void> {
  for (const cb of mockAppStateListeners) cb('active');
  await flush();
}

beforeEach(() => {
  mockOS = 'ios';
  mockCurrentState = 'active';
  mockAppStateListeners.length = 0;
  mockRemovedCount = 0;
  mockPlayers.length = 0;
  mockAudioModes.length = 0;
  mockCreateThrows = false;
  mockKeepaliveKv = null;
  mockCallListener = null;
  jest.clearAllMocks();
});

describe('тихий звук в фоне', () => {
  it('на переднем плане не играет ничего', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    await flush();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);
    expect(mockPlayers).toHaveLength(0);
  });

  it('уход в фон поднимает дорожку, возврат её снимает', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    await toBackground();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(true);
    expect(mockPlayers).toHaveLength(1);
    expect(mockPlayers[0]).toMatchObject({ loop: true, playing: true });

    await toForeground();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);
    expect(mockPlayers[0]).toMatchObject({ playing: false, removed: true });
  });

  it('сессия просит фон и не глушит чужую музыку', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    await toBackground();
    expect(mockAudioModes[0]).toMatchObject({
      shouldPlayInBackground: true,
      playsInSilentMode: true,
      interruptionMode: 'mixWithOthers',
      allowsRecording: false,
    });
    // Возврат на передний план отпускает фоновую сессию.
    await toForeground();
    expect(mockAudioModes[mockAudioModes.length - 1]).toEqual({ shouldPlayInBackground: false });
  });

  it('повторный уход в фон не заводит второго игрока', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    await toBackground();
    await toBackground();
    expect(mockPlayers).toHaveLength(1);
  });

  it('во время разговора молчим: аудиосессией владеет звонок', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    mockCallListener?.({ state: 'connected' });
    await flush();
    await toBackground();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);

    // Разговор кончился — дорожка возвращается сама, приложение всё ещё в фоне.
    mockCallListener?.({ state: 'ended' });
    await flush();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(true);
  });

  it('дорожка, снятая ради звонка, не отбирает у него фоновую сессию', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    await toBackground();
    mockAudioModes.length = 0;
    mockCallListener?.({ state: 'connected' });
    await flush();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);
    expect(mockAudioModes).toHaveLength(0);
  });

  it('выключатель в настройках гасит дорожку и не даёт ей вернуться', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    await toBackground();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(true);

    mod.setBackgroundKeepaliveEnabled(false);
    await flush();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);

    await toForeground();
    await toBackground();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);

    mod.setBackgroundKeepaliveEnabled(true);
    await flush();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(true);
  });

  it('выключено в настройках с прошлого запуска — в фоне тихо', async () => {
    mockKeepaliveKv = 'false';
    const mod = load();
    await mod.initBackgroundKeepalive();
    await toBackground();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);
  });

  it('на Android не поднимается вовсе: там есть пуш', async () => {
    mockOS = 'android';
    const mod = load();
    await mod.initBackgroundKeepalive();
    expect(mockAppStateListeners).toHaveLength(0);
    await toBackground();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);
  });

  it('запуск в уже свёрнутом приложении начинает с дорожки', async () => {
    mockCurrentState = 'background';
    const mod = load();
    await mod.initBackgroundKeepalive();
    await flush();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(true);
  });

  it('отказ аудиосессии не роняет приложение', async () => {
    mockCreateThrows = true;
    const mod = load();
    await mod.initBackgroundKeepalive();
    await toBackground();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);
  });

  it('снятие подписок глушит дорожку', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    await toBackground();
    await mod.disposeBackgroundKeepalive();
    expect(mod.isBackgroundKeepaliveRunning()).toBe(false);
    expect(mockRemovedCount).toBe(1);
    expect(mockCallListener).toBeNull();
  });

  it('повторный init не заводит вторую подписку', async () => {
    const mod = load();
    await mod.initBackgroundKeepalive();
    await mod.initBackgroundKeepalive();
    expect(mockAppStateListeners).toHaveLength(1);
  });
});
