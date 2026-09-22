import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { bannerColors } from './StatusBanner';
import { useTheme } from '../ThemeContext';
import { font, radius } from '../theme';
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
 * Капсула «Соединение…» / «Обновление…» (v4.32.610).
 *
 * Объясняет, почему очередь отправки не убывает. Правило показа целиком лежит
 * в connectionStatus.ts и проверяется тестом; здесь опрос, подписка и место.
 *
 * Место — поверх экрана, сразу под строкой состояния. Раньше это была полоска
 * в общем потоке над экраном: безопасную зону сверху она не учитывала и
 * ложилась на часы и «остров», а своей высотой сдвигала вниз весь экран —
 * вместе со штампом, который из-за этого выезжал из-под «острова». Капсула не
 * занимает места в раскладке и не перехватывает касаний: состояние короткое,
 * и шапка под ним должна нажиматься как обычно.
 */
export function ConnectionStatus(): React.ReactElement | null {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
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
  const { ink, fill, border } = bannerColors('neutral', colors);
  return (
    <View pointerEvents="none" style={[styles.layer, { top: insets.top + 4 }]}>
      <View style={[styles.capsule, { backgroundColor: fill, borderColor: border }]}>
        <Ionicons name={connecting ? 'cloud-outline' : 'sync-outline'} size={12} color={ink} />
        <Text style={[styles.text, { color: ink }]} accessibilityLiveRegion="polite">
          {connecting ? 'Соединение…' : 'Обновление…'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1000,
    elevation: 1000,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: font.xs, marginLeft: 5 },
});
