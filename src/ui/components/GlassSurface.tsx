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
import { glass, lightColors, withAlpha } from '../theme';
import { useReducedTransparency } from '../motionPrefs';

export type GlassSurfaceProps = ViewProps & {
  /** Нативная сила blur. По умолчанию берётся из `glass.intensity[variant]`. */
  intensity?: number;
  /** Выраженность стеклянной подложки. */
  variant?: 'clear' | 'regular' | 'prominent';
  /** Кромка сверху — «толщина» стекла. Выключается там, где панель прижата к краю. */
  rim?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * Единый контейнер Liquid Glass для крупных функциональных слоёв.
 *
 * Glass применяется только к навигации и важным панелям: большое количество
 * независимых blur-контейнеров дорого для рендера и ухудшает читаемость.
 *
 * v4.32.532: добавлена кромка. Стекло — это три слоя, а не один: размытие
 * подложки, полупрозрачная заливка поверх него и светлый кант по верхнему краю
 * с тёмным по нижнему. Кант и есть то, что отличает стекло от матового окна:
 * он показывает толщину. Без него панель выглядит как замыленный участок фона.
 *
 * Числа берутся из `glass` в теме, а не пишутся здесь, чтобы «сколько стекла»
 * настраивалось в одном месте вместе с остальными токенами.
 *
 * Системное «уменьшить прозрачность» выключает размытие целиком и делает
 * подложку глухой. Стекло — это украшение поверх содержимого; человеку, которому
 * оно мешает читать, оно не должно доставаться ни в каком виде.
 *
 * Дети рендерятся прямо в контейнер, без промежуточной обёртки: обёртка сбивала
 * `flexDirection` со стиля, переданного снаружи, и шапка диалога разъезжалась в
 * три строки. Кромки лежат абсолютом, поэтому порядок детей им не мешает.
 */
export function GlassSurface({
  children,
  intensity,
  variant = 'regular',
  rim = true,
  style,
  ...viewProps
}: GlassSurfaceProps): React.ReactElement {
  const colors = useColors();
  const isLight = colors.background === lightColors.background;
  const tint = isLight ? 'light' : 'dark';
  const solid = useReducedTransparency();
  const fillAlpha = solid ? 1 : glass.fill[variant];

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
      {solid ? null : (
        <BlurView
          pointerEvents="none"
          intensity={intensity ?? glass.intensity[variant]}
          tint={tint}
          style={StyleSheet.absoluteFill}
        />
      )}
      {rim ? (
        <>
          <View
            pointerEvents="none"
            style={[styles.rim, { backgroundColor: withAlpha(colors.text, glass.rim) }]}
          />
          <View
            pointerEvents="none"
            style={[styles.shade, { backgroundColor: withAlpha(glass.shadeInk, glass.shade) }]}
          />
        </>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  rim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
  },
  shade: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
  },
});
