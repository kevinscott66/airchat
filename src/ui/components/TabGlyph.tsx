import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../ThemeContext';
import { motion, radius, withAlpha } from '../theme';
import { isReducedMotion } from '../motionPrefs';

/**
 * Значок вкладки с подсветкой, которая появляется движением, а не подменой кадра.
 *
 * v4.32.533. До этого активная вкладка отличалась от прочих ровно двумя
 * мгновенными подменами: заливка значка вместо контура и цвет подписи. Обе
 * происходили в один кадр, поэтому переход между вкладками ничем не отличался
 * от перерисовки — глазу не за что зацепиться, и ощущение «приложение не
 * шевелится», о котором говорил пользователь, начинается именно здесь.
 *
 * Подсветка — отдельный слой ПОД значком: пилюля, которая вырастает из 0.7 и
 * проявляется. Слой, а не изменение самого значка, выбран потому, что значок
 * при этом остаётся ровно на месте: вкладка не должна прыгать, когда её
 * выбрали. Пружина здесь не нужна — ход короткий, и `motion.base` с
 * `Easing.out` даёт то же ощущение дешевле.
 *
 * Прозрачность и масштаб гоняются нативным драйвером везде, кроме веба, где он
 * не поддерживается для layout-свойств и RN пишет предупреждение в консоль.
 *
 * Системное «уменьшить движение» отключает анимацию, но не подсветку: пилюля
 * тогда просто есть или её нет. Это не оформление, а указание, где ты сейчас.
 */
export function TabGlyph({
  active,
  name,
  inactiveName,
  color,
  children,
}: {
  active: boolean;
  name: React.ComponentProps<typeof Ionicons>['name'];
  inactiveName: React.ComponentProps<typeof Ionicons>['name'];
  color: string;
  /** Значок-спутник поверх — например, счётчик непрочитанного. */
  children?: React.ReactNode;
}): React.ReactElement {
  const colors = useColors();
  const on = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    const to = active ? 1 : 0;
    if (isReducedMotion()) {
      on.setValue(to);
      return;
    }
    const anim = Animated.timing(on, {
      toValue: to,
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start();
    return () => anim.stop();
  }, [active, on]);

  return (
    <View style={styles.box}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.pill,
          {
            backgroundColor: withAlpha(colors.accent, 0.16),
            opacity: on,
            transform: [{ scale: on.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }],
          },
        ]}
      />
      <Ionicons name={active ? name : inactiveName} size={22} color={color} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  pill: {
    position: 'absolute',
    left: -12,
    right: -12,
    top: -5,
    bottom: -5,
    borderRadius: radius.lg,
  },
});
