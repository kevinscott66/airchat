import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { outboxCountTry, subscribeChatWrites } from '../../core/storage/local';
import { profileManager } from '../../core/identity/profileManager';
import { runSyncIfOnline } from '../../core/storage/sync';
import { StatusBanner } from './StatusBanner';
import { createCoalescedTask } from '../../core/utils/coalescedTask';
import { log } from '../../core/logger';
import { rawErrorText } from './userErrorText';

const POLL_MS = 6000;

/**
 * Показывает число сообщений в офлайн-очереди (SQLite outbox) и периодически пытается sync при сети.
 *
 * v4.32.385: карточка была своя, с тёмно-коричневой заливкой '#2a2318' и
 * текстом '#e8b060', вписанными руками, — в светлой теме это тёмное пятно
 * поверх белого фона. Теперь общая полоска состояния, цвет — от назначения.
 *
 * v4.32.1042: подсчёт спрашивается исходом. Прежде отказ SQLite возвращался
 * нулём, и это значило три вещи разом. Полоска пропадала — единственный
 * признак того, что письмо ещё не ушло, а человек из её отсутствия делает
 * ровно один вывод. Опрос останавливался: интервал ниже заводится только на
 * непустой очереди. И `runSyncIfOnline` отсюда больше не звался — он под
 * `n > 0`. То есть одна занятая база превращалась в «всё отправлено» и в
 * молчание до следующей записи в чат, смены сети или возврата в приложение.
 */
export function OfflineStatus(): React.ReactElement | null {
  const [queueSize, setQueueSize] = useState(0);
  const queueSizeRef = useRef(0);
  /**
   * Подсчёт не удался, а прежнего числа нет. Утверждать «очередь пуста» тут
   * нечем: полоска говорит, что выяснить не вышло, и опрос продолжается.
   */
  const [countUnknown, setCountUnknown] = useState(false);
  const countUnknownRef = useRef(false);
  // v4.32.545: повтора здесь нет намеренно — подсчёт очереди идемпотентен, и
  // просьба, пришедшая во время подсчёта, ничего к нему не добавит. А вот
  // отказ прежде уходил в `void refresh()` и пропадал: число в очереди
  // застывало, и выглядело это как «ничего не отправляется».
  const refreshTaskRef = useRef(
    createCoalescedTask({
      repeat: false,
      onError: (e) => log.warn('ui_offline_refresh_failed', { err: rawErrorText(e) }),
    }),
  );

  const refresh = useCallback(async () => {
    await refreshTaskRef.current.run(async () => {
      // v4.32.522: очередь считается по активному профилю, и профиль
      // спрашивается каждый раз — переключение аккаунта меняет ответ, а этот
      // подсчёт живёт весь срок жизни экрана.
      const read = await outboxCountTry(profileManager.getActiveProfile()?.id ?? null);
      if (read === null) {
        // Прежнее число остаётся на месте: оно было прочитано, а это — нет.
        const unknown = queueSizeRef.current === 0;
        countUnknownRef.current = unknown;
        setCountUnknown((previous) => previous === unknown ? previous : unknown);
        // Отправку всё равно подталкиваем: в очереди может лежать письмо, и
        // отказ подсчёта — не повод его там оставить.
        if (AppState.currentState === 'active') await runSyncIfOnline();
        return;
      }
      const n = read.n;
      queueSizeRef.current = n;
      countUnknownRef.current = false;
      setCountUnknown((previous) => previous === false ? previous : false);
      setQueueSize((previous) => previous === n ? previous : n);
      if (n > 0 && AppState.currentState === 'active') {
        await runSyncIfOnline();
      }
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Непрочитанный подсчёт держит опрос живым наравне с непустой очередью:
    // иначе один отказ базы останавливал бы его до внешнего события.
    if (queueSize === 0 && !countUnknown) return undefined;
    const id = setInterval(() => {
      if (
        (queueSizeRef.current > 0 || countUnknownRef.current) &&
        AppState.currentState === 'active'
      ) {
        void refresh();
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [queueSize, countUnknown, refresh]);

  useEffect(() => {
    const trigger = () => { if (AppState.currentState === 'active') void refresh(); };
    const unsubscribeWrites = subscribeChatWrites(trigger);
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      if (state.isConnected) trigger();
    });
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') trigger();
    });
    return () => {
      unsubscribeWrites();
      unsubscribeNetwork();
      appState.remove();
    };
  }, [refresh]);

  if (queueSize === 0 && !countUnknown) return null;

  return (
    <StatusBanner
      tone="warn"
      icon="cloud-offline-outline"
      liveRegion="polite"
      text={
        queueSize === 0
          ? 'Сколько сообщений ждёт отправки, выяснить не удалось: хранилище не ответило. Отправку продолжаем — пересчитаем, как только оно освободится.'
          : `В очереди на отправку: ${queueSize}. Доставим при появлении сети или альтернативного канала.`
      }
    />
  );
}
