/**
 * PermissionsScreen — сводка разрешений: уведомления, микрофон, камера,
 * галерея, геолокация.
 *
 * При входе и при возвращении в приложение состояние только читается —
 * диалоги показываются лишь по нажатию. Очередь запросов, замок и отмена
 * живут в usePermissionsController; список разрешений — в permissionDefs.
 */

import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { SafeAreaView } from 'react-native-safe-area-context';
import { font, primaryInk, radius, spacing } from '../theme';
import { useColors, useThemedStyles } from '../ThemeContext';
import type { PermissionStatus } from './permissionStatus';
import { PERMISSION_DEFS, type PermissionDef } from './permissionDefs';
import { usePermissionsController } from '../hooks/usePermissionsController';

interface Props {
  onDone: () => void;
  /**
   * Список разрешений. По умолчанию — PERMISSION_DEFS; подменяется в тестах.
   * Должен быть стабильным (константа), иначе при каждой отрисовке
   * заново читались бы все статусы.
   */
  defs?: readonly PermissionDef[];
}

const STATUS_LABEL: Record<PermissionStatus, string> = {
  unknown: 'Не запрошено',
  granted: 'Разрешено ✓',
  limited: 'Частично',
  denied:  'Отказано',
  // «Отклонено» и «Отказано» на слух одно и то же, а состояния разные:
  // первое чинится нажатием, второе — только настройками системы.
  blocked: 'Запрещено',
};

/** Подсказка под карточкой — только там, где без неё непонятно, что делать. */
const STATUS_HINT: Partial<Record<PermissionStatus, string>> = {
  limited: 'Доступ только к выбранным фото. Расширить — в настройках системы, нажмите, чтобы открыть их.',
  denied: 'Нажмите, чтобы спросить ещё раз.',
  blocked: 'Выдать можно только в настройках системы — нажмите, чтобы открыть их.',
};

