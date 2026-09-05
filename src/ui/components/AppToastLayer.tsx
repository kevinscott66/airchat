import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppPressable } from './AppPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTabBarInset } from '../TabBarInset';
import { elevation, font, radius, spacing, toastSurface } from '../theme';
import { addToastListener, TOAST_MS, type ToastSpec } from './appNotify';

/**
 * Слой тоста. Стоит в каждом окне приложения, а не один на всё приложение.
 *
 * Почему так — в doc-блоке `addToastListener`: `Modal` создаёт отдельное
 * нативное окно, и тост из дерева `App.tsx` оказывается ЗА ним. В 4.32.596
 * «ID скопирован» выезжал позади карточки профиля, из которой ID и копировали.
 *
 * Подложка намеренно тёмная в обеих темах: это `toastSurface`, тот же токен,
 * которым нарисован тост входящего сообщения, и чернила на нём уже подняты до
 * порога и проверяются контрастным тестом.
 */

/** Насколько тост уезжает вниз, пока его не видно. */
const TOAST_TRAVEL = 24;
/** Длительность появления и ухода. */
const TOAST_IN_MS = 180;
const TOAST_OUT_MS = 160;

export function AppToastLayer({ overlay = false }: {
  /**
   * Слой стоит внутри окна поверх приложения. Под таким окном нет плавающих
   * вкладок, и высоту таббара прибавлять не надо — иначе тост повиснет над
   * пустотой.
   */
  overlay?: boolean;
} = {}): React.ReactElement | null {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const insets = useSafeAreaInsets();
  const tabInset = useTabBarInset();
  const anim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    Animated.timing(anim, { toValue: 0, duration: TOAST_OUT_MS, useNativeDriver: true })
      .start(() => setToast(null));
  }, [anim]);

  useEffect(() => {
    // Новый тост вытесняет прежний: очередь здесь была бы хуже — человек
    // прочтёт последнее, а не то, что случилось три нажатия назад.
    return addToastListener((spec) => setToast(spec));
  }, []);

  useEffect(() => {
    if (!toast) return;
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: TOAST_IN_MS, useNativeDriver: true }).start();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(hide, TOAST_MS[toast.tone]);
    return () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };
  }, [toast, anim, hide]);

  if (!toast) return null;
  const ok = toast.tone === 'success';
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.toastWrap,
        { bottom: insets.bottom + (overlay ? 0 : tabInset) + spacing.md },
        {
          opacity: anim,
          transform: [{
            translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [TOAST_TRAVEL, 0] }),
          }],
        },
      ]}
    >
      <AppPressable style={[styles.toast, { backgroundColor: toastSurface.fill }]} onPress={hide}>
        <Ionicons
          name={ok ? 'checkmark-circle' : 'alert-circle'}
          size={font.xl}
          color={ok ? toastSurface.ink.success : toastSurface.ink.error}
          style={styles.toastIcon}
        />
        <Text style={[styles.toastText, { color: toastSurface.ink.text }]} numberOfLines={4}>
          {toast.message}
        </Text>
      </AppPressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toastWrap: { position: 'absolute', left: 0, right: 0, zIndex: 9998 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: '92%',
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    ...elevation.card,
  },
  toastIcon: { marginRight: spacing.sm },
  toastText: { flexShrink: 1, fontSize: font.sm },
});

export default AppToastLayer;
