/**
 * Замок приложения гасит содержимое баннера (v4.32.614).
 *
 * «Текст сообщений в уведомлениях» был единственным условием показа
 * содержимого, а пароль приложения на баннеры не влиял никак: человек включал
 * автоблокировку, приложение при сворачивании запиралось — и следующее же
 * сообщение выкладывало имя собеседника и текст поверх запертого экрана.
 * Замок ставят именно от того, у кого телефон уже в руках, и обойти его
 * хватало терпения дождаться уведомления.
 *
 * `AuthGuard.isSessionUnlocked` заведён ровно для этого вопроса, но до сих пор
 * его не звал никто: во всём `src` была одна строка — объявление.
 *
 * Здесь проверяется поведение на ленте (единственный показ, экспортированный
 * наружу) и то, что все три места показа спрашивают один и тот же ответ.
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
jest.mock('../../core/storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvSet: jest.fn(async () => undefined),
}));

const mockDisplay = jest.fn(async (opts: { title: string; body: string }) => opts);
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: { displayNotification: mockDisplay, createChannel: jest.fn(async () => 'c') },
  AndroidImportance: { HIGH: 4, MIN: 1 },
  AndroidCategory: { CALL: 'call' },
}));

import { authGuard } from '../../core/security/authGuard';
import { notifyFeedEvent } from '../pushNotifications';

const PUSH = fs.readFileSync(path.join(__dirname, '..', 'pushNotifications.ts'), 'utf8');

const EVENT = { title: 'Аня', body: 'новая запись про кота', postId: 'p1', kind: 'post' as const };

describe('содержимое баннера при запертом приложении', () => {
  beforeEach(() => {
    mockDisplay.mockClear();
    mockKv.clear();
  });

  it('приложение открыто — имя и текст на месте', async () => {
    authGuard.unlockSession();
    await notifyFeedEvent(EVENT);
    expect(mockDisplay).toHaveBeenCalledTimes(1);
    const shown = mockDisplay.mock.calls[0][0];
    expect(shown.title).toBe('Аня');
    expect(shown.body).toBe('новая запись про кота');
  });

  it('замок заперт — баннер есть, содержимого нет', async () => {
    authGuard.lockSession();
    await notifyFeedEvent(EVENT);
    expect(mockDisplay).toHaveBeenCalledTimes(1);
    const shown = mockDisplay.mock.calls[0][0];
    expect(shown.title).toBe('AirChat');
    expect(shown.body).toBe('Новая публикация');
  });

  it('выключенная настройка гасит содержимое и при открытом приложении', async () => {
    authGuard.unlockSession();
    mockKv.set('notify_preview', 'false');
    await notifyFeedEvent(EVENT);
    const shown = mockDisplay.mock.calls[0][0];
    expect(shown.title).toBe('AirChat');
  });

  it('уведомление о публикации не пропадает — гаснет только текст', async () => {
    authGuard.lockSession();
    await notifyFeedEvent({ ...EVENT, kind: 'comment' });
    expect(mockDisplay).toHaveBeenCalledTimes(1);
    expect(mockDisplay.mock.calls[0][0].body).toBe('Новый комментарий');
  });
});

describe('один ответ на все три места показа', () => {
  it('настройка читается ровно в одном месте', () => {
    expect(PUSH.match(/kvGet\('notify_preview'\)/g)).toHaveLength(1);
  });

  it('и это место спрашивает замок', () => {
    expect(PUSH).toContain('return authGuard.isSessionUnlocked();');
  });

  it('личное, групповое и лента берут ответ оттуда же', () => {
    expect(PUSH.match(/const preview = await previewAllowed\(\);/g)).toHaveLength(3);
  });
});
