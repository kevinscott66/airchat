import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { outboxCount, subscribeChatWrites } from '../../core/storage/local';
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
 */
export function OfflineStatus(): React.ReactElement | null {
  const [queueSize, setQueueSize] = useState(0);
  const queueSizeRef = useRef(0);
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
      const n = await outboxCount(profileManager.getActiveProfile()?.id ?? null);
      queueSizeRef.current = n;
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
    if (queueSize === 0) return undefined;
    const id = setInterval(() => {
      if (queueSizeRef.current > 0 && AppState.currentState === 'active') void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [queueSize, refresh]);

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

  if (queueSize === 0) return null;

  return (
    <StatusBanner
      tone="warn"
      icon="cloud-offline-outline"
      liveRegion="polite"
      text={`В очереди на отправку: ${queueSize}. Доставим при появлении сети или альтернативного канала.`}
    />
  );
}
