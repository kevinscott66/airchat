import React from 'react';
import { View, type StyleProp, type ViewStyle, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '../ThemeContext';

export type SafeScreenEdges = ('top' | 'bottom' | 'left' | 'right')[];

export type SafeScreenProps = {
  children: React.ReactNode;
  /** Какие края учитывать (insets от вырезов и системных панелей). */
  edges?: SafeScreenEdges;
  /** По умолчанию — фон активной темы. */
  backgroundColor?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Обёртка с отступами safe-area (в т.ч. нижняя панель навигации Android).
 * Используйте на полноэкранных экранах вне кастомного таб-бара.
 */
export function SafeScreen({
  children,
  edges = ['top', 'bottom', 'left', 'right'],
  backgroundColor,
  style,
}: SafeScreenProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  // v4.32.345: по умолчанию было '#0b1020' — фон тёмной темы. Из 18 мест, где
  // SafeScreen вызывается без явного цвета, в светлой теме все получали
  // тёмно-синюю рамку по краям экрана: полосы под вырезом и над навигационной
  // кнопкой рисуются самим SafeScreen, содержимое — уже экраном.
  const colors = useColors();
  const bg = backgroundColor ?? colors.background;
  const paddingTop = edges.includes('top') ? insets.top : 0;
  const paddingBottom = edges.includes('bottom') ? insets.bottom : 0;
  const paddingLeft = edges.includes('left') ? insets.left : 0;
  const paddingRight = edges.includes('right') ? insets.right : 0;

  return (
    <View
      style={[
        styles.flex,
        {
          backgroundColor: bg,
          paddingTop,
          paddingBottom,
          paddingLeft,
          paddingRight,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
