/**
 * Ключ моста агента уходит из буфера сам (v4.32.839).
 *
 * Дефект. `airchat-bridge://v1?k=…&r=…` — предъявительский мандат: в строке
 * лежит и секрет целиком, и адрес ретранслятора, и кто её прочитал, тот
 * включает туннель, читает и переписывает настройки телефона. Кнопка
 * «Копировать ключ» клала эту строку в буфер простой записью и оставляла там
 * навсегда. Уборщик для ровно такого случая живёт в приложении с v4.32.314
 * (`copySecretToClipboard`, уборка переживает снятие приложения с v4.32.834),
 * и пользовалась им одна seed-фраза.
 *
 * Цена. Буфер общий на всё устройство, а на Apple — ещё и общий между
 * устройствами одного Apple ID. Мандат лежит в нём до следующего копирования:
 * его видит клавиатура, системный менеджер буфера и связка с компьютером.
 * Предупреждение на экране просило человека убрать за собой вручную —
 * «сразу после вставки скопируйте что-нибудь другое», — то есть перекладывало
 * на него работу, которую приложение умеет делать само, и делало это ровно в
 * ту минуту, когда человек занят вставкой ключа агенту.
 *
 * Правка. Копия с истечением, как у seed-фразы, и подтверждение, которое про
 * срок говорит вслух (`COPIED_WITH_SWEEP`). Предупреждение переписано: оно
 * больше не поручает уборку человеку, но и не обещает, что минуту можно не
 * считать.
 *
 * Буфер здесь настоящий — одна переменная, которую тест читает так же, как её
 * прочитала бы чужая клавиатура.
 */

import fs from 'fs';
import path from 'path';

let mockClipboard = '';
let mockClipboardReadable = true;
const mockAppStateListeners: ((s: string) => void)[] = [];

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn((_ev: string, cb: (s: string) => void) => {
      mockAppStateListeners.push(cb);
      return { remove: jest.fn() };
    }),
  },
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async (text: string) => {
    mockClipboard = text;
    return true;
  }),
  getStringAsync: jest.fn(async () => (mockClipboardReadable ? mockClipboard : '')),
}));

jest.mock('../../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** Диск: переживает перезагрузку модуля так же, как kv переживает снятие приложения. */
const mockKv = new Map<string, string>();

jest.mock('../../../core/storage/local', () => ({
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  }),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvDelete: jest.fn(async (k: string) => {
    mockKv.delete(k);
  }),
}));