export function PermissionsScreen({ onDone, defs = PERMISSION_DEFS }: Props): React.ReactElement {
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    safe:    { flex: 1 as const, backgroundColor: c.background },
    content: { padding: spacing.lg, gap: spacing.md, paddingBottom: 40 },

    header: { alignItems: 'center' as const, gap: spacing.sm, paddingVertical: spacing.lg },
    logoEmoji: { fontSize: 48, lineHeight: 56 },
    title:     { fontSize: font.xxl, fontWeight: '800' as const, color: c.text },
    subtitle:  {
      fontSize: font.sm, color: c.textSecondary,
      textAlign: 'center' as const, lineHeight: 20, maxWidth: 300,
    },

    permCard: {
      flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md,
      backgroundColor: c.surface, borderRadius: radius.lg,
      padding: spacing.md, borderWidth: 1, borderColor: c.border,
    },
    permCardGranted: { borderColor: `${c.success}44` },

    permIcon:   { fontSize: 28 },
    permInfo:   { flex: 1 as const },
    permTitleRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, flexWrap: 'wrap' as const },
    permTitle:  { fontSize: font.md, fontWeight: '700' as const, color: c.text },
    requiredBadge: {
      fontSize: font.xs, fontWeight: '700' as const, color: c.accent,
      backgroundColor: `${c.primary}22`,
      paddingHorizontal: 5, paddingVertical: 1,
      borderRadius: radius.md, overflow: 'hidden' as const,
      textTransform: 'uppercase' as const, letterSpacing: 0.3,
    },
    permDesc:   { fontSize: font.sm, color: c.textSecondary, lineHeight: 18, marginTop: 2 },
    permHint:   { fontSize: font.xs, color: c.textMuted, lineHeight: 16, marginTop: 4 },

    permStatusWrap: { minWidth: 80, alignItems: 'flex-end' as const },
    statusBadge:    { borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3 },
    statusText:     { fontSize: font.xs, fontWeight: '600' as const },

    btnRow: { flexDirection: 'row' as const, gap: spacing.sm, marginTop: spacing.sm },
    primaryBtn: {
      flex: 1 as const, backgroundColor: c.primary, borderRadius: radius.md,
      height: 50, alignItems: 'center' as const, justifyContent: 'center' as const,
    },
    primaryBtnText: { color: primaryInk(c).text, fontSize: font.md, fontWeight: '700' as const },
    secondaryBtn: {
      flex: 1 as const, backgroundColor: c.surfaceHigh, borderRadius: radius.md,
      height: 50, alignItems: 'center' as const, justifyContent: 'center' as const,
      borderWidth: 1, borderColor: c.border,
    },
    // «Пропустить» не выключается никогда: уйти можно и посреди диалогов —
    // очередь при этом отменяется (см. leave).
    btnDisabled: { opacity: 0.5 },
    secondaryBtnText: { color: c.textSecondary, fontSize: font.md, fontWeight: '600' as const },

    note: { fontSize: 12, color: c.textMuted, textAlign: 'center' as const, lineHeight: 18 },
  }));
  const statusColor: Record<PermissionStatus, string> = {
    unknown: colors.textMuted,
    granted: colors.success,
    limited: colors.warning,
    denied:  colors.warning,
    blocked: colors.error,
  };
  const { statuses, requesting, busy, requestOne, requestAll, cancel } =
    usePermissionsController(defs);

  const allDone = defs.every((d) => statuses[d.id] !== 'unknown');

  // Уход с экрана отменяет очередь: иначе диалоги продолжали бы всплывать
  // поверх следующего экрана.
  const leave = useCallback(() => {
    cancel();
    onDone();
  }, [cancel, onDone]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.logoEmoji}>✈</Text>
          <Text style={styles.title}>Разрешения</Text>
          <Text style={styles.subtitle}>
            Разрешите доступ для полноценной работы мессенджера.
          </Text>
        </View>

        {defs.map((item) => {
          const status = statuses[item.id];
          return (
          <AppPressable
            key={item.id}
            style={[styles.permCard, status === 'granted' && styles.permCardGranted]}
            onPress={() => void requestOne(item.id)}
            disabled={busy}
            android_ripple={{ color: colors.ripple }}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}: ${STATUS_LABEL[status]}`}
            accessibilityHint={STATUS_HINT[status]}
            accessibilityState={{ disabled: busy, busy: requesting === item.id }}
            testID={`perm_${item.id}`}
          >
            <Text style={styles.permIcon}>{item.icon}</Text>
            <View style={styles.permInfo}>
              <View style={styles.permTitleRow}>
                <Text style={styles.permTitle}>{item.title}</Text>
                {item.required && (
                  <Text style={styles.requiredBadge}>рекомендуем</Text>
                )}
              </View>
              <Text style={styles.permDesc}>{item.description}</Text>
              {STATUS_HINT[status] ? (
                <Text style={styles.permHint}>{STATUS_HINT[status]}</Text>
              ) : null}
            </View>
            <View style={styles.permStatusWrap}>
              {requesting === item.id ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: `${statusColor[status]}22` },
                  ]}
                >
                  <Text style={[styles.statusText, { color: statusColor[status] }]}>
                    {STATUS_LABEL[status]}
                  </Text>
                </View>
              )}
            </View>
          </AppPressable>
          );
        })}

        <View style={styles.btnRow}>
          {!allDone ? (
            <AppPressable
              style={[styles.primaryBtn, busy && styles.btnDisabled]}
              onPress={() => void requestAll()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Разрешить всё"
              accessibilityState={{ disabled: busy, busy }}
              testID="perm_request_all"
            >
              <Text style={styles.primaryBtnText}>Разрешить всё</Text>
            </AppPressable>
          ) : null}
          <AppPressable
            style={[styles.secondaryBtn, allDone && styles.primaryBtn]}
            onPress={leave}
            accessibilityRole="button"
            accessibilityLabel={allDone ? 'Готово' : 'Пропустить'}
            testID="perm_skip"
          >
            <Text style={[styles.secondaryBtnText, allDone && styles.primaryBtnText]}>
              {allDone ? 'Готово →' : 'Пропустить'}
            </Text>
          </AppPressable>
        </View>

        <Text style={styles.note}>
          Разрешения можно изменить позже в настройках системы.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
