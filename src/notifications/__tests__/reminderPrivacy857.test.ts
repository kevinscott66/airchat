/**
 * Напоминание о сообщении: текст на замке и жизнь после сброса (v4.32.857).
 *
 * Дефект. «Напомнить о сообщении» ставило отложенное уведомление с текстом
 * сообщения в теле — мимо обоих запретов, ради которых в pushNotifications
 * написан `previewAllowed`: ни «Показывать текст сообщений», ни пароль на вход
 * на него не влияли. Снять поставленное не мог никто: во всём проекте не было
 * ни одного вызова отмены отложенных уведомлений.
 *
 * Цена. Напоминание — единственное уведомление, которому не нужны ни интернет,
 * ни запущенное приложение: оно доживёт до чужих рук вернее всякого push.
 * Поставленное «через неделю» срабатывало и после «выйти и удалить данные на
 * устройстве», и после удаления личности — на телефоне, где от неё не осталось
 * больше ничего, всплывала строка с текстом её сообщения. Человек, который
 * стёр данные перед продажей телефона, узнать об этом уже не мог.
 *
 * Правка. Постановка уехала из диалога в `reminderNotifications`: тело
 * выбирается по обоим запретам (решать приходится в момент постановки — через
 * неделю спрашивать некого), у уведомления появилось собственное имя с номером
 * личности, а сброс кошелька и удаление личности его снимают: первый — всё
 * подряд, второе — только своё.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockNotifee = {
  createChannel: jest.fn(async (_channel: { id: string; name: string; importance: number }) => 'reminders'),
  createTriggerNotification: jest.fn(
    async (_notification: Record<string, unknown>, _trigger: Record<string, unknown>) => 'id'
  ),
  getTriggerNotificationIds: jest.fn(async () => [] as string[]),
  cancelTriggerNotifications: jest.fn(async (_ids?: string[]) => undefined),
  cancelDisplayedNotifications: jest.fn(async (_ids?: string[]) => undefined),
};
let mockNotifeePresent = true;
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  get default() {
    return mockNotifeePresent ? mockNotifee : undefined;
  },
  TriggerType: { TIMESTAMP: 0 },
}));

let mockPreviewCell: { value: string | null } | null = { value: null };
let mockKvThrows = false;
jest.mock('../../core/storage/local', () => ({
  kvTryGet: jest.fn(async () => {
    if (mockKvThrows) throw new Error('база закрыта');
    return mockPreviewCell;
  }),
}));

let mockHasPassword = false;
jest.mock('../../core/security/authGuard', () => ({
  authGuard: { hasPassword: jest.fn(async () => mockHasPassword) },
}));

let mockActiveProfileId: number | null = 7;
jest.mock('../../core/identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: jest.fn(() => (mockActiveProfileId === null ? null : { id: mockActiveProfileId })),
  },
}));

import {
  REMINDER_BODY_HIDDEN,
  REMINDER_ID_PREFIX,
  reminderIdsOfProfile,
  reminderTimestamp,
} from '../../core/notifications/reminderSchedule';
import {
  cancelAllReminders,
  cancelRemindersForProfile,
  scheduleMessageReminder,
} from '../reminderNotifications';

const SRC = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const PUSH = SRC('notifications', 'pushNotifications.ts');
const WIPE = SRC('core', 'wallet', 'wipeLocalWallet.ts');
const PROFILES = SRC('core', 'identity', 'profileManager.ts');
const DIALOG = SRC('ui', 'utils', 'messageReminder.ts');
const CHAT = SRC('ui', 'screens', 'ChatScreen.tsx');

/** Все файлы `src`, кроме тестов, — для правил «во всём проекте ровно один». */
function srcFiles(): string[] {
  const root = path.join(__dirname, '..', '..');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== '__mocks__') walk(full);
      } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

async function schedule(): Promise<{ notification: Record<string, unknown>; trigger: Record<string, unknown> }> {
  await scheduleMessageReminder('week', 'встретимся у Ани в 19');
  const call = mockNotifee.createTriggerNotification.mock.calls[0];
  return { notification: call[0], trigger: call[1] };
}

