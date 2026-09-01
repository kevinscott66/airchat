// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: единственный экран загрузки, заменяет LoadingScreen.
// Любые правки сплэша — только через этот файл + App.tsx (блок showSplash).
/**
 * SplashOverlay — единственный экран загрузки AirChat.
 *
 * Заменяет LoadingScreen: показывается поверх всего с момента запуска
 * и скрывается только когда приложение полностью готово к работе.
 *
 * Props:
 *   message — текущий статус загрузки (меняется реактивно из App.tsx)
 *
 * Анимации (useNativeDriver: true — не блокируют JS thread):
 *   • Вход:  логотип scale 0.82→1.0 (spring) + opacity 0→1
 *   • Пульс: внешние glow-кольца breathing 1.0→1.08→1.0 loop
 *   • Бар:   прогресс-бар translateX -BAR_WIDTH→0 за 50 с
 *   • Выход: весь оверлей opacity 1→0 за 400 ms
 */
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  memo,
} from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const { width: W } = Dimensions.get('window');

// ─── константы дизайна ───────────────────────────────────────────────────────
const BG          = '#0b1020';
const PRIMARY     = '#3d5afe';
const ACCENT      = '#7ecbff';
const TEXT_DIM    = '#4a5578';
const TEXT_MSG    = '#6b7a9e';

const ICON_SIZE   = 52;
const CIRCLE_SIZE = 88;
const RING1_SIZE  = 126;
const RING2_SIZE  = 170;
const RING3_SIZE  = 214;
const BAR_WIDTH   = Math.min(220, W * 0.55);
const BAR_DURATION_MS = 50_000;

// задержки/длительности (ms)
const ENTER_DELAY = 60;
const ENTER_DUR   = 680;
const PULSE_DUR   = 2000;
const EXIT_DUR    = 400;
const TEXT_DELAY  = 180;

// ─── публичный интерфейс ──────────────────────────────────────────────────────
export type SplashOverlayRef = {
  /** Запускает fade-out; вызывает onDone когда анимация завершена. */
  hide: (onDone?: () => void) => void;
};

export type SplashOverlayProps = {
  /** Текущий статус загрузки — обновляется реактивно. */
  message?: string;
};

