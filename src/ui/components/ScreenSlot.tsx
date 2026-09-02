import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';
import { motion } from '../theme';
import { isReducedMotion } from '../motionPrefs';

/**
 * Место одного экрана в корневом переключателе вкладок.
 *
 * v4.32.533. Экраны здесь не размонтируются, а прячутся через `display: 'none'`
 * — так задумано (см. комментарий про keep-alive в App.tsx: пересборка пяти
 * деревьев стоит ~2.2с JS-блокировки). Но у мгновенного `display` нет никакого
 * перехода: вкладки менялись подменой кадра, и приложение выглядело статичным
 * ровно в том месте, где человек чаще всего им пользуется.
 *
 * Уходящий экран гасить нельзя: `display: 'none'` наступает в тот же кадр, и
 * анимации ухода просто не существует. Поэтому движение есть только у
 * приходящего, и оно начинается не с нуля, а с 0.35 — при старте с полной
 * прозрачности между двумя вкладками мелькал бы пустой фон приложения.
 *
 * Сдвиг вверх на 12 — не украшение: он задаёт направление «экран вышел вперёд»
 * и тем отличает смену вкладки от перерисовки внутри неё.
 */
export function ScreenSlot({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const enter = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    if (!active) {
      // Спрятанный экран возвращается в исходную точку без анимации: его никто
      // не видит, а анимировать невидимое — это работа впустую каждый кадр.
      enter.setValue(0);
      return;
    }
    if (isReducedMotion()) {
      enter.setValue(1);
      return;
    }
    const anim = Animated.timing(enter, {
      toValue: 1,
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start();
    return () => anim.stop();
  }, [active, enter]);

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {
          display: active ? 'flex' : 'none',
          opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
