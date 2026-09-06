import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { StatusBanner } from './StatusBanner';
import {
  isAccountSyncActive,
  rawStatus,
  readRelayPhase,
  settledStatus,
  subscribeAccountSync,
  type LiveStatus,
} from '../../core/net/connectionStatus';

/**
 * Как часто спрашиваем транспорт о состоянии подписки.
 *
 * Подписки на смену состояния он не отдаёт (файл помечен `@stable`), поэтому
 * состояние опрашивается. Секунда выбрана по задержке показа: при пороге в
 * полторы секунды человек видит «Соединение…» не позже чем через три. Хуже
 * всего складывается так: до секунды уходит на то, чтобы заметить смену, и
 * ещё два опроса — пока порог не перекрыт, полторы секунды приходятся на
 * середину второго. Само чтение — два поля объекта.
 */
const POLL_MS = 1_000;

/**
 * Полоска «Соединение…» / «Обновление…» (v4.32.610).
 *
 * Стоит рядом с очередью отправки и по той же причине: она объясняет, почему
 * очередь не убывает. Правило показа целиком лежит в connectionStatus.ts и
 * проверяется тестом; здесь только опрос и подписка.
 */
export function ConnectionStatus(): React.ReactElement | null {
  const [status, setStatus] = useState<LiveStatus>('idle');
  /** Что происходит и с какого момента — без этого задержка показа неоткуда взяться. */
  const heldRef = useRef<{ raw: LiveStatus; since: number }>({ raw: 'idle', since: Date.now() });

  const tick = useCallback(() => {
    const raw = rawStatus({ relay: readRelayPhase(), syncing: isAccountSyncActive() });
    const now = Date.now();
    if (raw !== heldRef.current.raw) heldRef.current = { raw, since: now };
    const next = settledStatus(raw, now - heldRef.current.since);
    setStatus((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer !== null) return;
      tick();
      timer = setInterval(tick, POLL_MS);
    };
    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    // В фоне опрашивать нечего: экрана не видно, а сокет в это время всё равно
    // живёт своей жизнью. Возвращение показывает состояние первым же тиком.
    if (AppState.currentState === 'active') start();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') start(); else stop();
    });
    const unsubscribeSync = subscribeAccountSync(tick);
    return () => {
      stop();
      appState.remove();
      unsubscribeSync();
    };
  }, [tick]);

  if (status === 'idle') return null;

  const connecting = status === 'connecting';
  return (
    <StatusBanner
      tone="neutral"
      icon={connecting ? 'cloud-outline' : 'sync-outline'}
      liveRegion="polite"
      text={connecting ? 'Соединение…' : 'Обновление…'}
    />
  );
}
