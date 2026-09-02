// @stable  Единая точка настройки defaults для всех кнопок приложения.
// v4.32.89: переключено с RNGH Pressable на core RN Pressable — RNGH-Pressable
// не доставлял onPress в top-level табах и пунктах «Ещё» (регрессия). Core
// Pressable работает везде, defaults (delayPressIn/Out=0) сохранены.
// v4.32.532: сюда же добавлен отклик нажатия — см. док-комментарий ниже.
import React from 'react';
import { Animated, Platform, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { motion } from '../theme';
import { isReducedMotion } from '../motionPrefs';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// delayPressIn/Out — legacy-совместимость со старым API core Pressable
type AppPressableProps = PressableProps & {
  delayPressIn?: number;
  delayPressOut?: number;
  /** Отключить сжатие при нажатии — для элементов, которые двигать нельзя. */
  noScale?: boolean;
};

/**
 * AppPressable — обёртка над core RN Pressable с нулевыми delayPressIn/Out
 * по умолчанию (мгновенный отклик).
 *
 * v4.32.532: нажатие сжимает элемент до `motion.pressScale` за `motion.fast` и
 * отпускает пружиной. Отклик живёт здесь, а не в экранах, ровно по той же
 * причине, по которой здесь живут delayPressIn/Out: кнопок 76 файлов, и
 * «современно и анимированно» не может означать «каждый экран заводит свою
 * анимацию со своей длительностью». Одна шкала, одно место, один вид.
 *
 * Функциональный `style` (`({ pressed }) => …`) поддержан: он вычисляется здесь
 * и складывается с трансформацией. Animated не умеет разбирать style-функцию,
 * а девятнадцать мест в коде на неё опираются, поэтому контракт сохранён, а не
 * сломан ради обёртки.
 *
 * `useNativeDriver` выключен на web: react-native-web не имеет нативного
 * драйвера и на каждой анимации печатает предупреждение.
 *
 * Системное «меньше движения» читается синхронно из `motionPrefs`, а не хуком:
 * подписка на каждую из 76 файлов кнопок — это сотни слушателей на одно булево.
 */
export const AppPressable = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  AppPressableProps
>(function AppPressable(
  { delayPressIn = 0, delayPressOut = 0, noScale = false, style, onPressIn, onPressOut, ...rest },
  ref
) {
  const scale = React.useRef(new Animated.Value(1)).current;
  const [pressed, setPressed] = React.useState(false);

  const handlePressIn = React.useCallback<NonNullable<PressableProps['onPressIn']>>(
    (e) => {
      setPressed(true);
      if (!noScale && !isReducedMotion()) {
        Animated.timing(scale, {
          toValue: motion.pressScale,
          duration: motion.fast,
          useNativeDriver: Platform.OS !== 'web',
        }).start();
      }
      onPressIn?.(e);
    },
    [noScale, onPressIn, scale]
  );

  const handlePressOut = React.useCallback<NonNullable<PressableProps['onPressOut']>>(
    (e) => {
      setPressed(false);
      if (!noScale && !isReducedMotion()) {
        Animated.spring(scale, {
          toValue: 1,
          ...motion.spring,
          useNativeDriver: Platform.OS !== 'web',
        }).start();
      }
      onPressOut?.(e);
    },
    [noScale, onPressOut, scale]
  );

  const resolved: StyleProp<ViewStyle> =
    typeof style === 'function' ? style({ pressed }) : style;

  return (
    <AnimatedPressable
      ref={ref}
      {...({ delayPressIn, delayPressOut } as object)}
      {...(rest as object)}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={noScale ? resolved : [resolved, { transform: [{ scale }] }]}
    />
  );
});
