/**
 * PermissionsScreen — shown on first launch.
 * Explains and requests required permissions:
 *   - Notifications (optional, for message alerts)
 *   - Microphone (voice messages and calls)
 *   - Camera (take photos to send)
 *   - Media Library / Gallery (send photos from gallery)
 *   - Location (send location in messages)
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { SafeAreaView } from 'react-native-safe-area-context';
import { font, primaryInk, radius, spacing } from '../theme';
import { useColors, useThemedStyles } from '../ThemeContext';
import {
  mapAndroidPermission,
  mapExpoPermission,
  permissionTapAction,
  type PermissionStatus,
} from './permissionStatus';

interface PermItem {
  id: string;
  icon: string;
  title: string;
  description: string;
  status: PermissionStatus;
  required: boolean;
  request: () => Promise<PermissionStatus>;
}

async function requestNotificationPermission(): Promise<PermissionStatus> {
  const androidVersion =
    typeof Platform.Version === 'string'
      ? parseInt(Platform.Version, 10)
      : (Platform.Version as number);
  if (Platform.OS === 'android' && androidVersion >= 33) {
    try {
      const { PermissionsAndroid } = await import('react-native');
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
      return mapAndroidPermission(result);
    } catch {
      return 'unknown';
    }
  }
  return 'granted';
}

async function requestRecordAudioPermission(): Promise<PermissionStatus> {
  if (Platform.OS !== 'android') return 'granted';
  try {
    const { PermissionsAndroid } = await import('react-native');
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: 'Микрофон',
        message: 'Для голосовых сообщений и звонков.',
        buttonPositive: 'Разрешить',
        buttonNegative: 'Пропустить',
      }
    );
    return mapAndroidPermission(result);
  } catch {
    return 'unknown';
  }
}

async function requestCameraPermission(): Promise<PermissionStatus> {
  try {
    const ImagePicker = await import('expo-image-picker');
    return mapExpoPermission(await ImagePicker.requestCameraPermissionsAsync());
  } catch {
    return 'unknown';
  }
}

async function requestMediaLibraryPermission(): Promise<PermissionStatus> {
  try {
    const ImagePicker = await import('expo-image-picker');
    return mapExpoPermission(await ImagePicker.requestMediaLibraryPermissionsAsync());
  } catch {
    return 'unknown';
  }
}

async function requestLocationPermission(): Promise<PermissionStatus> {
  try {
    const Location = await import('expo-location');
    return mapExpoPermission(await Location.requestForegroundPermissionsAsync());
  } catch {
    // Fallback for Android < 23
    if (Platform.OS !== 'android') return 'granted';
    try {
      const { PermissionsAndroid } = await import('react-native');
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Геолокация',
          message: 'Для отправки местоположения в сообщениях.',
          buttonPositive: 'Разрешить',
          buttonNegative: 'Пропустить',
        }
      );
      return mapAndroidPermission(result);
    } catch {
      return 'unknown';
    }
  }
}

interface Props {
  onDone: () => void;
}

const STATUS_LABEL: Record<PermissionStatus, string> = {
  unknown: 'Не запрошено',
  granted: 'Разрешено ✓',
  denied:  'Отказано',
  // «Отклонено» и «Отказано» на слух одно и то же, а состояния разные:
  // первое чинится нажатием, второе — только настройками системы.
  blocked: 'Запрещено',
};

/** Подсказка под карточкой — только там, где без неё непонятно, что делать. */
const STATUS_HINT: Partial<Record<PermissionStatus, string>> = {
  denied: 'Нажмите, чтобы спросить ещё раз.',
  blocked: 'Выдать можно только в настройках системы — нажмите, чтобы открыть их.',
};

export function PermissionsScreen({ onDone }: Props): React.ReactElement {
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
    secondaryBtnText: { color: c.textSecondary, fontSize: font.md, fontWeight: '600' as const },

    note: { fontSize: 12, color: c.textMuted, textAlign: 'center' as const, lineHeight: 18 },
  }));
  const statusColor: Record<PermissionStatus, string> = {
    unknown: colors.textMuted,
    granted: colors.success,
    denied:  colors.warning,
    blocked: colors.error,
  };
  const [items, setItems] = useState<PermItem[]>([
    {
      id: 'notifications',
      icon: '🔔',
      title: 'Уведомления',
      description: 'Оповещения о новых сообщениях, когда приложение свёрнуто.',
      status: 'unknown',
      required: false,
      request: requestNotificationPermission,
    },
    {
      id: 'microphone',
      icon: '🎙️',
      title: 'Микрофон',
      description: 'Для голосовых сообщений и звонков.',
      status: 'unknown',
      required: true,
      request: requestRecordAudioPermission,
    },
    {
      id: 'camera',
      icon: '📷',
      title: 'Камера',
      description: 'Для съёмки и отправки фото прямо из чата.',
      status: 'unknown',
      required: false,
      request: requestCameraPermission,
    },
    {
      id: 'gallery',
      icon: '🖼️',
      title: 'Галерея',
      description: 'Для прикрепления фото и видео из вашей галереи.',
      status: 'unknown',
      required: false,
      request: requestMediaLibraryPermission,
    },
    {
      id: 'location',
      icon: '📍',
      title: 'Геолокация',
      description: 'Для отправки вашего местоположения в сообщениях.',
      status: 'unknown',
      required: false,
      request: requestLocationPermission,
    },
  ]);
  const [requesting, setRequesting] = useState<string | null>(null);

  const allDone = items.every((i) => i.status !== 'unknown');

  const requestPerm = useCallback(
    async (id: string) => {
      const item = items.find((i) => i.id === id);
      if (!item) return;
      const action = permissionTapAction(item.status);
      if (action === 'none') return;
      if (action === 'open_settings') {
        void Linking.openSettings();
        return;
      }

      setRequesting(id);
      try {
        const status = await item.request();
        setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
      } finally {
        // Без finally сорвавшийся запрос оставлял бы вечный спиннер на карточке.
        setRequesting(null);
      }
    },
    [items]
  );

  const requestAll = async (): Promise<void> => {
    // Только те, у которых есть что спрашивать. Иначе «Разрешить всё» посреди
    // прохода выкидывало человека в настройки системы из-за одного отклонённого.
    for (const item of items) {
      if (permissionTapAction(item.status) === 'request') {
        await requestPerm(item.id);
      }
    }
  };

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

        {items.map((item) => (
          <AppPressable
            key={item.id}
            style={[styles.permCard, item.status === 'granted' && styles.permCardGranted]}
            onPress={() => void requestPerm(item.id)}
            android_ripple={{ color: colors.ripple }}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}: ${STATUS_LABEL[item.status]}`}
            accessibilityHint={STATUS_HINT[item.status]}
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
              {STATUS_HINT[item.status] ? (
                <Text style={styles.permHint}>{STATUS_HINT[item.status]}</Text>
              ) : null}
            </View>
            <View style={styles.permStatusWrap}>
              {requesting === item.id ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: `${statusColor[item.status]}22` },
                  ]}
                >
                  <Text style={[styles.statusText, { color: statusColor[item.status] }]}>
                    {STATUS_LABEL[item.status]}
                  </Text>
                </View>
              )}
            </View>
          </AppPressable>
        ))}

        <View style={styles.btnRow}>
          {!allDone ? (
            <AppPressable style={styles.primaryBtn} onPress={() => void requestAll()}>
              <Text style={styles.primaryBtnText}>Разрешить всё</Text>
            </AppPressable>
          ) : null}
          <AppPressable
            style={[styles.secondaryBtn, allDone && styles.primaryBtn]}
            onPress={onDone}
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
