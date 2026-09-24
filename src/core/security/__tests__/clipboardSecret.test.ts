/**
 * Секрет в буфере обмена уходит сам (v4.32.314).
 *
 * Проверяется не «вызвали ли setStringAsync», а состояние буфера: он здесь
 * настоящий — одна переменная, которую тест читает так же, как её прочитала бы
 * чужая клавиатура.
 */

import fs from 'fs';
import path from 'path';

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

/**
 * Диск. Переживает перезагрузку модуля — ровно тем же способом, каким kv
 * переживает снятие приложения: он снаружи процесса, который его читает.
 */
const mockKv = new Map<string, string>();
let mockKvWritable = true;

jest.mock('../../storage/local', () => ({
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (!mockKvWritable) return false;
    mockKv.set(k, v);
    return true;
  }),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvDelete: jest.fn(async (k: string) => {
    mockKv.delete(k);
  }),
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
    mockKv.clear();
    mockKvWritable = true;
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

/**
 * Уборка переживает снятие приложения (v4.32.834).
 *
 * Дефект. Вся память об отложенной уборке — переменная в модуле. Снятие из
 * многозадачности её не переживало, а сценарий, ради которого модуль написан,
 * — «скопировал и ушёл вставлять в менеджер паролей» — это ровно уход из
 * приложения, то есть та самая секунда, когда система выгружает фоновое.
 *
 * Цена. Двенадцать слов остаются в буфере навсегда. Их читает клавиатура,
 * системный менеджер буфера и связка с компьютером; из них восстанавливается
 * личность целиком, и отозвать их нельзя — ключи не меняются.
 *
 * Правка. Рядом с копией на диск ложится расписка: отпечаток и срок. Сам
 * секрет на диск не идёт. Следующий запуск расписку поднимает и продолжает с
 * того же места — с обоими прежними правилами: чужого не трогаем, нечитаемый
 * буфер ждём.
 */
describe('уборка переживает снятие приложения', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockClipboard = '';
    mockClipboardReadable = true;
    mockAppStateListeners.length = 0;
    mockRemoved.length = 0;
    mockKv.clear();
    mockKvWritable = true;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Снятие из многозадачности: таймеры и подписки умирают вместе с процессом.
   *
   * Зовётся ДО того, как двигать часы. Иначе уборку доделает таймер убитого
   * процесса — и стенд проверит ровно то, чего на устройстве уже нет.
   */
  function kill(): void {
    jest.clearAllTimers();
    mockAppStateListeners.length = 0;
    mockRemoved.length = 0;
  }

  it('секрет, скопированный перед снятием, убирают на следующем запуске', async () => {
    const first = load();
    await first.copySecretToClipboard(SEED, 60_000);
    expect(mockClipboard).toBe(SEED);

    // Ушли вставлять фразу — приложение сняли на тридцатой секунде.
    kill();
    jest.advanceTimersByTime(30_000);
    const second = load();
    await second.resumeSecretClipboardSweep();

    // Срок ещё не вышел: фразу, может, прямо сейчас и вставляют.
    expect(mockClipboard).toBe(SEED);

    jest.advanceTimersByTime(30_000);
    await settle();
    expect(mockClipboard).not.toContain('tornado');
    expect(mockClipboard.trim()).toBe('');
  });

  it('если запуск случился уже после срока — убирают сразу', async () => {
    const first = load();
    await first.copySecretToClipboard(SEED, 60_000);
    kill();
    jest.advanceTimersByTime(90_000);

    const second = load();
    await second.resumeSecretClipboardSweep();

    expect(mockClipboard.trim()).toBe('');
  });

  it('на диск не ложатся сами слова — только отпечаток', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);

    const shelved = [...mockKv.values()].join('|');
    expect(shelved).not.toBe('');
    for (const word of SEED.split(' ')) expect(shelved).not.toContain(word);
    const { h } = JSON.parse(shelved) as { h: string };
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('чужой буфер после перезапуска не трогают, и расписку снимают', async () => {
    const first = load();
    await first.copySecretToClipboard(SEED, 60_000);
    kill();
    jest.advanceTimersByTime(90_000);
    mockClipboard = 'https://example.org/статья';

    const second = load();
    await second.resumeSecretClipboardSweep();

    expect(mockClipboard).toBe('https://example.org/статья');
    expect(mockKv.size).toBe(0);
  });

  it('убрали — расписка снята: следующий запуск уже ничего не ищет', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);
    expect(mockKv.size).toBe(1);

    jest.advanceTimersByTime(60_000);
    await settle();
    expect(mockKv.size).toBe(0);
  });

  it('долгий перерыв не отменяет попытку: срок отмеряют от запуска', async () => {
    const first = load();
    await first.copySecretToClipboard(SEED, 60_000);
    // Приложением не пользовались двое суток. Фраза всё это время в буфере.
    kill();
    jest.advanceTimersByTime(48 * 60 * 60_000);

    const second = load();
    // Первые мгновения после запуска буфер читать не дают.
    mockClipboardReadable = false;
    await second.resumeSecretClipboardSweep();

    // Сдаваться нечего: отсчёт «сколько ждём доступа» идёт от этого запуска.
    expect(mockRemoved).toEqual([]);
    expect(mockAppStateListeners.length).toBe(1);

    mockClipboardReadable = true;
    mockAppStateListeners[0]('active');
    await settle();
    expect(mockClipboard.trim()).toBe('');
  });

  it('полный сброс поднимает расписку с диска, а не только из памяти', async () => {
    const first = load();
    await first.copySecretToClipboard(SEED, 60_000);

    kill();
    const second = load();
    await second.clearSecretClipboardNow();

    expect(mockClipboard.trim()).toBe('');
    expect(mockKv.size).toBe(0);
  });

  it('расписка не легла — копия всё равно состоялась и убирается по таймеру', async () => {
    mockKvWritable = false;
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(SEED, 60_000);

    expect(mockClipboard).toBe(SEED);
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(mockClipboard.trim()).toBe('');
  });

  describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
    it('расписки нет — запуск чужой буфер не трогает', async () => {
      const mod = load();
      mockClipboard = 'рабочая ссылка';

      await mod.resumeSecretClipboardSweep();

      expect(mockClipboard).toBe('рабочая ссылка');
      expect(mockAppStateListeners.length).toBe(0);
    });

    it('испорченная расписка — то же самое, что её отсутствие', async () => {
      mockKv.set('clipboard_secret_sweep', 'не json');
      const mod = load();
      mockClipboard = SEED;

      await mod.resumeSecretClipboardSweep();

      expect(mockClipboard).toBe(SEED);
    });
  });

  describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
    const read = (...parts: string[]): string =>
      fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

    it('на кону вся фраза целиком, а не её часть', () => {
      const settings = read('ui', 'screens', 'SettingsScreen.tsx');
      expect(settings).toContain('copySecretToClipboard(seedPhrase)');
      // Рядом стоит показ тех же слов — значит, копируется именно секрет.
      expect(settings).toContain('<Text style={styles.seedText}>{seedPhrase}</Text>');
    });

    it('сроки короче, чем поход в менеджер паролей', () => {
      const mod = read('core', 'security', 'clipboardSecret.ts');
      expect(mod).toContain('export const SECRET_CLIPBOARD_TTL_MS = 60_000;');
      expect(mod).toContain('const GIVE_UP_MS = 10 * 60_000;');
      // Минута до уборки и десять минут на попытки — оба срока целиком
      // укладываются в один уход из приложения, то есть в одну выгрузку.
    });

    it('сброс устройства на эту уборку рассчитывает', () => {
      const wipe = read('core', 'wallet', 'wipeLocalWallet.ts');
      expect(wipe).toContain('clearSecretClipboardNow()');
    });
  });

  describe('форма исходников', () => {
    const read = (...parts: string[]): string =>
      fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

    it('запуск приложения расписку поднимает — иначе её некому прочитать', () => {
      const app = read('App.tsx');
      expect(app).toContain("import('./core/security/clipboardSecret')");
      expect(app).toContain('m.resumeSecretClipboardSweep()');
    });

    it('сброс устройства зовёт уборку, пока местная база ещё открыта', () => {
      const wipe = read('core', 'wallet', 'wipeLocalWallet.ts');
      const clip = wipe.indexOf("await step('clipboard'");
      const close = wipe.indexOf("await step('close_databases'");
      const wipeDb = wipe.indexOf("await step('local_db'");
      expect(clip).toBeGreaterThan(0);
      expect(close).toBeGreaterThan(clip);
      expect(wipeDb).toBeGreaterThan(clip);
    });

    it('кнопка «Копировать» под фразой отвечает и на отказ', () => {
      const settings = read('ui', 'screens', 'SettingsScreen.tsx');
      const at = settings.indexOf('await copySecretToClipboard(seedPhrase);');
      expect(at).toBeGreaterThan(0);
      const around = settings.slice(at - 400, at + 300);
      expect(around).toContain('runGuardedOp(async () => {');
      expect(around).toContain('COPY_FAILED');
    });
  });
});
