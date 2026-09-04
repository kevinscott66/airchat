/**
 * Очередь «после взаимодействий» может не опустеть никогда (v4.32.582).
 *
 * На вебе react-native-web не имеет нативного драйвера: `useNativeDriver: true`
 * молча откатывается в JS, и Animated берёт handle InteractionManager на каждый
 * шаг. Вечный цикл (скелетон ленты, пульс сплэша, дрейф обоев) не возвращает
 * его никогда — очередь стоит, `runAfterInteractions` не срабатывает, и лента
 * не начинает грузиться вообще: человек до конца сессии смотрит на скелетон.
 *
 * Причину лечим в самих анимациях (`isInteraction: false`), но экраны не должны
 * зависеть от дисциплины всех анимаций приложения — отсюда крайний срок.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockRunAfter = jest.fn();
jest.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (cb: () => void) => {
      mockRunAfter(cb);
      return { cancel: () => undefined };
    },
  },
}));

import { runAfterInteractionsWithDeadline, waitForInteractions } from '../afterInteractions';

describe('runAfterInteractionsWithDeadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRunAfter.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('вызывает колбэк по крайнему сроку, когда очередь занята навсегда', () => {
    const fn = jest.fn();
    runAfterInteractionsWithDeadline(fn);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('вызывает колбэк ровно один раз: очередь опустела — таймер уже не стреляет', () => {
    const fn = jest.fn();
    mockRunAfter.mockImplementationOnce((cb: () => void) => cb());
    runAfterInteractionsWithDeadline(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('снятая подписка не вызывает колбэк', () => {
    const fn = jest.fn();
    runAfterInteractionsWithDeadline(fn)();
    jest.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('waitForInteractions не зависает на занятой очереди', async () => {
    const p = waitForInteractions();
    jest.advanceTimersByTime(400);
    await expect(p).resolves.toBeUndefined();
  });
});

describe('вечные анимации не держат очередь взаимодействий', () => {
  const UI = path.join(__dirname, '..', '..', '..', 'ui');

  /** Разбирает файл на конфиги отдельных `Animated.timing(...)` по балансу скобок. */
  function timingConfigs(src: string): string[] {
    const out: string[] = [];
    const NEEDLE = 'Animated.timing(';
    for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + 1)) {
      let depth = 0;
      let j = i + NEEDLE.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      out.push(src.slice(i, j + 1));
    }
    return out;
  }

  /**
   * Сколько в файле конечных (не зацикленных) анимаций: они законно берут
   * handle и возвращают его на финише. Всё остальное крутится вечно и обязано
   * быть помечено. Число здесь — чтобы новая вечная анимация не проехала молча.
   */
  const finite: Array<[string, string, number]> = [
    ['components', 'SkeletonLoader.tsx', 0],
    ['components', 'AnimatedDots.tsx', 0],
    ['components', 'SplashOverlay.tsx', 5],
    ['components', 'VoiceMessage.tsx', 0],
    ['components', 'WallpaperBackground.tsx', 0],
    ['screens', 'LoadingScreen.tsx', 1],
  ];

  it.each(finite)('%s/%s: анимации цикла помечены isInteraction: false', (dir, file, allowed) => {
    const src = fs.readFileSync(path.join(UI, dir as string, file as string), 'utf8');
    expect(src).toContain('Animated.loop');
    const unmarked = timingConfigs(src).filter((c) => !c.includes('isInteraction: false'));
    expect(unmarked).toHaveLength(allowed as number);
  });

  it('лента ждёт взаимодействий только с крайним сроком', () => {
    const feed = fs.readFileSync(path.join(UI, 'screens', 'FeedScreen.tsx'), 'utf8');
    expect(feed).toContain('runAfterInteractionsWithDeadline');
    expect(feed).toContain('waitForInteractions');
    expect(feed).not.toContain('InteractionManager.runAfterInteractions(');
  });
});