/** Секрет моста лежит в SecureStore; здесь он не нужен — ключ собираем руками. */
jest.mock('../../../core/storage/secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

import { formatAccessKey, parseAccessKey } from '../../../core/bridge/agentBridgeKeys';
import { COPIED_TEXT, COPIED_WITH_SWEEP } from '../../clipboardText';

type Mod = typeof import('../../../core/security/clipboardSecret');

function load(): Mod {
  let mod!: Mod;
  jest.isolateModules(() => {
    mod = require('../../../core/security/clipboardSecret');
  });
  return mod;
}

/** Отдать очередь микрозадач: уборка асинхронная, таймер её только запускает. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Снятие из многозадачности: таймеры и подписки умирают вместе с процессом. */
function kill(): void {
  jest.clearAllTimers();
  mockAppStateListeners.length = 0;
}

const SECRET = new Uint8Array(32).map((_v, i) => (i * 7 + 13) & 0xff);
const RELAY = 'https://ntfy.example.org';
const KEY = formatAccessKey(SECRET, RELAY);

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где сказано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

/** Вырезать тело названной функции — пин не должен ловить однофамильца. */
const bodyAt = (s: string, needle: string, len: number): string => {
  const at = s.indexOf(needle);
  expect(at).toBeGreaterThan(0);
  return s.slice(at, at + len);
};

describe('мандат не остаётся в буфере', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockClipboard = '';
    mockClipboardReadable = true;
    mockAppStateListeners.length = 0;
    mockKv.clear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ключ ложится в буфер и уходит из него по истечении срока', async () => {
    const { copySecretToClipboard, SECRET_CLIPBOARD_TTL_MS } = load();
    await copySecretToClipboard(KEY);

    // ПРОВЕРКА НЕ ПУСТАЯ: до срока ключ на месте — его в эту минуту и вставляют,
    // и вставляют целиком, а не огрызок.
    expect(mockClipboard).toBe(KEY);
    expect(parseAccessKey(mockClipboard)?.relayBase).toBe(RELAY);

    jest.advanceTimersByTime(SECRET_CLIPBOARD_TTL_MS);
    await settle();

    expect(mockClipboard.trim()).toBe('');
    expect(parseAccessKey(mockClipboard)).toBeNull();
  });

  it('свою ссылку, скопированную поверх, не трогают', async () => {
    const { copySecretToClipboard, SECRET_CLIPBOARD_TTL_MS } = load();
    await copySecretToClipboard(KEY);
    mockClipboard = 'https://example.org/статья';

    jest.advanceTimersByTime(SECRET_CLIPBOARD_TTL_MS);
    await settle();

    expect(mockClipboard).toBe('https://example.org/статья');
  });

  it('ушли отдавать ключ агенту и приложение сняли — уберут на следующем запуске', async () => {
    const first = load();
    await first.copySecretToClipboard(KEY);

    kill();
    jest.advanceTimersByTime(30 * 60_000);
    const second = load();
    await second.resumeSecretClipboardSweep();
    await settle();

    expect(mockClipboard.trim()).toBe('');
  });

  it('на диск не ложится ни секрет, ни адрес — только отпечаток', async () => {
    const { copySecretToClipboard } = load();
    await copySecretToClipboard(KEY);

    const shelved = [...mockKv.values()].join('|');
    expect(shelved).not.toBe('');
    expect(shelved).not.toContain('airchat-bridge');
    expect(shelved).not.toContain(RELAY);
    expect(shelved).not.toContain(KEY.slice(KEY.indexOf('k=') + 2, KEY.indexOf('&r=')));
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockClipboard = '';
    mockClipboardReadable = true;
    mockAppStateListeners.length = 0;
    mockKv.clear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('в строке лежит сам секрет: кто её прочитал, тот и управляет телефоном', () => {
    const parsed = parseAccessKey(KEY);
    expect(parsed).not.toBeNull();
    expect([...(parsed as { secret: Uint8Array }).secret]).toEqual([...SECRET]);
    expect((parsed as { relayBase: string }).relayBase).toBe(RELAY);
  });

  it('простая запись оставляла бы мандат в буфере навсегда', async () => {
    // Прежняя форма вызова, слово в слово: `await Clipboard.setStringAsync(accessKey)`.
    const Clipboard = require('expo-clipboard') as { setStringAsync: (s: string) => Promise<boolean> };
    load(); // уборщик поднят, но его никто не звал — некому и убирать
    await Clipboard.setStringAsync(KEY);

    jest.advanceTimersByTime(24 * 60 * 60_000);
    await settle();

    expect(mockClipboard).toBe(KEY);
    expect(parseAccessKey(mockClipboard)).not.toBeNull();
  });

  it('seed-фраза этой дорогой ходит с v4.32.314 — уборщик не пришлось писать', () => {
    const settings = read('ui', 'screens', 'SettingsScreen.tsx');
    expect(settings).toContain('copySecretToClipboard(seedPhrase)');
  });

  it('срок уборки короче, чем поход к агенту, но он есть', () => {
    const mod = read('core', 'security', 'clipboardSecret.ts');
    expect(mod).toContain('export const SECRET_CLIPBOARD_TTL_MS = 60_000;');
  });
});

describe('форма исходников', () => {
  const SEC = codeOnly(read('ui', 'components', 'AgentBridgeSettingsSection.tsx'));
  const RAW = read('ui', 'components', 'AgentBridgeSettingsSection.tsx');

  it('копирование ключа идёт через копию с истечением', () => {
    const body = bodyAt(SEC, 'const copyKey = useCallback(async () => {', 900);
    expect(body).toContain('await copySecretToClipboard(accessKey);');
    expect(SEC).toContain(
      "import { copySecretToClipboard } from '../../core/security/clipboardSecret';",
    );
  });

  it('прямой записи в буфер в этом разделе не осталось', () => {
    expect(SEC).not.toContain("from 'expo-clipboard'");
    expect(SEC).not.toContain('Clipboard.setStringAsync(');
  });

  it('подтверждение говорит про срок, и слово на всех одно', () => {
    expect(bodyAt(SEC, 'const copyKey = useCallback(async () => {', 900)).toContain(
      'showSuccess(COPIED_WITH_SWEEP);',
    );
    // Второй ходок той же дорогой — seed-фраза — берёт тот же текст, а не свой
    // литерал: до этой версии фраза стояла у неё прямо в вызове.
    const settings = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
    expect(settings).toContain('showSuccess(COPIED_WITH_SWEEP);');
    expect(settings).not.toContain('буфер очистится через минуту`');
    expect(COPIED_WITH_SWEEP.startsWith(COPIED_TEXT)).toBe(true);
    expect(codeOnly(read('ui', 'clipboardText.ts'))).toContain(
      'export const COPIED_WITH_SWEEP = ',
    );
  });

  it('предупреждение больше не поручает уборку человеку', () => {
    expect(RAW).toContain('Ключ уйдёт в буфер обмена');
    expect(RAW).not.toContain('Сразу после вставки скопируйте что-нибудь другое');
    // Но и не обещает, что минуту можно не считать: прочитанное за неё не отозвать.
    expect(RAW).toContain('Через минуту буфер очистится сам');
  });
});
