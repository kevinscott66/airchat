/**
 * Замок приложения и баннер, пришедший в свёрнутое приложение (v4.32.858).
 *
 * Дефект. Содержимое баннера закрывает `previewAllowed`, и спрашивает он
 * `isSessionUnlocked` — «заперта ли сессия сейчас». Запирает же её App.tsx
 * только при ВОЗВРАЩЕНИИ в приложение: вся ветка с `lockSession` живёт внутри
 * `nextState === 'active'`. Пока телефон в кармане, сессия числится открытой.
 *
 * Цена. Баннеры приходят ровно тогда, когда приложение свёрнуто. Человек
 * включал автоблокировку, закрывал переписку, убирал телефон — и следующее
 * сообщение выкладывало имя собеседника и текст на заблокированный экран, где
 * они оставались до утра. Замок срабатывал позже, при возвращении, когда
 * читать было уже поздно и не тому. Проверка v4.32.614 этого не поймала:
 * в ней сессия заперта заранее, то есть проверялось следствие, а не случай.
 *
 * Правка. Вопрос поставлен так, как его задаёт себе человек: запрётся ли
 * приложение к тому моменту, когда телефон возьмут в руки. Приложение не на
 * переднем плане, замок на выходе включён, пароль заведён — содержимое не
 * показываем. Задержка автоблокировки не смотрится намеренно: она про
 * возвращение в приложение, а баннер на экране блокировки переживёт любую.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../core/storage/secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../../core/config', () => ({ loadConfig: jest.fn(async () => ({})) }));
jest.mock('../../core/social/messaging', () => ({
  getMessagingService: jest.fn(() => null),
  subscribeInAppNotifications: jest.fn(() => () => undefined),
}));
jest.mock('../../core/social/groupMessaging', () => ({
  setGroupMessageNotifyCallback: jest.fn(),
}));
jest.mock('../../core/social/contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../../core/notifications/muteStore', () => ({ isMuted: jest.fn(async () => false) }));
jest.mock('../openIntent', () => ({
  deliverOpenIntent: jest.fn(),
  parseCallOpenIntent: jest.fn(() => null),
  parseChatOpenIntent: jest.fn(() => null),
  parseOpenIntent: jest.fn(() => null),
}));
jest.mock('../pushEnvelope', () => ({
  peerIdFromDid: jest.fn(() => 'peer'),
  signPushPayload: jest.fn(async () => ''),
}));

const mockKv = new Map<string, string>();
let mockKvUnreadable = false;
let mockKvThrows = false;
jest.mock('../../core/storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => {
    if (mockKvThrows) throw new Error('база закрыта');
    return mockKvUnreadable ? null : { value: mockKv.get(k) ?? null };
  }),
  kvSet: jest.fn(async () => undefined),
}));

let mockSessionUnlocked = true;
let mockHasPassword = true;
let mockPasswordThrows = false;
jest.mock('../../core/security/authGuard', () => ({
  authGuard: {
    isSessionUnlocked: jest.fn(() => mockSessionUnlocked),
    hasPassword: jest.fn(async () => {
      if (mockPasswordThrows) throw new Error('хранилище ключей заперто');
      return mockHasPassword;
    }),
  },
}));

const mockDisplay = jest.fn(async (opts: { title: string; body: string }) => opts);
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: { displayNotification: mockDisplay, createChannel: jest.fn(async () => 'c') },
  AndroidImportance: { HIGH: 4, MIN: 1 },
  AndroidCategory: { CALL: 'call' },
}));

import { AppState } from 'react-native';

import { notifyFeedEvent } from '../pushNotifications';

const SRC = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
const PUSH = fs.readFileSync(path.join(SRC, 'notifications', 'pushNotifications.ts'), 'utf8');
const BACKGROUND = fs.readFileSync(path.join(SRC, 'firebaseMessagingBackground.ts'), 'utf8');

const EVENT = { title: 'Аня', body: 'новая запись про кота', postId: 'p1', kind: 'post' as const };

/** Состояние приложения в тестовой среде не задано вовсе — задаём явно. */
function setAppState(state: string | null): void {
  (AppState as unknown as { currentState: string | null }).currentState = state;
}

/** Показанный баннер: своё содержимое или безличное. */
async function shownBanner(): Promise<{ title: string; body: string }> {
  await notifyFeedEvent(EVENT);
  return mockDisplay.mock.calls[0][0];
}

