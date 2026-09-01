import React from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { useColors } from '../ThemeContext';
import { lightColors, withAlpha } from '../theme';

export type GlassSurfaceProps = ViewProps & {
  /** Нативная сила blur. На Android и web работает как graceful fallback. */
  intensity?: number;
  /** Выраженность стеклянной подложки. */
  variant?: 'clear' | 'regular' | 'prominent';
  style?: StyleProp<ViewStyle>;
};

/**
 * Единый контейнер Liquid Glass для крупных функциональных слоёв.
 *
 * Glass применяется только к навигации и важным панелям: большое количество
 * независимых blur-контейнеров дорого для рендера и ухудшает читаемость.
 */
export function GlassSurface({
  children,
  intensity = 42,
  variant = 'regular',
  style,
  ...viewProps
}: GlassSurfaceProps): React.ReactElement {
  const colors = useColors();
  const fillAlpha = variant === 'clear' ? 0.34 : variant === 'prominent' ? 0.78 : 0.62;
  const tint = colors.background === lightColors.background ? 'light' : 'dark';

  return (
    <View
      {...viewProps}
      style={[
        styles.container,
        {
          backgroundColor: withAlpha(colors.surface, fillAlpha),
          borderColor: withAlpha(colors.text, Platform.OS === 'web' ? 0.1 : 0.16),
        },
        style,
      ]}
    >
      <BlurView
        pointerEvents="none"
        intensity={intensity}
        tint={tint}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  content: {
    flexGrow: 0,
  },
});
