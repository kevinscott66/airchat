/**
 * Баннер звонка, который некому погасить (v4.32.746).
 *
 * Баннер входящего звонка нарочно несмахиваемый: `ongoing: true`,
 * `autoCancel: false`, — чтобы окно звонка не пропадало с заблокированного
 * экрана от случайного касания. Из этого следует, что убрать его может только
 * тот, кто знает, что звонка больше нет. Знал ровно один: служба звонков, к
 * которой доехало предложение по сокету, — и гасила из своей приватной копии
 * этой функции.
 *
 * Отсюда два случая, когда телефон продолжал звать к трубке впустую:
 *
 * 1. Приложение не подняли вовсе. Звонящий бросает дозваниваться через 45 с
 *    (OUTGOING_RINGING_TIMEOUT_MS), а баннер жил `CALL_BANNER_TIMEOUT_MS` = 60 с.
 *    Пятнадцать секунд несмахиваемого зова к звонку, которого уже нет.
 * 2. На баннер нажали. Приложение поднималось, но строка оставалась в шторке:
 *    ни фоновый обработчик, ни оконный, ни холодный старт её не трогали.
 *
 * Проверяется и поведение самой dismissCallBanner, и то, что её зовут все трое,
 * кто разбирает нажатие. Последнее — привязками к исходнику: фоновый
 * обработчик push живёт в отдельном запуске JS и в тесте не поднимается (тот же
 * приём, что и в openIntent.test.ts).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CALL_BANNER_TIMEOUT_MS, callBannerId } from '../callPush';
import { OUTGOING_RINGING_TIMEOUT_MS } from '../../core/social/callTeardown';

const CALL_ID = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';

/** Что notifee получил на отмену. Заполняется мокой ниже. */
const mockCancelled: string[] = [];
/** Чем отвечает cancelNotification. Меняют отдельные проверки. */
let mockCancelResult: () => Promise<void> = () => Promise.resolve();

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    cancelNotification: (id: string) => {
      mockCancelled.push(id);
      return mockCancelResult();
    },
  },
}));

beforeEach(() => {
  mockCancelled.length = 0;
  mockCancelResult = () => Promise.resolve();
  jest.resetModules();
});

/** Прочитать исходник из src/ по пути относительно src/notifications. */
function source(relative: string): string {
  return readFileSync(join(__dirname, '..', relative), 'utf8');
}

/**
 * Взять кусок исходника от якоря до конца функции — грубо, по числу строк.
 * Нужно, чтобы отличить «слово встречается в файле» от «слово встречается
 * там, где разбирают нажатие».
 */
function around(src: string, anchor: string, lines: number): string {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`в исходнике нет якоря: ${anchor}`);
  return src.slice(at).split('\n').slice(0, lines).join('\n');
}

describe('срок баннера', () => {
  test('баннер не переживает звонящего', () => {
    expect(CALL_BANNER_TIMEOUT_MS).toBe(OUTGOING_RINGING_TIMEOUT_MS);
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: срок вообще есть и он не нулевой', () => {
    // Убрать баннер, сделав срок нулём, — не решение: тогда его не увидят.
    expect(CALL_BANNER_TIMEOUT_MS).toBeGreaterThan(10_000);
  });
});

describe('гашение баннера', () => {
  test('гасит баннер именно этого звонка', () => {
    const { dismissCallBanner } = require('../callBanner') as typeof import('../callBanner');
    dismissCallBanner(CALL_ID);
    expect(mockCancelled).toEqual([callBannerId(CALL_ID)]);
  });

  test('чужой звонок не гасится', () => {
    const { dismissCallBanner } = require('../callBanner') as typeof import('../callBanner');
    dismissCallBanner(CALL_ID);
    expect(mockCancelled[0]).not.toBe(callBannerId('b'.repeat(32)));
  });

  test('отказ notifee не роняет того, кто позвал', async () => {
    mockCancelResult = () => Promise.reject(new Error('баннера уже нет'));
    const { dismissCallBanner } = require('../callBanner') as typeof import('../callBanner');
    expect(() => dismissCallBanner(CALL_ID)).not.toThrow();
    // Отказ приходит следующим тиком — без .catch он стал бы
    // unhandled rejection и уронил бы приложение в dev-сборке.
    await Promise.resolve();
    expect(mockCancelled).toEqual([callBannerId(CALL_ID)]);
  });

  test('звать дважды безвредно', () => {
    const { dismissCallBanner } = require('../callBanner') as typeof import('../callBanner');
    dismissCallBanner(CALL_ID);
    dismissCallBanner(CALL_ID);
    expect(mockCancelled).toHaveLength(2);
  });
});

describe('нажатие гасит баннер', () => {
  test('фоновый обработчик — перед тем как открыть приложение', () => {
    const src = source('../firebaseMessagingBackground.ts');
    const press = around(src, 'notifee.onBackgroundEvent(', 30);
    expect(press).toContain('dismissCallBanner');
    // Сначала погасить, потом открыть: обратный порядок оставляет строку в
    // шторке ровно на то время, пока приложение поднимается.
    expect(press.indexOf('dismissCallBanner')).toBeLessThan(press.indexOf('deliverOpenIntent'));
    expect(src).toContain("from './notifications/callBanner'");
  });

  test('оконный обработчик — при открытом приложении', () => {
    const src = source('pushNotifications.ts');
    const window = around(src, 'notifee.onForegroundEvent(', 40);
    expect(window).toContain('dismissCallBanner');
    expect(window.indexOf('dismissCallBanner')).toBeLessThan(window.indexOf('push_press_foreground'));
  });

  test('холодный старт — когда нажатием и подняли приложение', () => {
    const src = source('pushNotifications.ts');
    const cold = around(src, 'getInitialNotification', 20);
    expect(cold).toContain('dismissCallBanner');
    expect(cold.indexOf('dismissCallBanner')).toBeLessThan(cold.indexOf('push_press_cold_start'));
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: гасится только звонок, а не всякое нажатие', () => {
    // Переписка баннер не гасит — там `autoCancel` делает это сам, и гасить
    // чужой идентификатор нечем: callBannerId ждёт номер звонка.
    const src = source('pushNotifications.ts');
    const window = around(src, 'notifee.onForegroundEvent(', 40);
    expect(window).toMatch(/kind === 'call'\) dismissCallBanner/);
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: у обоих обработчиков нажатие вообще разбирается', () => {
    expect(source('../firebaseMessagingBackground.ts')).toContain('EventType.PRESS');
    expect(source('pushNotifications.ts')).toContain('EventType.PRESS');
  });
});

describe('копия в службе звонков убрана', () => {
  test('служба зовёт общую, а не свою', () => {
    const src = readFileSync(join(__dirname, '../../core/social/callService.ts'), 'utf8');
    expect(src).toContain("from '../../notifications/callBanner'");
    // Своей копии больше нет: объявления функции в файле не осталось.
    expect(src).not.toMatch(/function dismissCallBanner/);
    expect(src).toContain('dismissCallBanner(');
  });
});
