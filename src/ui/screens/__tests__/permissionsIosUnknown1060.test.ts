/**
 * ДЕФЕКТ (v4.32.1060). Экран «Разрешения» на iPhone писал «Разрешено ✓» про
 * уведомления и микрофон, никого не спросив.
 *
 * `checkNotifications`/`requestNotifications` начинались с проверки
 * «нужен ли runtime-запрос», а та отвечала `true` только для Android 13+;
 * всё остальное, включая любой iOS, объявлялось выданным. У микрофона было
 * то же самое: `check` на не-Android возвращал прежнее известное значение, а
 * `request` — сразу `'granted'`.
 *
 * ЦЕНА. Не в самой надписи. Нажатие на выданную карточку не делает ничего:
 * `permissionTapAction('granted')` — `'none'`. Человек, у которого
 * уведомления не приходят (диалог iOS показывают ровно один раз за
 * установку, и он мог тогда нажать «Не разрешать»), приходил на экран
 * «Разрешения», видел зелёную галочку — и с этого экрана не мог ни спросить
 * систему заново, ни уйти в её настройки. Единственный экран, который про
 * это и сделан, вёл в тупик. У микрофона нажатие карточки к тому же меняло
 * её на «Разрешено ✓» без единого диалога, а первый же зажим кнопки записи
 * упирался в тот самый диалог.
 *
 * ПРАВКА. На iOS уведомления читает `messaging().hasPermission()` (тот же
 * вызов, которым пользуется `pushNotifications`), микрофон —
 * `getRecordingPermissionsAsync` из expo-audio (тот же модуль, которым
 * пользуется голосовой пузырь). Отказ iOS — это `blocked`, а не `denied`:
 * диалога второй раз не будет, вести надо в настройки. Тихая выдача
 * (provisional) — `limited`.
 *
 * ГРАНИЦЫ. Android не тронут: 13+ идёт прежним `PermissionsAndroid`, до 13
 * по-прежнему отвечает `'granted'` без единого похода наружу — разрешения
 * такого там нет. Если модуль не ответил, `check` отдаёт прежнее известное,
 * `request` — `'unknown'`: выдумывать выдачу мы перестали совсем.
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: 18 },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'post_notifications', RECORD_AUDIO: 'record_audio' },
    check: jest.fn(async () => true),
    request: jest.fn(async () => 'granted'),
  },
}));

jest.mock('@react-native-firebase/messaging', () => {
  const state = { has: 1, req: 1, broken: false };
  const messaging = (): unknown => ({
    hasPermission: async () => {
      if (state.broken) throw new Error('модуль не собран');
      return state.has;
    },
    requestPermission: async () => {
      if (state.broken) throw new Error('модуль не собран');
      return state.req;
    },
  });
  return { __esModule: true, default: messaging, __state: state };
});

jest.mock('expo-audio', () => {
  const state = {
    get: { status: 'granted' } as Record<string, unknown>,
    req: { status: 'granted' } as Record<string, unknown>,
    broken: false,
    asked: 0,
  };
  return {
    __esModule: true,
    getRecordingPermissionsAsync: async () => {
      if (state.broken) throw new Error('модуль не собран');
      return state.get;
    },
    requestRecordingPermissionsAsync: async () => {
      if (state.broken) throw new Error('модуль не собран');
      state.asked += 1;
      return state.req;
    },
    __state: state,
  };
});

import fs from 'fs';
import path from 'path';

import { Platform, PermissionsAndroid } from 'react-native';

import { PERMISSION_DEFS, type PermissionId } from '../permissionDefs';
import { statusHint, STATUS_HINT } from '../permissionHints';
import { mapPushAuthorization, permissionTapAction, type PermissionStatus } from '../permissionStatus';

const push = (jest.requireMock('@react-native-firebase/messaging') as {
  __state: { has: number; req: number; broken: boolean };
}).__state;
const audio = (jest.requireMock('expo-audio') as {
  __state: { get: Record<string, unknown>; req: Record<string, unknown>; broken: boolean; asked: number };
}).__state;

const os = Platform as unknown as { OS: string; Version: number };
const androidCheck = PermissionsAndroid.check as unknown as jest.Mock;
const androidRequest = PermissionsAndroid.request as unknown as jest.Mock;

function def(id: PermissionId) {
  const found = PERMISSION_DEFS.find((d) => d.id === id);
  if (!found) throw new Error(`нет такого разрешения: ${id}`);
  return found;
}

const SRC = path.join(__dirname, '..');
const read = (name: string): string => fs.readFileSync(path.join(SRC, name), 'utf8');

beforeEach(() => {
  os.OS = 'ios';
  os.Version = 18;
  push.has = 1;
  push.req = 1;
  push.broken = false;
  audio.get = { status: 'granted' };
  audio.req = { status: 'granted' };
  audio.broken = false;
  audio.asked = 0;
  androidCheck.mockClear();
  androidRequest.mockClear();
});

describe('уведомления на iPhone: спрашиваем систему, а не выдумываем', () => {
  it('отказ системы не выдаётся за выдачу', async () => {
    push.has = 0;
    expect(await def('notifications').check('unknown')).toBe('blocked');
  });

  it('отказ называется «запрещено», а не «отказано»: второго диалога не будет', async () => {
    push.has = 0;
    const status = await def('notifications').check('unknown');
    // Именно от этого слова зависит, куда ведёт нажатие.
    expect(permissionTapAction(status)).toBe('open_settings');
  });

  it('ещё не спрашивали — так и говорим', async () => {
    push.has = -1;
    expect(await def('notifications').check('granted')).toBe('unknown');
  });

  it('тихая выдача — не полная выдача', async () => {
    push.has = 2;
    expect(await def('notifications').check('unknown')).toBe('limited');
  });

  it('запрос отдаёт ответ системы, а не своё «разрешено»', async () => {
    push.req = 0;
    expect(await def('notifications').request()).toBe('blocked');
  });

  it('модуль не ответил — держим прежнее известное, выдачу не выдумываем', async () => {
    push.broken = true;
    expect(await def('notifications').check('denied')).toBe('denied');
    expect(await def('notifications').request()).toBe('unknown');
  });

  it('выданное остаётся выданным', async () => {
    push.has = 1;
    expect(await def('notifications').check('unknown')).toBe('granted');
  });
});

describe('микрофон на iPhone', () => {
  it('отказ не превращается в «Разрешено ✓» после нажатия', async () => {
    audio.req = { status: 'denied', canAskAgain: true };
    expect(await def('microphone').request()).toBe('denied');
  });

  it('запрос действительно доходит до системы', async () => {
    await def('microphone').request();
    expect(audio.asked).toBe(1);
  });

  it('состояние читается, а не берётся из памяти экрана', async () => {
    audio.get = { status: 'denied', canAskAgain: false };
    expect(await def('microphone').check('granted')).toBe('blocked');
  });

  it('модуль не ответил — прежнее известное и честное «не знаю»', async () => {
    audio.broken = true;
    expect(await def('microphone').check('limited')).toBe('limited');
    expect(await def('microphone').request()).toBe('unknown');
  });
});

describe('ГРАНИЦА: Android идёт прежним путём', () => {
  it('Android 13+ читает PermissionsAndroid, а не firebase', async () => {
    os.OS = 'android';
    os.Version = 33;
    push.has = 0;
    expect(await def('notifications').check('unknown')).toBe('granted');
    expect(androidCheck).toHaveBeenCalledWith('post_notifications');
  });

  it('Android до 13: уведомления выданы, и наружу за этим не ходят', async () => {
    os.OS = 'android';
    os.Version = 30;
    push.has = 0;
    expect(await def('notifications').check('unknown')).toBe('granted');
    expect(androidCheck).not.toHaveBeenCalled();
  });

  it('микрофон на Android спрашивает систему Android, а не expo-audio', async () => {
    os.OS = 'android';
    await def('microphone').request();
    expect(audio.asked).toBe(0);
    expect(androidRequest).toHaveBeenCalled();
  });
});

describe('разбор ответа iOS о push', () => {
  it('каждое число названо своим состоянием', () => {
    const table: Array<[number, PermissionStatus]> = [
      [-1, 'unknown'],
      [0, 'blocked'],
      [1, 'granted'],
      [2, 'limited'],
      [3, 'granted'],
    ];
    for (const [num, want] of table) expect(mapPushAuthorization(num)).toBe(want);
  });

  it('незнакомое и пустое — незнание, а не выдача', () => {
    expect(mapPushAuthorization(7)).toBe('unknown');
    expect(mapPushAuthorization(null)).toBe('unknown');
    expect(mapPushAuthorization(undefined)).toBe('unknown');
    expect(mapPushAuthorization(NaN)).toBe('unknown');
  });
});

describe('подсказка под карточкой', () => {
  it('частичные уведомления не объясняются через выбранные фото', () => {
    const hint = statusHint('notifications', 'limited');
    expect(hint).not.toContain('фото');
    expect(hint).toContain('без баннера и звука');
    expect(hint).toContain('настройках системы');
  });

  it('ГРАНИЦА: у галереи подсказка прежняя', () => {
    expect(statusHint('gallery', 'limited')).toBe(STATUS_HINT.limited);
  });

  it('ГРАНИЦА: остальные состояния берут общий текст', () => {
    for (const id of ['notifications', 'microphone', 'camera', 'gallery', 'location'] as PermissionId[]) {
      expect(statusHint(id, 'blocked')).toBe(STATUS_HINT.blocked);
      expect(statusHint(id, 'denied')).toBe(STATUS_HINT.denied);
      expect(statusHint(id, 'granted')).toBeUndefined();
      expect(statusHint(id, 'unknown')).toBeUndefined();
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: нажатие на выданную карточку не делает ничего', () => {
    // Вот почему ложь была тупиком, а не просто неточной надписью.
    expect(permissionTapAction('granted')).toBe('none');
    expect(permissionTapAction('blocked')).toBe('open_settings');
    expect(permissionTapAction('denied')).toBe('request');
  });

  it('ПОВОД ЖИВ: карточка «Уведомления» на экране одна и она из общего списка', () => {
    expect(PERMISSION_DEFS.filter((d) => d.id === 'notifications')).toHaveLength(1);
    expect(PERMISSION_DEFS.filter((d) => d.id === 'microphone')).toHaveLength(1);
  });

  it('ЗАКРЕПКА: экран спрашивает подсказку по имени разрешения', () => {
    const screen = read('PermissionsScreen.tsx');
    expect(screen).toContain('statusHint(item.id, status)');
    // Прямое обращение к общей таблице вернуло бы текст про фото на карточку
    // уведомлений — его на экране больше нет ни одного.
    expect(screen).not.toContain('STATUS_HINT[');
  });

  it('ЗАКРЕПКА: на iOS ветка стоит раньше проверки «нужен ли запрос»', () => {
    const defs = read('permissionDefs.ts');
    const ios = defs.indexOf("if (Platform.OS === 'ios') return (await pushAuthorization(false))");
    const old = defs.indexOf('if (!notificationsNeedPrompt()) return \'granted\';');
    // Обе опоры должны существовать: у отсутствующей строки индекс -1, и
    // сравнение порядка было бы пустым.
    expect(ios).toBeGreaterThan(0);
    expect(old).toBeGreaterThan(0);
    expect(ios).toBeLessThan(old);
  });
});
