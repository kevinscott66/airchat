/**
 * Универсальные хуки для асинхронных кнопок в React Native.
 *
 * Решают три проблемы одновременно:
 *  1. Защита от двойного клика (гейт занятости)
 *  2. Throttle между кликами (отсчёт от начала нажатия)
 *  3. Откладывание тяжёлой работы на следующий тик, чтобы нажатие успело
 *     отрисоваться
 *
 * Само решение «пускать или нет» вынесено в asyncGuard — без React, чтобы его
 * можно было проверить тестом.
 */

import { useCallback, useRef, useState } from 'react';

import { createKeyGate, createPressGate, runAndSettle } from './asyncGuard';

// ─── Опции ────────────────────────────────────────────────────────────────────

export type UseAsyncButtonOptions = {
  /**
   * Минимальный интервал между кликами (мс).
   * Защищает от быстрых повторных нажатий (двойной тап, тремор).
   * Default: 80.
   */
  throttleMs?: number;
};

// ─── useAsyncButton ───────────────────────────────────────────────────────────

export type UseAsyncButtonResult<TArgs extends unknown[]> = {
  /** Передавать в onPress. Принимает те же аргументы, что и handler. */
  onPress: (...args: TArgs) => void;
  /** true пока handler выполняется — для disabled/ActivityIndicator. */
  loading: boolean;
};

/**
 * Хук для простых async-кнопок с глобальным loading-состоянием.
 *
 * Пример:
 * ```tsx
 * const { onPress, loading } = useAsyncButton(async () => {
 *   await publishPost(...);
 * });
 * <Pressable onPress={onPress} disabled={loading}>...</Pressable>
 * ```
 */
export function useAsyncButton<TArgs extends unknown[] = []>(
  handler: (...args: TArgs) => Promise<void>,
  options: UseAsyncButtonOptions = {},
): UseAsyncButtonResult<TArgs> {
  const { throttleMs = 80 } = options;

  const [loading, setLoading] = useState(false);
  const gateRef = useRef<ReturnType<typeof createPressGate> | null>(null);
  if (gateRef.current === null) gateRef.current = createPressGate();
  const gate = gateRef.current;

  const onPress = useCallback(
    (...args: TArgs) => {
      if (gate.tryStart(Date.now(), throttleMs) !== 'run') return;
      setLoading(true);

      // Запускаем синхронно — ripple уже рисуется на UI-потоке через RNGH Pressable
      runAndSettle(
        () => handler(...args),
        () => {
          gate.finish();
          setLoading(false);
        },
        (e) => {
          console.warn('[useAsyncButton] Unhandled error:', e);
        },
      );
    },
    [gate, handler, throttleMs],
  );

  return { onPress, loading };
}

// ─── useKeyedAsyncAction ──────────────────────────────────────────────────────

export type UseKeyedAsyncActionResult = {
  /**
   * Запустить action для ключа key.
   * Если для этого ключа action уже выполняется — вызов игнорируется.
   */
  run: (key: string, action: () => Promise<void>) => void;
  /**
   * true если для данного key action сейчас выполняется.
   *
   * Читается из ref, то есть НЕ вызывает ре-рендер при изменении: годится для
   * проверки внутри обработчика («второй тап отбросят — не показывай
   * оптимистичную правку»), но не для `disabled` в разметке — там значение
   * замёрзнет на том, каким было в последнем рендере.
   */
  isActive: (key: string) => boolean;
};

/**
 * Хук для действий, где нужна per-item защита от двойного клика.
 * Используется для реакций, репостов, отметки прочитанным — где ключ это id
 * поста/сообщения.
 *
 * Пример:
 * ```tsx
 * const reactionAction = useKeyedAsyncAction();
 *
 * const handleReaction = (postId: string, emoji: string) => {
 *   if (reactionAction.isActive(postId)) return; // оптимистичную правку не применяем
 *   applyOptimistic(postId, emoji);
 *   reactionAction.run(postId, async () => {
 *     await addAndBroadcastReaction(postId, emoji, did);
 *   });
 * };
 * ```
 */
export function useKeyedAsyncAction(): UseKeyedAsyncActionResult {
  // Ref — не state, потому что изменение активности не должно вызывать ре-рендер
  // (кнопки обычно сами управляют visual-состоянием через optimistic update)
  const gateRef = useRef<ReturnType<typeof createKeyGate> | null>(null);
  if (gateRef.current === null) gateRef.current = createKeyGate();
  const gate = gateRef.current;

  const isActive = useCallback((key: string) => gate.isActive(key), [gate]);

  const run = useCallback(
    (key: string, action: () => Promise<void>) => {
      if (!gate.tryStart(key)) return;

      // setTimeout, а не requestAnimationFrame: кадры на фоне не идут, и
      // отложенная через rAF работа зависала бы до возвращения в приложение —
      // а здесь это запись в базу и отправка собеседнику. Нулевой таймер
      // выпускает текущий кадр и при этом выполняется всегда.
      setTimeout(() => {
        runAndSettle(
          action,
          () => gate.finish(key),
          (e) => {
            console.warn(`[useKeyedAsyncAction] key=${key} unhandled error:`, e);
          },
        );
      }, 0);
    },
    [gate],
  );

  return { run, isActive };
}
