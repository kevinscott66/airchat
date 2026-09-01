/**
 * Секрет в буфере обмена уходит сам (v4.32.314).
 *
 * Проверяется не «вызвали ли setStringAsync», а состояние буфера: он здесь
 * настоящий — одна переменная, которую тест читает так же, как её прочитала бы
 * чужая клавиатура.
 */

let mockClipboard = '';
let mockClipboardReadable = true;
const mockAppStateListeners: ((s: string) => void)[] = [];
const mockRemoved: number[] = [];

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn((_ev: string, cb: (s: string) => void) => {
      mockAppStateListeners.push(cb);
      const idx = mockAppStateListeners.length - 1;
      return { remove: () => mockRemoved.push(idx) };
    }),
  },
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async (text: string) => {
    mockClipboard = text;
    return true;
  }),
  // Android 10+ не даёт читать буфер приложению не в фокусе и возвращает пустую строку.
  getStringAsync: jest.fn(async () => (mockClipboardReadable ? mockClipboard : '')),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Mod = typeof import('../clipboardSecret');

function load(): Mod {
  let mod!: Mod;
  jest.isolateModules(() => {
    mod = require('../clipboardSecret');
  });
  return mod;
}

/** Отдать очередь микрозадач: sweep асинхронный, а таймер его только запускает. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const SEED = 'ability tornado sample gossip pear velvet whale jungle rocket cabin oyster admit';

describe('секрет в буфере обмена', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockClipboard = '';
    mockClipboardReadable = true;
    mockAppStateListeners.length = 0;
    mockRemoved.length = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('кладёт секрет в буфер и убирает его по истечении срока', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);
    expect(mockClipboard).toBe(SEED);

    jest.advanceTimersByTime(60_000);
    await settle();

    expect(mockClipboard).not.toContain('tornado');
    expect(mockClipboard.trim()).toBe('');
  });

  it('до срока секрет остаётся на месте — его ещё вставляют', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);

    jest.advanceTimersByTime(59_000);
    await settle();

    expect(mockClipboard).toBe(SEED);
  });

  it('не трогает буфер, если человек успел скопировать своё', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);
    mockClipboard = 'https://example.org/статья';

    jest.advanceTimersByTime(60_000);
    await settle();

    expect(mockClipboard).toBe('https://example.org/статья');
  });

  it('дочищает при возвращении в приложение, если в фоне буфер прочитать не дали', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);

    // Ушли вставлять фразу в заметки: таймер сработал, а буфер недоступен.
    mockClipboardReadable = false;
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(mockClipboard).toBe(SEED);

    // Вернулись.
    mockClipboardReadable = true;
    expect(mockAppStateListeners.length).toBe(1);
    mockAppStateListeners[0]('active');
    await settle();

    expect(mockClipboard.trim()).toBe('');
  });

  it('перестаёт пытаться и снимает подписку, если так и не смогли убрать', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);

    mockClipboardReadable = false;
    jest.advanceTimersByTime(60_000);
    await settle();

    // Прошло больше отведённого на попытки: буфер давно не наш, ждать нечего.
    jest.advanceTimersByTime(11 * 60_000);
    mockAppStateListeners[0]('active');
    await settle();
    expect(mockRemoved).toEqual([0]);

    // Дальнейшие возвращения в приложение ничего не переписывают.
    mockClipboardReadable = true;
    mockClipboard = 'что-то своё';
    mockAppStateListeners[0]('active');
    await settle();
    expect(mockClipboard).toBe('что-то своё');
  });

  it('полный сброс убирает секрет сразу, не дожидаясь срока', async () => {
    const { copySecretToClipboard, clearSecretClipboardNow } = load();
    await copySecretToClipboard(SEED, 60_000);

    await clearSecretClipboardNow();

    expect(mockClipboard.trim()).toBe('');
  });

  it('сброс без скопированного секрета чужой буфер не трогает', async () => {
    const { clearSecretClipboardNow } = load();
    mockClipboard = 'рабочая ссылка';

    await clearSecretClipboardNow();

    expect(mockClipboard).toBe('рабочая ссылка');
  });

  it('повторное копирование не оставляет позади лишних подписок и таймеров', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);
    jest.advanceTimersByTime(30_000);
    await copySecretToClipboard(SEED, 60_000);

    expect(mockAppStateListeners.length).toBe(1);

    // Первый таймер снят: на его срок уборка не приходит.
    jest.advanceTimersByTime(30_000);
    await settle();
    expect(mockClipboard).toBe(SEED);

    jest.advanceTimersByTime(30_000);
    await settle();
    expect(mockClipboard.trim()).toBe('');
  });
});