// ─── прогресс-бар (нативный driver — не зависает при тяжёлом JS) ─────────────
const LoadingBar = memo(function LoadingBar() {
  const fillTx = useRef(new Animated.Value(-BAR_WIDTH)).current;

  useEffect(() => {
    const anim = Animated.timing(fillTx, {
      toValue: 0,
      duration: BAR_DURATION_MS,
      easing: Easing.out(Easing.sin),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [fillTx]);

  return (
    <View style={styles.barTrack}>
      <Animated.View style={[styles.barFill, { transform: [{ translateX: fillTx }] }]} />
    </View>
  );
});

// ─── основной компонент ───────────────────────────────────────────────────────
export const SplashOverlay = forwardRef<SplashOverlayRef, SplashOverlayProps>(
  function SplashOverlay({ message = 'Подготовка приложения…' }, ref) {
    const masterOpacity = useRef(new Animated.Value(1)).current;
    const logoScale     = useRef(new Animated.Value(0.82)).current;
    const logoOpacity   = useRef(new Animated.Value(0)).current;
    const textOpacity   = useRef(new Animated.Value(0)).current;
    const pulseScale    = useRef(new Animated.Value(1)).current;
    const pulseLoopRef  = useRef<Animated.CompositeAnimation | null>(null);

    // ── вход ──────────────────────────────────────────────────────────────────
    useEffect(() => {
      const enterLogo = Animated.sequence([
        Animated.delay(ENTER_DELAY),
        Animated.parallel([
          Animated.timing(logoScale, {
            toValue: 1,
            duration: ENTER_DUR,
            easing: Easing.out(Easing.back(1.4)),
            useNativeDriver: true,
          }),
          Animated.timing(logoOpacity, {
            toValue: 1,
            duration: ENTER_DUR * 0.65,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      ]);

      const enterText = Animated.sequence([
        Animated.delay(ENTER_DELAY + TEXT_DELAY),
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: ENTER_DUR * 0.7,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]);

      Animated.parallel([enterLogo, enterText]).start(() => {
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(pulseScale, {
              toValue: 1.08,
              duration: PULSE_DUR,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: true,
            }),
            Animated.timing(pulseScale, {
              toValue: 1.0,
              duration: PULSE_DUR,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: true,
            }),
          ])
        );
        pulseLoopRef.current = loop;
        loop.start();
      });

      return () => {
        enterLogo.stop();
        enterText.stop();
        pulseLoopRef.current?.stop();
      };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── публичный метод hide ───────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      hide: (onDone?: () => void) => {
        pulseLoopRef.current?.stop();
        Animated.timing(masterOpacity, {
          toValue: 0,
          duration: EXIT_DUR,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished) onDone?.();
        });
      },
    }));

    return (
      <Animated.View
        style={[styles.container, { opacity: masterOpacity }]}
        pointerEvents="none"
      >
        {/* ── центральный блок ───────────────────────────────────────────────── */}
        <View style={styles.center}>

          {/* glow-кольца + иконка */}
          <Animated.View
            style={[
              styles.logoWrap,
              { opacity: logoOpacity, transform: [{ scale: logoScale }] },
            ]}
          >
            <Animated.View
              style={[styles.ring, styles.ring3, { transform: [{ scale: pulseScale }] }]}
            />
            <Animated.View
              style={[
                styles.ring, styles.ring2,
                {
                  transform: [{
                    scale: pulseScale.interpolate({
                      inputRange: [1, 1.08],
                      outputRange: [1, 1.05],
                    }),
                  }],
                },
              ]}
            />
            <View style={[styles.ring, styles.ring1]} />
            <View style={styles.iconCircle}>
              <Ionicons name="chatbubbles" size={ICON_SIZE} color={ACCENT} />
            </View>
          </Animated.View>

          {/* название */}
          <Animated.View style={[styles.textBlock, { opacity: textOpacity }]}>
            <Text style={styles.appName} allowFontScaling={false}>
              AirChat
            </Text>
            <Text style={styles.tagline} allowFontScaling={false}>
              Общение рядом и в сети
            </Text>
          </Animated.View>
        </View>

        {/* ── статус загрузки + прогресс-бар (внизу) ─────────────────────────── */}
        <Animated.View style={[styles.loadingBlock, { opacity: textOpacity }]}>
          <Text style={styles.statusMsg} allowFontScaling={false} numberOfLines={1}>
            {message}
          </Text>
          <LoadingBar />
        </Animated.View>

        {/* ── декоративные волны ───────────────────────────────────────────────── */}
        <View style={styles.waveWrap} pointerEvents="none">
          <View style={[styles.wave, styles.wave1]} />
          <View style={[styles.wave, styles.wave2]} />
        </View>
      </Animated.View>
    );
  }
);

// ─── стили ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    backgroundColor: BG,
    justifyContent: 'center',
    alignItems: 'center',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── logo ─────────────────────────────────────────────────────────────────
  logoWrap: {
    width: RING3_SIZE,
    height: RING3_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    borderRadius: 999,
  },
  ring3: {
    width: RING3_SIZE,
    height: RING3_SIZE,
    backgroundColor: `${PRIMARY}0d`,
  },
  ring2: {
    width: RING2_SIZE,
    height: RING2_SIZE,
    backgroundColor: `${PRIMARY}1a`,
  },
  ring1: {
    width: RING1_SIZE,
    height: RING1_SIZE,
    backgroundColor: `${PRIMARY}2e`,
  },
  iconCircle: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    backgroundColor: `${PRIMARY}33`,
    borderWidth: 1.5,
    borderColor: `${PRIMARY}80`,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: PRIMARY,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 20,
    elevation: 12,
  },

  // ── текст ────────────────────────────────────────────────────────────────
  textBlock: {
    marginTop: 32,
    alignItems: 'center',
  },
  appName: {
    fontSize: 28,
    fontWeight: '700',
    color: ACCENT,
    letterSpacing: 2,
  },
  tagline: {
    fontSize: 14,
    color: TEXT_DIM,
    marginTop: 8,
    letterSpacing: 0.3,
  },

  // ── статус + бар ─────────────────────────────────────────────────────────
  loadingBlock: {
    alignItems: 'center',
    paddingBottom: 56,
    gap: 10,
  },
  statusMsg: {
    fontSize: 14,
    color: TEXT_MSG,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  barTrack: {
    width: BAR_WIDTH,
    height: 3,
    borderRadius: 2,
    backgroundColor: `${PRIMARY}30`,
    overflow: 'hidden',
  },
  barFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: BAR_WIDTH,
    height: 3,
    borderRadius: 2,
    backgroundColor: ACCENT,
  },

  // ── волны ────────────────────────────────────────────────────────────────
  waveWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 110,
    overflow: 'hidden',
  },
  wave: {
    position: 'absolute',
    left: -W * 0.15,
    width: W * 1.3,
    borderTopLeftRadius: 120,
    borderTopRightRadius: 120,
  },
  wave1: {
    bottom: -40,
    height: 100,
    backgroundColor: `${PRIMARY}14`,
  },
  wave2: {
    bottom: -56,
    height: 88,
    backgroundColor: `${PRIMARY}22`,
  },
});
