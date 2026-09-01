/**
 * Рэтчет к v4.32.567: рисунок вибрации не начинается с нуля.
 *
 * Дефект был не в том, что вибрация звучала неправильно, — уведомлений не
 * было вовсе. notifee проверяет `vibrationPattern` сам, в JS, и требует
 * строго положительных значений; `[0, 250, 150, 250]` проваливало проверку,
 * `displayNotification` бросало, а все четыре вызывающих места исключение
 * глушили (три — `log.debug`, невидимый в release, четвёртое — пустой catch).
 *
 * Проверка здесь двойная. Во-первых, поведение модуля. Во-вторых — то, ради
 * чего написан `isNotifeeVibrationPattern`: правило берётся из текста самого
 * валидатора notifee и сверяется с нашей копией. Импортировать валидатор
 * нельзя — он тянет react-native, и jest его не преобразует, — поэтому файл
 * читается как текст. Если notifee once поменяет правило, тест скажет об этом
 * здесь, а не молчанием шторки на телефоне.
 */
import fs from 'fs';
import path from 'path';
import {
  FEED_VIBRATION,
  MESSAGE_VIBRATION,
  isNotifeeVibrationPattern,
  sanitizeVibrationPattern,
  vibrationFor,
} from '../vibrationPattern';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const VALIDATOR = () =>
  read('node_modules', '@notifee', 'react-native', 'dist', 'validators', 'validate.js');
const PUSH = () => read('src', 'notifications', 'pushNotifications.ts');
const BG = () => read('src', 'firebaseMessagingBackground.ts');
const MODULE = () => read('src', 'notifications', 'vibrationPattern.ts');

describe('правило notifee', () => {
  it('валидатор действительно отвергает неположительные значения', () => {
    const src = VALIDATOR();
    const at = src.indexOf('function isValidVibratePattern(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    // Ровно два условия, на которых всё и держится.
    expect(body).toContain('pattern.length % 2 !== 0');
    expect(body).toContain('ms <= 0');
  });

  it('наша копия правила совпадает с ним на разборе случаев', () => {
    expect(isNotifeeVibrationPattern([0, 250, 150, 250])).toBe(false); // прежний рисунок
    expect(isNotifeeVibrationPattern([1, 250, 150, 250])).toBe(true);
    expect(isNotifeeVibrationPattern([])).toBe(true); // «без вибрации» законно
    expect(isNotifeeVibrationPattern([250])).toBe(false); // нечётная длина
    expect(isNotifeeVibrationPattern([-1, 250])).toBe(false);
    expect(isNotifeeVibrationPattern([Number.NaN, 250])).toBe(false);
  });
});

describe('рисунки, которые уходят в notifee', () => {
  it('оба готовых рисунка проходят проверку', () => {
    expect(isNotifeeVibrationPattern(MESSAGE_VIBRATION)).toBe(true);
    expect(isNotifeeVibrationPattern(FEED_VIBRATION)).toBe(true);
  });

  it('ни один не начинается с нуля', () => {
    expect(MESSAGE_VIBRATION[0]).toBeGreaterThan(0);
    expect(FEED_VIBRATION[0]).toBeGreaterThan(0);
  });

  it('прежний ритм сохранён — изменилась только задержка', () => {
    expect(MESSAGE_VIBRATION.slice(1)).toEqual([250, 150, 250]);
    expect(FEED_VIBRATION.slice(1)).toEqual([150]);
  });

  it('выключенная вибрация — пустой массив, а не отсутствие поля', () => {
    expect(vibrationFor(false, 'message')).toEqual([]);
    expect(vibrationFor(false, 'feed')).toEqual([]);
    expect(isNotifeeVibrationPattern(vibrationFor(false, 'message'))).toBe(true);
  });

  it('включённая даёт рисунок своего вида', () => {
    expect(vibrationFor(true, 'message')).toEqual([1, 250, 150, 250]);
    expect(vibrationFor(true, 'feed')).toEqual([1, 150]);
  });
});

describe('приведение чужого рисунка', () => {
  it('ноль и отрицательное становятся миллисекундой, а не отказом', () => {
    expect(sanitizeVibrationPattern([0, 250, 150, 250])).toEqual([1, 250, 150, 250]);
    expect(sanitizeVibrationPattern([-40, 250])).toEqual([1, 250]);
  });

  it('нечисло тоже становится миллисекундой', () => {
    expect(sanitizeVibrationPattern([Number.NaN, 250])).toEqual([1, 250]);
    expect(sanitizeVibrationPattern([Number.POSITIVE_INFINITY, 250])).toEqual([1, 250]);
  });

  it('дробное округляется', () => {
    expect(sanitizeVibrationPattern([1.4, 250.6])).toEqual([1, 251]);
  });

  it('нечётный хвост отбрасывается — рисунок читается парами', () => {
    expect(sanitizeVibrationPattern([1, 250, 150])).toEqual([1, 250]);
  });

  it('пустое и не-массив дают «без вибрации»', () => {
    expect(sanitizeVibrationPattern([])).toEqual([]);
    expect(sanitizeVibrationPattern(null)).toEqual([]);
    expect(sanitizeVibrationPattern(undefined)).toEqual([]);
  });

  it('что бы ни пришло, результат notifee примет', () => {
    const inputs: number[][] = [
      [0, 0, 0, 0],
      [-5],
      [1],
      [0.2, 0.2],
      [Number.NaN, Number.NaN, 3, 4],
      [],
    ];
    for (const input of inputs) {
      expect(isNotifeeVibrationPattern(sanitizeVibrationPattern(input))).toBe(true);
    }
  });
});

describe('форма исходников', () => {
  it('ни одного рисунка с ведущим нулём в приложении не осталось', () => {
    for (const src of [PUSH(), BG()]) {
      expect(src).not.toContain('vibrationPattern: vibrate ? [0,');
      expect(src).not.toContain('vibrationPattern: prefs.vibrate ? [0,');
      expect(src).not.toMatch(/vibrationPattern:\s*\[0,/);
    }
  });

  it('все четыре показа берут рисунок у общего модуля', () => {
    const push = PUSH();
    const bg = BG();
    const calls = (s: string) => (s.match(/vibrationPattern: vibrationFor\(/g) ?? []).length;
    expect(calls(push)).toBe(3);
    expect(calls(bg)).toBe(1);
    // И общее число мест не выросло мимо модуля.
    expect((push.match(/vibrationPattern:/g) ?? []).length).toBe(3);
    expect((bg.match(/vibrationPattern:/g) ?? []).length).toBe(1);
  });

  it('отказ показа больше не пишется в debug и не глотается молча', () => {
    const push = PUSH();
    for (const key of ['group_local_notify_failed', 'push_local_notify_failed', 'feed_notify_failed']) {
      expect(push).toContain(`log.warn('${key}'`);
      expect(push).not.toContain(`log.debug('${key}'`);
    }
    const bg = BG();
    expect(bg).toContain("log.warn('bg_notify_failed'");
    expect(bg).not.toContain('/* optional */');
  });

  it('модуль остался без импортов — правило проверяется само по себе', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });
});
