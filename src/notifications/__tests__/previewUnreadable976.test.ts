/**
 * Нечитаемая настройка «Показывать содержимое» и баннер (v4.32.976).
 *
 * Дефект. Содержимое баннера решает `previewAllowed`, и настройку он читал
 * `kvGet`. Тот складывает три ответа хранилища в два: «настройки нет» и
 * «прочитать не смогли» возвращаются одинаковым `null` (local.ts —
 * `return (await kvTryGet(key))?.value ?? null;`). Условие написано как
 * сравнение со строкой `'false'`, и при `null` оно ложно в обоих случаях,
 * то есть неясность решалась в пользу показа.
 *
 * Цена. Человек выключил «Показывать содержимое», пароля в приложении не
 * заводил — значит `lockAwaitsReturn` его не прикроет. Осечка SQLite (в том же
 * файле рядом специально логируется `ui_kv_get_slow` на блокировках в
 * секунды) — и на экран блокировки выкладывается имя отправителя и текст
 * сообщения при выключенной на вид настройке. Объяснить это нельзя и повторить
 * тоже: следующее сообщение прочитает базу и придёт безличным.
 *
 * Правка. Настройка читается `kvTryGet`, и «не прочитали» — отдельный ответ:
 * содержимое не показываем. Ровно так поступают соседи, у которых цена ошибки
 * та же: `lockAwaitsReturn` в этом же файле и `reminderPreviewAllowed` в
 * напоминаниях.
 *
 * Границы. Правило не распространяется на звук, вибрацию и «Не беспокоить»:
 * там цена ошибки обратная — молча съеденное уведомление, — и нечитаемость
 * по-прежнему решается в пользу показа. Подмена хранилища здесь наружу не
 * бросает, потому что и настоящий `kvTryGet` не бросает: он ловит сам и
 * отвечает `null`. Нечитаемость изображается этим `null`, как в жизни.
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
/** Осечка чтения — одна на обе формы, как в жизни: `kvGet` зовёт `kvTryGet`. */
let mockKvUnreadable = false;
jest.mock('../../core/storage/local', () => ({
  kvTryGet: jest.fn(async (k: string) => (mockKvUnreadable ? null : { value: mockKv.get(k) ?? null })),
  kvGet: jest.fn(async (k: string) => (mockKvUnreadable ? null : (mockKv.get(k) ?? null))),
  kvSet: jest.fn(async () => undefined),
  kvSetChecked: jest.fn(async () => undefined),
}));

let mockHasPassword = false;
jest.mock('../../core/security/authGuard', () => ({
  authGuard: {
    isSessionUnlocked: jest.fn(() => true),
    hasPassword: jest.fn(async () => mockHasPassword),
  },
}));

type Shown = {
  title: string;
  body: string;
  android: { sound?: string; vibrationPattern?: number[] };
};
const mockDisplay = jest.fn(async (opts: Shown) => opts);
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: { displayNotification: mockDisplay, createChannel: jest.fn(async () => 'c') },
  AndroidImportance: { HIGH: 4, MIN: 1 },
  AndroidCategory: { CALL: 'call' },
}));

import { AppState } from 'react-native';

import { notifyFeedEvent } from '../pushNotifications';

const SRC = path.join(__dirname, '..', '..');
const PUSH = fs.readFileSync(path.join(SRC, 'notifications', 'pushNotifications.ts'), 'utf8');
const REMINDER = fs.readFileSync(path.join(SRC, 'notifications', 'reminderNotifications.ts'), 'utf8');
const LOCAL = fs.readFileSync(path.join(SRC, 'core', 'storage', 'local.ts'), 'utf8');

/** Только код: пересказ в комментарии не должен закрывать закрепку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const EVENT = { title: 'Аня', body: 'новая запись про кота', postId: 'p1', kind: 'post' as const };

/** Состояние приложения в тестовой среде не задано вовсе — задаём явно. */
function setAppState(state: string | null): void {
  (AppState as unknown as { currentState: string | null }).currentState = state;
}

/** Показанный баннер: своё содержимое или безличное. */
async function shownBanner(): Promise<Shown> {
  await notifyFeedEvent(EVENT);
  return mockDisplay.mock.calls[0][0];
}

beforeEach(() => {
  mockDisplay.mockClear();
  mockKv.clear();
  mockKvUnreadable = false;
  mockHasPassword = false;
  setAppState('active');
});

describe('настройку не прочитали', () => {
  it('это не «настройки нет»: имени и текста в баннере нет', async () => {
    mockKvUnreadable = true;
    const shown = await shownBanner();
    expect(shown.title).toBe('AirChat');
    expect(shown.body).toBe('Новая публикация');
  });

  it('само уведомление при этом никуда не девается', async () => {
    mockKvUnreadable = true;
    await notifyFeedEvent(EVENT);
    expect(mockDisplay).toHaveBeenCalledTimes(1);
  });

  it('ГРАНИЦА: звук и вибрация нечитаемости не боятся', async () => {
    mockKvUnreadable = true;
    const shown = await shownBanner();
    // Цена ошибки обратная: беззвучный баннер человек попросту не заметит.
    expect(shown.android.sound).toBe('default');
    expect(shown.android.vibrationPattern).toBeDefined();
  });

  it('ГРАНИЦА: тишина «не беспокоить» сама собой не включается', async () => {
    mockKvUnreadable = true;
    // Спрятать уведомление целиком дороже, чем показать его безличным.
    await notifyFeedEvent(EVENT);
    expect(mockDisplay).toHaveBeenCalledTimes(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('база читается, настройки нет — содержимое на месте', async () => {
    const shown = await shownBanner();
    expect(shown.title).toBe('Аня');
    expect(shown.body).toBe('новая запись про кота');
  });

  it('настройка выключена — содержимое гасится, как и прежде', async () => {
    mockKv.set('notify_preview', 'false');
    expect((await shownBanner()).title).toBe('AirChat');
  });

  it('настройка включена явно — содержимое на месте', async () => {
    mockKv.set('notify_preview', 'true');
    expect((await shownBanner()).title).toBe('Аня');
  });

  it('свёрнутое приложение с замком по-прежнему прячет содержимое', async () => {
    setAppState('background');
    mockKv.set('auto_lock_on_exit', 'true');
    mockHasPassword = true;
    expect((await shownBanner()).title).toBe('AirChat');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('kvGet по-прежнему складывает три ответа в два', () => {
    expect(codeOnly(LOCAL)).toContain('return (await kvTryGet(key))?.value ?? null;');
  });

  it('напоминания читают ту же настройку с разбором трёх ответов', () => {
    expect(codeOnly(REMINDER)).toContain("const cell = await kvTryGet('notify_preview');");
    expect(codeOnly(REMINDER)).toContain('if (!cell) return false;');
  });

  it('содержимое всех баннеров решает одно место', () => {
    expect(codeOnly(PUSH).match(/const preview = await previewAllowed\(\);/g)).toHaveLength(3);
  });
});

describe('ЗАКРЕПКА', () => {
  it('настройка читается формой, которая различает нечитаемость', () => {
    const code = codeOnly(PUSH);
    expect(code).toContain("const cell = await kvTryGet('notify_preview');");
    expect(code).toContain('if (!cell) return false;');
    expect(code).not.toContain("kvGet('notify_preview')");
  });
});
