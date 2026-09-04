import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  Dimensions,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../ThemeContext';
// `colors` остаётся только StyleSheet fallback для первого кадра: без темы
// здесь нужен безопасный базовый стиль. Все видимые значения ниже
// переопределяются из ThemeContext, когда экран уже смонтирован.
import { colors } from '../theme';

const { width: windowWidth } = Dimensions.get('window');
const BAR_WIDTH = Math.min(240, windowWidth * 0.6);
// Полная ширина заливки = ширина трека — заполняем весь трек
// Анимация: translateX от -BAR_WIDTH (скрыто слева) до 0 (полностью видно)
// Easing.out — быстро стартует, замедляется в конце (как реальный прогресс-бар)
const LOAD_DURATION_MS = 50_000; // ~50 сек максимум для загрузки

/**
 * Полоса загрузки: заполняется ОДИН РАЗ слева направо за время загрузки.
 * translateX: native driver — не зависает при загрузке JS.
 */
const LoadingBar = React.memo(function LoadingBar() {
  const themeColors = useColors();
  const fillTx = useRef(new Animated.Value(-BAR_WIDTH)).current;

  useEffect(() => {
    const anim = Animated.timing(fillTx, {
      toValue: 0,
      duration: LOAD_DURATION_MS,
      easing: Easing.out(Easing.sin),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [fillTx]);

  return (
    <View style={[styles.barTrack, { backgroundColor: `${themeColors.primary}40` }]}>
      <Animated.View style={[styles.barFill, { backgroundColor: themeColors.primary, transform: [{ translateX: fillTx }] }]} />
    </View>
  );
});

/**
 * Полноэкранная заставка загрузки: тёмная тема AirChat.
 *
 * Используем useNativeDriver: true — анимации на нативном потоке,
 * не замирают при тяжёлой загрузке JS (SQLite, crypto).
 */
export function LoadingScreen({
  message = 'Подготовка приложения…',
  testID = 'loading_screen',
}: LoadingScreenProps): React.ReactElement {
  const themeColors = useColors();
  const [motionReady, setMotionReady] = useState(false);
  const rotateAnim = useRef(new Animated.Value(0)).current;

  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  useEffect(() => {
    const ms = Platform.OS === 'android' ? 16 : 80;
    const timer = setTimeout(() => setMotionReady(true), ms);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!motionReady) return;
    const spinLoop = Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 2800,
        useNativeDriver: true,
        easing: Easing.linear,
        isInteraction: false,
      })
    );
    spinLoop.start();
    return () => {
      spinLoop.stop();
    };
  }, [motionReady, rotateAnim]);

  return (
    <View
      style={[styles.container, { backgroundColor: themeColors.background }]}
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLabel={message}
      accessibilityState={{ busy: true }}
      collapsable={false}
    >
      <View style={styles.content}>
        <Animated.View style={[styles.iconWrap, { transform: [{ rotate: spin }] }]}>
          <Ionicons name="chatbubbles" size={76} color={themeColors.accent} />
        </Animated.View>

        <Text style={[styles.title, { color: themeColors.accent }]} accessibilityRole="header">
          AirChat
        </Text>
        <Text style={[styles.tagline, { color: themeColors.textSecondary }]}>Общение рядом и в сети</Text>
      </View>

      <View style={styles.messageBlock} collapsable={false}>
        <Text style={[styles.message, { color: themeColors.textSecondary }]}>{message}</Text>
        <LoadingBar />
      </View>

      <View style={styles.waveWrap} pointerEvents="none">
        <View style={[styles.wave, styles.wave1, { backgroundColor: `${themeColors.primary}14` }]} />
        <View style={[styles.wave, styles.wave2, { backgroundColor: `${themeColors.primary}22` }]} />
      </View>
    </View>
  );
}

export type LoadingScreenProps = {
  message?: string;
  testID?: string;
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 36,
    zIndex: 1,
  },
  iconWrap: {
    marginBottom: 4,
  },
  title: {
    fontSize: 30,
    fontWeight: '700',
    color: colors.accent,
    marginTop: 16,
    letterSpacing: 0.5,
  },
  tagline: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 8,
    marginBottom: 12,
  },
  messageBlock: {
    alignItems: 'center',
    paddingHorizontal: 36,
    maxWidth: windowWidth,
    zIndex: 2,
    marginTop: 16,
    gap: 12,
  },
  message: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  barTrack: {
    width: BAR_WIDTH,
    height: 4,
    borderRadius: 2,
    backgroundColor: `${colors.primary}40`,
    overflow: 'hidden',
    position: 'relative',
  },
  barFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: BAR_WIDTH,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  waveWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
    overflow: 'hidden',
  },
  wave: {
    position: 'absolute',
    left: -windowWidth * 0.15,
    width: windowWidth * 1.3,
    borderTopLeftRadius: 120,
    borderTopRightRadius: 120,
  },
  wave1: {
    bottom: -40,
    height: 100,
    backgroundColor: `${colors.primary}14`,
  },
  wave2: {
    bottom: -56,
    height: 88,
    backgroundColor: `${colors.primary}22`,
  },
});