beforeEach(() => {
  mockDisplay.mockClear();
  mockKv.clear();
  mockKvUnreadable = false;
  mockKvThrows = false;
  mockSessionUnlocked = true;
  mockHasPassword = true;
  mockPasswordThrows = false;
  setAppState('active');
  mockKv.set('auto_lock_on_exit', 'true');
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('приложение открыто — имя и текст на месте', async () => {
    const shown = await shownBanner();
    expect(shown.title).toBe('Аня');
    expect(shown.body).toBe('новая запись про кота');
  });

  it('запертая сессия по-прежнему гасит содержимое', async () => {
    mockSessionUnlocked = false;
    const shown = await shownBanner();
    expect(shown.title).toBe('AirChat');
    expect(shown.body).toBe('Новая публикация');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('при сворачивании App.tsx только запоминает время — запирать некому', () => {
    expect(APP).toContain(
      "if (nextState === 'background' || nextState === 'inactive') {\n        backgroundedAtRef.ts = Date.now();\n      } else if (nextState === 'active') {"
    );
  });

  it('во всём обработчике состояния запирание одно и живёт в ветке возвращения', () => {
    // Второе `lockSession` в App.tsx — стартовая проверка пароля при запуске,
    // к сворачиванию отношения не имеет. Смотрим ровно на тот useEffect,
    // который слушает AppState: от его заголовка до следующего useEffect.
    const from = APP.indexOf('// Автоблокировка при сворачивании приложения');
    expect(from).toBeGreaterThan(0);
    const next = APP.indexOf('useEffect(', APP.indexOf('useEffect(', from) + 1);
    const effect = APP.slice(from, next);
    expect(effect).toContain("AppState.addEventListener('change'");
    expect(effect.match(/authGuard\.lockSession\(\)/g)).toHaveLength(1);
    const returned = effect.indexOf("if (nextState === 'active' && backgroundedAtRef.ts > 0)");
    expect(returned).toBeGreaterThan(0);
    expect(effect.indexOf('authGuard.lockSession()')).toBeGreaterThan(returned);
  });

  it('баннер показывается и когда приложения нет в живых вовсе', () => {
    expect(BACKGROUND).toContain('notifee.displayNotification(');
  });

  it('содержимое всех баннеров решает одно место', () => {
    expect(PUSH.match(/kvGet\('notify_preview'\)/g)).toHaveLength(1);
    expect(PUSH.match(/const preview = await previewAllowed\(\);/g)).toHaveLength(3);
  });
});

describe('приложение свёрнуто, а замок включён', () => {
  it('имени и текста в баннере нет', async () => {
    setAppState('background');
    const shown = await shownBanner();
    expect(shown.title).toBe('AirChat');
    expect(shown.body).toBe('Новая публикация');
  });

  it('уведомление при этом никуда не девается', async () => {
    setAppState('background');
    await notifyFeedEvent(EVENT);
    expect(mockDisplay).toHaveBeenCalledTimes(1);
  });

  it('промежуточное inactive — тоже не передний план', async () => {
    setAppState('inactive');
    expect((await shownBanner()).title).toBe('AirChat');
  });

  it('состояния нет вовсе (фоновый запуск JS) — считаем, что приложение закрыто', async () => {
    setAppState(null);
    expect((await shownBanner()).title).toBe('AirChat');
  });

  it('задержка замка на баннер не влияет: он дождётся любой', async () => {
    setAppState('background');
    mockKv.set('auto_lock_delay_ms', '1800000');
    expect((await shownBanner()).title).toBe('AirChat');
  });
});

describe('свёрнуто, но запираться нечему', () => {
  it('замок на выходе выключен — человек сам оставил приложение открытым', async () => {
    setAppState('background');
    mockKv.set('auto_lock_on_exit', 'false');
    const shown = await shownBanner();
    expect(shown.title).toBe('Аня');
    expect(shown.body).toBe('новая запись про кота');
  });

  it('пароля нет — запирать нечем, прятать не от кого', async () => {
    setAppState('background');
    mockHasPassword = false;
    expect((await shownBanner()).title).toBe('Аня');
  });
});

describe('спорные ответы решаются в пользу замка', () => {
  it('настройка не прочиталась — это не «замок выключен»', async () => {
    setAppState('background');
    mockKvUnreadable = true;
    expect((await shownBanner()).title).toBe('AirChat');
  });

  it('база ответила исключением — тоже прячем', async () => {
    setAppState('background');
    mockKvThrows = true;
    expect((await shownBanner()).title).toBe('AirChat');
  });

  it('хранилище ключей заперто — прячем, это и есть опасный момент', async () => {
    setAppState('background');
    mockPasswordThrows = true;
    expect((await shownBanner()).title).toBe('AirChat');
  });
});

describe('внутри приложения ничего не изменилось', () => {
  it('замок включён и пароль есть, но приложение открыто — содержимое на месте', async () => {
    const shown = await shownBanner();
    expect(shown.title).toBe('Аня');
  });

  it('выключенная настройка гасит содержимое и на переднем плане', async () => {
    mockKv.set('notify_preview', 'false');
    expect((await shownBanner()).title).toBe('AirChat');
  });
});
