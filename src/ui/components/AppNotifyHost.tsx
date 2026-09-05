import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppModal } from './AppModal';
import { AppPressable } from './AppPressable';
import { AppToastLayer } from './AppToastLayer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { elevation, font, radius, scrim, spacing, withAlpha } from '../theme';
import { installThemedAlert, uninstallThemedAlert } from './appAlert';
import {
  setConfirmListener,
  type ConfirmActionSpec,
  type ConfirmSpec,
} from './appNotify';

/**
 * Тост и диалог подтверждения приложения — в тему, а не системные.
 *
 * Монтируется один раз в `App.tsx`. Почему шина уведомлений лежит отдельным
 * модулем и что было до неё — в doc-блоке `appNotify.ts`.
 *
 * Сам тост рисует `AppToastLayer`, и здесь стоит лишь его нижний, «приложенный»
 * экземпляр: такой же слой есть в каждом `AppModal`, иначе тост оставался бы за
 * открытым окном.
 */

export function AppNotifyHost(): React.ReactElement {
  // Пока хост в дереве, системный Alert.alert перенаправлен сюда — см. appAlert.
  useEffect(() => {
    installThemedAlert();
    return uninstallThemedAlert;
  }, []);
  return (
    <>
      <AppToastLayer />
      <ConfirmLayer />
    </>
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
