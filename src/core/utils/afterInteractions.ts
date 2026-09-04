import { InteractionManager } from 'react-native';

/**
 * Крайний срок ожидания пустой очереди взаимодействий.
 * Длиннее любой навигационной анимации (~300 мс), чтобы в обычном случае
 * работал именно InteractionManager, а таймер оставался страховкой.
 */
export const INTERACTIONS_DEADLINE_MS = 400;

type Cancel = () => void;

/**
 * `InteractionManager.runAfterInteractions` с крайним сроком.
 *
 * v4.32.582: очередь считается пустой, только когда возвращены ВСЕ выданные
 * handle. Их выдают анимации, жесты и навигация, и один потерянный handle
 * держит очередь занятой до конца жизни экрана — тогда колбэк не вызывается
 * никогда. Ровно это и случилось на вебе: react-native-web не имеет нативного
 * драйвера, `useNativeDriver: true` молча откатывается в JS, вечный цикл
 * скелетона брал handle на каждый шаг, и лента не начинала грузиться вообще.
 * Причину лечим в самих анимациях (`isInteraction: false`), но экран не должен
 * зависеть от того, что все анимации в приложении её соблюдают.
 *
 * Колбэк вызывается ровно один раз. Возвращённая функция снимает и то, и другое.
 */
export function runAfterInteractionsWithDeadline(
  fn: () => void,
  deadlineMs: number = INTERACTIONS_DEADLINE_MS
): Cancel {
  let done = false;
  // Оба поля читаются из `once`, а он может быть вызван и синхронно — до того,
  // как runAfterInteractions вернёт handle. Отсюда optional-обращение.
  let handle: { cancel: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    handle?.cancel();
    handle = null;
  };
  const once = (): void => {
    if (done) return;
    done = true;
    stop();
    fn();
  };
  handle = InteractionManager.runAfterInteractions(once);
  if (done) return () => undefined;
  timer = setTimeout(once, deadlineMs);
  return () => {
    if (done) return;
    done = true;
    stop();
  };
}

/** Промис-обёртка над {@link runAfterInteractionsWithDeadline}. Никогда не зависает. */
export function waitForInteractions(deadlineMs: number = INTERACTIONS_DEADLINE_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    runAfterInteractionsWithDeadline(resolve, deadlineMs);
  });
}
