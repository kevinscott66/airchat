import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal } from './AppModal';
import { AppPressable } from './AppPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { useTabBarInset } from '../TabBarInset';
import { elevation, font, radius, scrim, spacing, toastSurface, withAlpha } from '../theme';
import { installThemedAlert, uninstallThemedAlert } from './appAlert';
import {
  setConfirmListener,
  setToastListener,
  TOAST_MS,
  type ConfirmActionSpec,
  type ConfirmSpec,
  type ToastSpec,
} from './appNotify';

/**
 * Тост и диалог подтверждения приложения — в тему, а не системные.
 *
 * Монтируется один раз в `App.tsx`. Почему шина уведомлений лежит отдельным
 * модулем и что было до неё — в doc-блоке `appNotify.ts`.
 *
 * Подложка тоста намеренно тёмная в обеих темах: это `toastSurface`, тот же
 * токен, которым нарисован тост входящего сообщения, и чернила на нём уже
 * подняты до порога и проверяются контрастным тестом.
 */

/** Насколько тост уезжает вниз, пока его не видно. */
const TOAST_TRAVEL = 24;
/** Длительность появления и ухода. */
const TOAST_IN_MS = 180;
const TOAST_OUT_MS = 160;

export function AppNotifyHost(): React.ReactElement {
  // Пока хост в дереве, системный Alert.alert перенаправлен сюда — см. appAlert.
  useEffect(() => {
    installThemedAlert();
    return uninstallThemedAlert;
  }, []);
  return (
    <>
      <ToastLayer />
      <ConfirmLayer />
    </>
  );
}

function ToastLayer(): React.ReactElement | null {
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
    setToastListener((spec) => setToast(spec));
    return () => setToastListener(null);
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
        { bottom: insets.bottom + tabInset + spacing.md },
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

function ConfirmLayer(): React.ReactElement {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    setConfirmListener((next) => setSpec(next));
    return () => setConfirmListener(null);
  }, []);

  const close = useCallback(() => setSpec(null), []);

  const pick = useCallback((action: ConfirmActionSpec) => {
    // Сначала закрываем окно, потом зовём обработчик: он сам может открыть
    // следующее окно, а два Modal на одном кадре конфликтуют анимациями.
    setSpec(null);
    // Обработчик у «Отмены» тоже вызывается: у системного Alert кнопка со
    // style: 'cancel' умеет свой onPress, и молча его терять нельзя.
    if (!action.onPress) return;
    const run = action.onPress;
    requestAnimationFrame(() => run());
  }, []);

  return (
    <AppModal
      visible={spec !== null}
      transparent
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
    >
      <AppPressable style={styles.backdrop} onPress={close}>
        <AppPressable
          style={[
            styles.card,
            elevation.overlay,
            {
              backgroundColor: colors.surface,
              borderColor: withAlpha(colors.text, 0.12),
              marginBottom: insets.bottom,
            },
          ]}
          onPress={noop}
        >
          {spec ? (
            <>
              {/* Текст прокручивается, кнопки — нет: длинный перевод или
                  список из шести действий не должен выталкивать «Отмену» за
                  край экрана. */}
              <ScrollView style={styles.body} keyboardShouldPersistTaps="always">
                <Text style={[styles.title, { color: colors.text }]}>{spec.title}</Text>
                {spec.message ? (
                  <Text style={[styles.message, { color: colors.textSecondary }]}>{spec.message}</Text>
                ) : null}
              </ScrollView>
              <View style={styles.actions}>
                {spec.actions.map((action, idx) => (
                  <AppPressable
                    key={`${action.label}-${idx}`}
                    style={[
                      styles.action,
                      {
                        backgroundColor: action.cancel
                          ? 'transparent'
                          : withAlpha(action.destructive ? colors.error : colors.accent, 0.14),
                      },
                    ]}
                    onPress={() => pick(action)}
                  >
                    <Text
                      style={[
                        styles.actionLabel,
                        {
                          color: action.destructive
                            ? colors.error
                            : action.cancel ? colors.textSecondary : colors.accent,
                        },
                      ]}
                      numberOfLines={2}
                    >
                      {action.label}
                    </Text>
                  </AppPressable>
                ))}
              </View>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </AppModal>
  );
}

const noop = () => {};

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

  backdrop: {
    flex: 1,
    backgroundColor: scrim.modal,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '86%',
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  body: { flexGrow: 0 },
  title: { fontSize: font.lg, fontWeight: '700' },
  message: { fontSize: font.sm, marginTop: spacing.sm, lineHeight: font.xl },
  actions: { marginTop: spacing.lg },
  action: {
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  actionLabel: { fontSize: font.md, fontWeight: '600' },
});

export default AppNotifyHost;