beforeEach(() => {
  mockNotifee.createChannel.mockClear();
  mockNotifee.createTriggerNotification.mockClear();
  mockNotifee.getTriggerNotificationIds.mockClear();
  mockNotifee.cancelTriggerNotifications.mockClear();
  mockNotifee.cancelDisplayedNotifications.mockClear();
  mockNotifee.getTriggerNotificationIds.mockResolvedValue([]);
  mockNotifeePresent = true;
  mockPreviewCell = { value: null };
  mockKvThrows = false;
  mockHasPassword = false;
  mockActiveProfileId = 7;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('напоминание вообще ставится и уходит в notifee', async () => {
    const { notification, trigger } = await schedule();
    expect(mockNotifee.createTriggerNotification).toHaveBeenCalledTimes(1);
    expect(notification.title).toBe('AirChat — напоминание');
    expect(trigger.type).toBe(0);
    expect(typeof trigger.timestamp).toBe('number');
  });

  it('канал уведомлений создаётся до постановки', async () => {
    await schedule();
    expect(mockNotifee.createChannel).toHaveBeenCalledTimes(1);
    expect(mockNotifee.createChannel.mock.calls[0][0]).toMatchObject({ id: 'reminders' });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('напоминание переживает любую сессию: «через неделю» — это семь суток', () => {
    expect(reminderTimestamp('week', 0)).toBe(7 * 24 * 3_600_000);
  });

  it('остальные уведомления оба запрета спрашивают — напоминание было исключением', () => {
    expect(PUSH).toContain('async function previewAllowed()');
    expect(PUSH).toContain("kvGet('notify_preview')");
    expect(PUSH).toContain('authGuard.isSessionUnlocked()');
    expect((PUSH.match(/await previewAllowed\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('в тело кладётся настоящий текст сообщения, а не пересказ', () => {
    expect(CHAT).toContain('promptMessageReminder(preview, showSuccess, showError)');
    expect(CHAT).toContain("const preview = q.text.startsWith('\\x01') ? 'Медиасообщение' : q.text.slice(0, 40);");
  });

  it('отложенное уведомление в проекте ровно одно — снять все значит снять напоминания', () => {
    expect(srcFiles().filter((f) => fs.readFileSync(f, 'utf8').includes('createTriggerNotification'))).toHaveLength(1);
  });
});

describe('текст сообщения на заблокированном экране', () => {
  it('запретов нет — текст показывается', async () => {
    const { notification } = await schedule();
    expect(notification.body).toBe('встретимся у Ани в 19');
  });

  it('«показывать текст сообщений» выключено — текста нет', async () => {
    mockPreviewCell = { value: 'false' };
    const { notification } = await schedule();
    expect(notification.body).toBe(REMINDER_BODY_HIDDEN);
  });

  it('стоит пароль на вход — текста нет', async () => {
    mockHasPassword = true;
    const { notification } = await schedule();
    expect(notification.body).toBe(REMINDER_BODY_HIDDEN);
  });

  it('настройка не прочиталась — это не «настройки нет», текст прячем', async () => {
    mockPreviewCell = null;
    const { notification } = await schedule();
    expect(notification.body).toBe(REMINDER_BODY_HIDDEN);
  });

  it('база отвечает исключением — тоже прячем', async () => {
    mockKvThrows = true;
    const { notification } = await schedule();
    expect(notification.body).toBe(REMINDER_BODY_HIDDEN);
  });

  it('скрытое тело всё равно приводит человека в приложение', () => {
    expect(REMINDER_BODY_HIDDEN).not.toContain('{');
    expect(REMINDER_BODY_HIDDEN.length).toBeGreaterThan(10);
  });
});

describe('имя напоминания', () => {
  it('в имени — номер активной личности', async () => {
    const { notification } = await schedule();
    expect(typeof notification.id).toBe('string');
    expect(String(notification.id).startsWith(`${REMINDER_ID_PREFIX}7.`)).toBe(true);
  });

  it('два напоминания подряд получают разные имена', async () => {
    await scheduleMessageReminder('hour', 'раз');
    await scheduleMessageReminder('hour', 'два');
    const ids = mockNotifee.createTriggerNotification.mock.calls.map((c) => c[0].id as string);
    expect(new Set(ids).size).toBe(2);
  });

  it('личности ещё нет — напоминание всё равно ставится', async () => {
    mockActiveProfileId = null;
    const { notification } = await schedule();
    expect(String(notification.id).startsWith(`${REMINDER_ID_PREFIX}1.`)).toBe(true);
  });

  it('номер личности не путается с тем, что начинается так же', () => {
    const ids = [
      `${REMINDER_ID_PREFIX}1.aaa`,
      `${REMINDER_ID_PREFIX}12.bbb`,
      `${REMINDER_ID_PREFIX}1.ccc`,
    ];
    expect(reminderIdsOfProfile(ids, 1)).toEqual([`${REMINDER_ID_PREFIX}1.aaa`, `${REMINDER_ID_PREFIX}1.ccc`]);
    expect(reminderIdsOfProfile(ids, 12)).toEqual([`${REMINDER_ID_PREFIX}12.bbb`]);
  });

  it('безымянные напоминания прошлых версий прицельно не снимаются', () => {
    expect(reminderIdsOfProfile(['7', 'notifee-auto-id'], 7)).toEqual([]);
  });
});

describe('удаление личности', () => {
  it('снимаются только её напоминания', async () => {
    mockNotifee.getTriggerNotificationIds.mockResolvedValue([
      `${REMINDER_ID_PREFIX}7.a`,
      `${REMINDER_ID_PREFIX}9.b`,
      `${REMINDER_ID_PREFIX}7.c`,
    ]);
    await cancelRemindersForProfile(7);
    expect(mockNotifee.cancelTriggerNotifications).toHaveBeenCalledTimes(1);
    expect(mockNotifee.cancelTriggerNotifications.mock.calls[0][0]).toEqual([
      `${REMINDER_ID_PREFIX}7.a`,
      `${REMINDER_ID_PREFIX}7.c`,
    ]);
  });

  it('своих напоминаний нет — не трогаем ничего', async () => {
    mockNotifee.getTriggerNotificationIds.mockResolvedValue([`${REMINDER_ID_PREFIX}9.b`]);
    await cancelRemindersForProfile(7);
    expect(mockNotifee.cancelTriggerNotifications).not.toHaveBeenCalled();
  });

  it('показанные уведомления оставшейся личности не гасятся', async () => {
    mockNotifee.getTriggerNotificationIds.mockResolvedValue([`${REMINDER_ID_PREFIX}7.a`]);
    await cancelRemindersForProfile(7);
    expect(mockNotifee.cancelDisplayedNotifications).not.toHaveBeenCalled();
  });

  it('удаление личности зовёт снятие', () => {
    expect(PROFILES).toContain('cancelRemindersForProfile');
    expect(PROFILES).toContain('delete_profile_reminders_cancel_failed');
  });
});

describe('полный сброс устройства', () => {
  it('снимается всё отложенное, без разбора имён', async () => {
    await cancelAllReminders();
    expect(mockNotifee.getTriggerNotificationIds).not.toHaveBeenCalled();
    expect(mockNotifee.cancelTriggerNotifications).toHaveBeenCalledWith();
  });

  it('и то, что уже висит в шторке', async () => {
    await cancelAllReminders();
    expect(mockNotifee.cancelDisplayedNotifications).toHaveBeenCalledTimes(1);
  });

  it('ставит отложенное уведомление один только модуль напоминаний', () => {
    const creators = srcFiles().filter((f) => fs.readFileSync(f, 'utf8').includes('createTriggerNotification'));
    expect(creators.map((f) => path.basename(f))).toEqual(['reminderNotifications.ts']);
  });

  it('сброс кошелька зовёт снятие отдельным шагом', () => {
    expect(WIPE).toContain("step('reminders'");
    expect(WIPE).toContain('cancelAllReminders');
  });
});

describe('notifee недоступен', () => {
  it('постановка сообщает об отказе, а не рапортует об успехе', async () => {
    mockNotifeePresent = false;
    await expect(scheduleMessageReminder('hour', 'текст')).rejects.toThrow();
    expect(mockNotifee.createTriggerNotification).not.toHaveBeenCalled();
  });

  it('снятие молчит: снимать нечего и нечем', async () => {
    mockNotifeePresent = false;
    await expect(cancelAllReminders()).resolves.toBeUndefined();
    await expect(cancelRemindersForProfile(7)).resolves.toBeUndefined();
    expect(mockNotifee.cancelTriggerNotifications).not.toHaveBeenCalled();
  });
});

describe('диалог остался диалогом', () => {
  it('в слое экранов больше нет notifee', () => {
    expect(DIALOG).not.toContain('@notifee/react-native');
    expect(DIALOG).toContain('scheduleMessageReminder');
  });

  it('подтверждение по-прежнему после успеха, а не до', () => {
    expect(DIALOG).toContain('.then(() => onSuccess(choice.success))');
    expect(DIALOG).toContain(".catch(() => onError('Не удалось создать напоминание'))");
  });
});
