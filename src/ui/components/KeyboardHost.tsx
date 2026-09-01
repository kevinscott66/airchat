// src/ui/components/KeyboardHost.tsx
//
// Единая обёртка, гарантирующая что инпут остаётся выше клавиатуры на всех экранах.
//
// Правила:
//   • iOS: KeyboardAvoidingView behavior="padding" с offset = insets.top + extraOffset.
//          На iOS Safe Area Provider + padding = инпут поднимается на высоту клавиатуры.
//   • Android: windowSoftInputMode="adjustResize" в манифесте уже корректно ресайзит
//             корневую View. Для экранов дополнительный KAV не нужен (и даже вреден —
//             может вызвать double-padding). Возвращаем прозрачный <View style={{flex:1}}>.
//   • Внутри <Modal/> (variant="modal"): Android <Modal> НЕ наследует softInputMode
//             → нужен KAV на обеих платформах. offset = extraOffset.
//
// Использование:
//   <KeyboardHost>                       // для корня экрана
//     <View style={{flex:1}}> ... </View>
//   </KeyboardHost>
//
//   <KeyboardHost variant="modal" extraOffset={0}>
//     <Modal-контент с TextInput>
//   </KeyboardHost>

import React from 'react';
import { KeyboardAvoidingView, Platform, StyleProp, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface KeyboardHostProps {
  children: React.ReactNode;
  /**
   * "screen"  — корень экрана. На Android возвращает обычный View (manifest ресайзит).
   * "modal"   — внутри <Modal/>. На Android тоже оборачивается KAV.
   */
  variant?: 'screen' | 'modal';
  /**
   * Доп. смещение к keyboardVerticalOffset. Обычно = высота навигационного header'а,
   * если экран отрисован под ним. 0 если корень контейнера уже ниже header.
   */
  extraOffset?: number;
  style?: StyleProp<ViewStyle>;
}

const defaultStyle: ViewStyle = { flex: 1 };

export function KeyboardHost({
  children,
  variant = 'screen',
  extraOffset = 0,
  style,
}: KeyboardHostProps) {
  const insets = useSafeAreaInsets();

  // Стратегия:
  //   • iOS любой variant           → KAV behavior="padding" (iOS безусловно нужен KAV).
  //   • Android variant="modal"     → KAV behavior="height"  (внутри <Modal/> softInputMode НЕ работает).
  //   • Android variant="screen"    → обычный View.
  //        В styles.xml для AppTheme установлено enableEdgeToEdge=false + adjustResize в
  //        манифесте — этого достаточно, дополнительный KAV даст double-compensation.
  //
  // keyboardVerticalOffset:
  //   • screen: top safe area inset + extraOffset.
  //   • modal:  только extraOffset.

  const needsAvoider = Platform.OS === 'ios' || variant === 'modal';

  if (!needsAvoider) {
    return <View style={[defaultStyle, style]}>{children}</View>;
  }

  const behavior = Platform.OS === 'ios' ? 'padding' : 'height';
  const offset =
    variant === 'modal'
      ? extraOffset
      : (Platform.OS === 'ios' ? insets.top : 0) + extraOffset;

  return (
    <KeyboardAvoidingView
      style={[defaultStyle, style]}
      behavior={behavior}
      keyboardVerticalOffset={offset}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

export default KeyboardHost;
