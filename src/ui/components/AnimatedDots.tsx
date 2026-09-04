import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { useColors } from '../ThemeContext';

export type AnimatedDotsProps = {
  /** По умолчанию — акцент активной темы. */
  dotColor?: string;
  dotSize?: number;
  dotSpacing?: number;
  /** Длительность одного шага (подсветка одной позиции), мс */
  stepDurationMs?: number;
  /** Алиас для `stepDurationMs` (совместимость с LoadingScreen и др.) */
  animationDuration?: number;
  /** Непрозрачность «погасшей» точки */
  dimOpacity?: number;
};

const DEFAULT_DIM = 0.35;

/**
 * Три точки: бегущий акцент по кругу (0→1→2→0…).
 * Крутится без остановки, пока компонент смонтирован — на экране загрузки это «до полной прогрузки».
 */
export function AnimatedDots({
  dotColor: dotColorProp,
  dotSize = 8,
  dotSpacing = 10,
  stepDurationMs: stepDurationMsProp,
  animationDuration,
  dimOpacity = DEFAULT_DIM,
}: AnimatedDotsProps): React.ReactElement {
  const colors = useColors();
  const dotColor = dotColorProp ?? colors.accent;
  /** Один шаг = смена акцента на следующую точку; меньше — быстрее «бег по кругу». */
  const stepMs = stepDurationMsProp ?? animationDuration ?? 48;
  const dim = dimOpacity;
  const bright = 1;

  const a0 = useRef(new Animated.Value(dim)).current;
  const a1 = useRef(new Animated.Value(dim)).current;
  const a2 = useRef(new Animated.Value(dim)).current;

  /** Native driver: точки вынесены из родителя с opacity в LoadingScreen — не «замораживаются». */
  const useNativeDriver = true;

  useEffect(() => {
    // Linear — без «замедления на входе/выходе», иначе кажется что точки «тянутся».
    const easing = Easing.linear;
    const step = Math.max(28, Math.min(240, stepMs));

    const highlight = (active: 0 | 1 | 2): Animated.CompositeAnimation =>
      Animated.parallel([
        Animated.timing(a0, {
          toValue: active === 0 ? bright : dim,
          duration: step,
          easing,
          useNativeDriver,
          // Декоративный индикатор не должен держать handle InteractionManager:
          // на вебе useNativeDriver откатывается в JS, и вечный цикл иначе
          // навсегда занимает очередь runAfterInteractions.
          isInteraction: false,
        }),
        Animated.timing(a1, {
          toValue: active === 1 ? bright : dim,
          duration: step,
          easing,
          useNativeDriver,
          // Декоративный индикатор не должен держать handle InteractionManager:
          // на вебе useNativeDriver откатывается в JS, и вечный цикл иначе
          // навсегда занимает очередь runAfterInteractions.
          isInteraction: false,
        }),
        Animated.timing(a2, {
          toValue: active === 2 ? bright : dim,
          duration: step,
          easing,
          useNativeDriver,
          // Декоративный индикатор не должен держать handle InteractionManager:
          // на вебе useNativeDriver откатывается в JS, и вечный цикл иначе
          // навсегда занимает очередь runAfterInteractions.
          isInteraction: false,
        }),
      ]);

    // Полный круг без паузы; останавливается только при размонтировании (конец загрузки).
    const loop = Animated.loop(
      Animated.sequence([highlight(0), highlight(1), highlight(2)])
    );

    loop.start();

    return () => {
      loop.stop();
    };
  }, [dim, stepMs, a0, a1, a2, useNativeDriver]);

  const half = dotSpacing / 2;

  return (
    <View style={styles.container} accessibilityRole="progressbar">
      <Animated.View
        style={[
          styles.dot,
          {
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: dotColor,
            opacity: a0,
            marginHorizontal: half,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.dot,
          {
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: dotColor,
            opacity: a1,
            marginHorizontal: half,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.dot,
          {
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: dotColor,
            opacity: a2,
            marginHorizontal: half,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {},
});
