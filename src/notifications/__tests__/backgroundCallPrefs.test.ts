/**
 * Звонок при закрытом приложении спрашивает свои настройки (v4.32.573).
 *
 * Выключатели уведомлений писались под сообщения, и соблазн был переиспользовать
 * их для звонка. Но человек, отключивший баннеры переписки, от звонков не
 * отказывался — а «Не беспокоить» для звонка не может значить «спрятать»:
 * пропущенного звонка в AirChat нет, и спрятанный звонок исчезает молча, будто
 * его и не было. Поэтому у звонка свой ключ, а тихий час его лишь обеззвучивает.
 */
let mockKv: Record<string, string> = {};
let mockOpenFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    if (mockOpenFails) throw new Error('SQLITE_CANTOPEN: unable to open database file');
    return {
      // Настройки читаются одним запросом со списком ключей прямо в тексте SQL.
      getAllAsync: jest.fn(async (sql: string) => {
        const inList = /WHERE k IN \(([^)]*)\)/.exec(sql);
        if (!inList) return [];
        return inList[1]
          .split(',')
          .map((s) => s.trim().replace(/^'|'$/g, ''))
          .filter((k) => mockKv[k] !== undefined)
          .map((k) => ({ k, v: mockKv[k] }));
      }),
      getFirstAsync: jest.fn(async () => null),
      runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
      execAsync: jest.fn(async () => undefined),
      closeAsync: jest.fn(async () => undefined),
    };
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readBackgroundCallPrefs, readBackgroundNotifyPrefs } =
  require('../backgroundNotifyPrefs') as typeof import('../backgroundNotifyPrefs');

beforeEach(() => {
  mockKv = {};
  mockOpenFails = false;
});

describe('настройки баннера входящего звонка', () => {
  it('настроек нет — звоним со звуком и вибрацией', async () => {
    await expect(readBackgroundCallPrefs(12)).resolves.toEqual({
      show: true,
      sound: true,
      vibrate: true,
    });
  });

  it('выключенные сообщения звонок не глушат', async () => {
    mockKv.notify_dm = 'false';
    mockKv.notify_groups = 'false';
    await expect(readBackgroundCallPrefs(12)).resolves.toEqual({
      show: true,
      sound: true,
      vibrate: true,
    });
    // Для сообщений тот же ключ по-прежнему значит «молчать» — проверяем, что
    // разошлись именно звонки, а не выключатель перестал работать вообще.
    await expect(readBackgroundNotifyPrefs('dm', 12)).resolves.toEqual({
      show: false,
      sound: false,
      vibrate: false,
    });
  });

  it('свой выключатель звонки глушит', async () => {
    mockKv.notify_calls = 'false';
    await expect(readBackgroundCallPrefs(12)).resolves.toEqual({
      show: false,
      sound: false,
      vibrate: false,
    });
  });

  it('выключенные звонки не глушат сообщения', async () => {
    mockKv.notify_calls = 'false';
    await expect(readBackgroundNotifyPrefs('dm', 12)).resolves.toEqual({
      show: true,
      sound: true,
      vibrate: true,
    });
  });

  it('в тихий час звонок виден, но молчит', async () => {
    mockKv.dnd_enabled = 'true';
    mockKv.dnd_start = '22';
    mockKv.dnd_end = '8';
    await expect(readBackgroundCallPrefs(3)).resolves.toEqual({
      show: true,
      sound: false,
      vibrate: false,
    });
    // А сообщение в тот же час прячется совсем — разница намеренная.
    await expect(readBackgroundNotifyPrefs('dm', 3)).resolves.toEqual({
      show: false,
      sound: false,
      vibrate: false,
    });
  });

  it('вне тихого часа звонок звучит', async () => {
    mockKv.dnd_enabled = 'true';
    mockKv.dnd_start = '22';
    mockKv.dnd_end = '8';
    await expect(readBackgroundCallPrefs(13)).resolves.toEqual({
      show: true,
      sound: true,
      vibrate: true,
    });
  });

  it('выключенные звонки сильнее тихого часа: молчание значит «не показывать»', async () => {
    mockKv.notify_calls = 'false';
    mockKv.dnd_enabled = 'true';
    mockKv.dnd_start = '22';
    mockKv.dnd_end = '8';
    await expect(readBackgroundCallPrefs(3)).resolves.toEqual({
      show: false,
      sound: false,
      vibrate: false,
    });
  });

  it('отключённые звук и вибрация действуют и на звонок', async () => {
    mockKv.notify_sound = 'false';
    mockKv.notify_vibrate = 'false';
    await expect(readBackgroundCallPrefs(12)).resolves.toEqual({
      show: true,
      sound: false,
      vibrate: false,
    });
  });

  it('недоступная база не съедает звонок', async () => {
    mockOpenFails = true;
    await expect(readBackgroundCallPrefs(3)).resolves.toEqual({
      show: true,
      sound: true,
      vibrate: true,
    });
  });

  it('порченое значение выключателя означает «показать»', async () => {
    for (const bad of ['', '0', 'no', 'FALSE', 'true']) {
      mockKv.notify_calls = bad;
      await expect(readBackgroundCallPrefs(12)).resolves.toMatchObject({ show: true });
    }
  });
});
