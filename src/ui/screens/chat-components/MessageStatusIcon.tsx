import React from 'react';
import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../components/AppPressable';
import { useColors } from '../../ThemeContext';
import { bubbleInk } from '../../theme';

// ─── Message status icon ─────────────────────────────────────────────────────
//
// Иконка рисуется только у исходящих сообщений (`direction === 'in'` → null), а
// исходящий пузырь тёмный в обеих темах — поэтому цвета здесь долго стояли
// фиксированными (v4.32.344).
//
// v4.32.346: у сообщения из одних эмодзи пузыря нет — фон прозрачный, и иконка
// оказывается на фоне чата. В светлой теме прежние '#7ecbff' (1.5:1) и
// '#8e8e93' (2.8:1) там попросту исчезали. Поверхность стала приходить явным
// признаком: на заливке пузыря — свои цвета, иначе — палитра.
//
// v4.32.386: но «свои цвета» так и оставались тремя литералами под неверной
// посылкой, что пузырь тёмный всегда. В светлой теме он #0068D6, и на нём те
// же значения давали 1.63:1 у галочек и 2.34:1 у ошибки — то есть починили
// эмодзи-случай, а сам пузырь оставили нечитаемым. Теперь цвет на заливке
// считается из палитры тем же правилом, что и ссылка в пузыре (см. bubbleInk).
export function MessageStatusIcon({
  status,
  cid,
  direction,
  onDarkFill,
  onRetry,
}: {
  status: string;
  cid: string | null;
  direction: 'in' | 'out';
  /** Иконка лежит на тёмной заливке пузыря, а не на фоне чата. */
  onDarkFill: boolean;
  onRetry?: () => void;
}): React.ReactElement | null {
  const colors = useColors();
  if (direction === 'in') return null;
  const ink = bubbleInk(colors);
  // Нейтральный цвет: «отправлено», «доставлено», «в очереди», «отправляется».
  const idle = onDarkFill ? ink.muted : colors.textMuted;
  const read = onDarkFill ? ink.accent : colors.accent;
  const failed = onDarkFill ? ink.error : colors.error;
  if (status === 'sent' && !cid) {
    return (
      <Ionicons
        name="cloud-upload-outline"
        size={14}
        color={idle}
        accessibilityLabel="В очереди на отправку"
        style={{ marginLeft: 2 }}
      />
    );
  }
  switch (status) {
    case 'read':
      return <Ionicons name="checkmark-done" size={14} color={read} style={{ marginLeft: 2 }} accessibilityLabel="Прочитано" />;
    case 'delivered':
      return <Ionicons name="checkmark-done-outline" size={14} color={idle} style={{ marginLeft: 2 }} accessibilityLabel="Доставлено" />;
    case 'sent':
      return <Ionicons name="checkmark-outline" size={14} color={idle} style={{ marginLeft: 2 }} accessibilityLabel="Отправлено" />;
    case 'sending':
      return <ActivityIndicator size="small" color={idle} style={{ width: 14, height: 14, marginLeft: 4 }} accessibilityLabel="Отправляется…" />;
    case 'failed':
      return (
        <AppPressable onPress={onRetry} hitSlop={8}>
          <Ionicons name="alert-circle-outline" size={14} color={failed} style={{ marginLeft: 2 }} accessibilityLabel="Нажмите для повтора" />
        </AppPressable>
      );
    default:
      return <Ionicons name="time-outline" size={14} color={idle} style={{ marginLeft: 2 }} />;
  }
}
