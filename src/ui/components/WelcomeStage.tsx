/**
 * Сцена приветствия: фон темы, два устройства и сообщение между ними.
 *
 * v4.32.719. Первый экран после установки рассказывал о приложении абзацем в
 * карточке. Сцена говорит то же самое без слов и раньше абзаца: светящаяся точка
 * улетает с одного устройства, доходит до второго, там расходится кольцо и
 * загораются две галочки — и ответ возвращается нижним маршрутом. Это ровно
 * обещание из design.md («знать, что стало с сообщением»), а не орнамент.
 *
 * Движение — только RN `Animated` на нативном драйвере (Reanimated в проекте
 * нет). При включённом «уменьшении движения» всё сразу стоит в конечном
 * положении: строки на месте, точка покоится на отправителе, петель нет.
 *
 * Цвета — из палитры приложения (`welcomeStagePalette`), числа движения — из `welcomeStage`.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../ThemeContext';
import {
  font,
  radius,
  spacing,
  weight,
  welcomeStage,
  welcomeStagePalette,
  withAlpha,
  type WelcomeStagePalette,
} from '../theme';
import { useReducedMotion } from '../motionPrefs';

const NATIVE = Platform.OS !== 'web';

/** Кривая подъёма — быстрый старт и долгая посадка. */
const RISE = Easing.bezier(0.22, 1, 0.36, 1);

export function useWelcomePalette(): WelcomeStagePalette {
  const colors = useColors();
  return useMemo(() => welcomeStagePalette(colors), [colors]);
}

/**
 * Значения входа по одному на слой, со сдвигом `riseStepMs`. При уменьшенном
 * движении сразу единицы.
 */
export function useEntrance(count: number, startDelay = 0): Animated.Value[] {
  const still = useReducedMotion();
  const values = useRef(
    Array.from({ length: count }, () => new Animated.Value(still ? 1 : 0)),
  ).current;

  useEffect(() => {
    if (still) return;
    const anim = Animated.stagger(
      welcomeStage.riseStepMs,
      values.map((v) =>
        Animated.timing(v, {
          toValue: 1,
          duration: welcomeStage.riseMs,
          easing: RISE,
          useNativeDriver: NATIVE,
        }),
      ),
    );
    const timer = setTimeout(() => anim.start(), startDelay);
    return () => {
      clearTimeout(timer);
      anim.stop();
    };
  }, [still, values, startDelay]);

  return values;
}

/** Стиль подъёма: снизу на `spacing.xl` и из прозрачности. */
export function riseStyle(v: Animated.Value): Animated.WithAnimatedObject<ViewStyle> {
  return {
    opacity: v,
    transform: [
      { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [spacing.xl, 0] }) },
    ],
  };
}

// ─── сцена ───────────────────────────────────────────────────────────────────

const HERO_W = 300;
const HERO_H = 200;
const CAPSULE_W = 62;
const CAPSULE_H = 112;
const CORE = 16;
const SPARK = 12;
const LEFT = { x: 64, y: 104 } as const;
const RIGHT = { x: HERO_W - 64, y: 104 } as const;
/** Контрольные точки маршрутов: туда — верхней дугой, обратно — нижней. */
const ARC_UP = { x: HERO_W / 2, y: -8 } as const;
const ARC_DOWN = { x: HERO_W / 2, y: 196 } as const;

type Pt = { x: number; y: number };

/** Точки квадратичной кривой — для кусочной интерполяции на нативном драйвере. */
function sampleQuad(a: Pt, c: Pt, b: Pt, steps = 12): { t: number[]; x: number[]; y: number[] } {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const u = 1 - s;
    t.push(s);
    x.push(u * u * a.x + 2 * u * s * c.x + s * s * b.x);
    y.push(u * u * a.y + 2 * u * s * c.y + s * s * b.y);
  }
  return { t, x, y };
}

function quadPath(a: Pt, c: Pt, b: Pt): string {
  return `M${a.x} ${a.y} Q${c.x} ${c.y} ${b.x} ${b.y}`;
}

function Spark({
  progress,
  from,
  via,
  to,
  color,
}: {
  progress: Animated.Value;
  from: Pt;
  via: Pt;
  to: Pt;
  color: string;
}): React.ReactElement {
  const pts = useMemo(() => sampleQuad(from, via, to), [from, via, to]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.spark,
        {
          backgroundColor: color,
          shadowColor: color,
          opacity: progress.interpolate({
            inputRange: [0, 0.06, 0.94, 1],
            outputRange: [0, 1, 1, 0],
          }),
          transform: [
            {
              translateX: progress.interpolate({
                inputRange: pts.t,
                outputRange: pts.x.map((v) => v - SPARK / 2),
              }),
            },
            {
              translateY: progress.interpolate({
                inputRange: pts.t,
                outputRange: pts.y.map((v) => v - SPARK / 2),
              }),
            },
          ],
        },
      ]}
    />
  );
}

function Device({
  at,
  tilt,
  pulse,
  tick,
  p,
}: {
  at: Pt;
  tilt: string;
  pulse: Animated.Value;
  tick: Animated.Value;
  p: WelcomeStagePalette;
}): React.ReactElement {
  return (
    <View
      pointerEvents="none"
      style={[
        styles.deviceBox,
        { left: at.x - CAPSULE_W / 2, top: at.y - CAPSULE_H / 2 },
      ]}
    >
      <View
        style={[
          styles.capsule,
          {
            backgroundColor: p.surface,
            borderColor: p.hairline,
            transform: [{ rotate: tilt }],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.ring,
          {
            borderColor: p.spark,
            opacity: pulse.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.8, 0] }),
            transform: [
              { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 3.4] }) },
            ],
          },
        ]}
      />
      <View style={[styles.core, { backgroundColor: p.spark, shadowColor: p.spark }]} />
      <Animated.View
        style={[
          styles.tick,
          {
            opacity: tick,
            transform: [
              { translateY: tick.interpolate({ inputRange: [0, 1], outputRange: [spacing.sm, 0] }) },
            ],
          },
        ]}
      >
        <Ionicons name="checkmark-done" size={font.lg} color={p.accentText} />
      </Animated.View>
    </View>
  );
}

/**
 * Два устройства и сообщение между ними. Размер фиксированный, сцена
 * центрируется родителем.
 */
export function WelcomeScene({
  scale = 1,
  style,
}: {
  scale?: number;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  const p = useWelcomePalette();
  const out = useRef(new Animated.Value(0)).current;
  const back = useRef(new Animated.Value(0)).current;
  const pulseRight = useRef(new Animated.Value(0)).current;
  const pulseLeft = useRef(new Animated.Value(0)).current;
  const tickRight = useRef(new Animated.Value(0)).current;
  const tickLeft = useRef(new Animated.Value(0)).current;
  const orbit = useRef(new Animated.Value(0)).current;
  const still = useReducedMotion();

  useEffect(() => {
    if (still) {
      // Покой: сообщение доставлено, это и видно.
      tickRight.setValue(1);
      return;
    }
    const timing = (v: Animated.Value, toValue: number, duration: number, easing = Easing.inOut(Easing.cubic)) =>
      Animated.timing(v, { toValue, duration, easing, useNativeDriver: NATIVE, isInteraction: false });

    const arrive = (pulse: Animated.Value, tick: Animated.Value) =>
      Animated.parallel([
        timing(pulse, 1, welcomeStage.arriveMs * 1.6, Easing.out(Easing.quad)),
        Animated.sequence([
          timing(tick, 1, welcomeStage.arriveMs / 3, RISE),
          Animated.delay(welcomeStage.arriveMs),
          timing(tick, 0, welcomeStage.arriveMs / 3),
        ]),
      ]);

    const reset = Animated.parallel([
      timing(out, 0, 0),
      timing(back, 0, 0),
      timing(pulseRight, 0, 0),
      timing(pulseLeft, 0, 0),
    ]);

    const cycle = Animated.loop(
      Animated.sequence([
        reset,
        Animated.delay(welcomeStage.arriveMs / 2),
        timing(out, 1, welcomeStage.routeMs),
        arrive(pulseRight, tickRight),
        timing(back, 1, welcomeStage.routeMs),
        arrive(pulseLeft, tickLeft),
      ]),
    );

    const spin = Animated.loop(
      timing(orbit, 1, welcomeStage.orbitMs, Easing.linear),
    );

    const timer = setTimeout(() => {
      cycle.start();
      spin.start();
    }, welcomeStage.riseMs);
    return () => {
      clearTimeout(timer);
      cycle.stop();
      spin.stop();
    };
  }, [still, out, back, pulseRight, pulseLeft, tickRight, tickLeft, orbit]);

  const cx = HERO_W / 2;
  const cy = HERO_H / 2;

  return (
    <View
      style={[{ width: HERO_W * scale, height: HERO_H * scale }, styles.heroSlot, style]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
    <View style={[styles.hero, { transform: [{ scale }] }]}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [
              { rotate: orbit.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
            ],
          },
        ]}
      >
        <Svg width={HERO_W} height={HERO_H}>
          <Circle
            cx={cx}
            cy={cy}
            r={HERO_H / 2 - 4}
            stroke={p.hairline}
            strokeWidth={1}
            strokeDasharray="2 7"
            fill="none"
          />
        </Svg>
      </Animated.View>
      <Svg width={HERO_W} height={HERO_H} style={StyleSheet.absoluteFill}>
        <Circle cx={cx} cy={cy} r={HERO_H / 2 - 30} stroke={p.hairline} strokeWidth={1} fill="none" />
        <Path
          d={quadPath(LEFT, ARC_UP, RIGHT)}
          stroke={withAlpha(p.spark, 0.45)}
          strokeWidth={1.25}
          strokeDasharray="4 6"
          fill="none"
        />
        <Path
          d={quadPath(RIGHT, ARC_DOWN, LEFT)}
          stroke={p.hairline}
          strokeWidth={1.25}
          strokeDasharray="4 6"
          fill="none"
        />
      </Svg>
      <Device at={LEFT} tilt="-14deg" pulse={pulseLeft} tick={tickLeft} p={p} />
      <Device at={RIGHT} tilt="14deg" pulse={pulseRight} tick={tickRight} p={p} />
      <Spark progress={out} from={LEFT} via={ARC_UP} to={RIGHT} color={p.spark} />
      <Spark progress={back} from={RIGHT} via={ARC_DOWN} to={LEFT} color={p.spark} />
    </View>
    </View>
  );
}

// ─── заголовок ──────────────────────────────────────────────────────

const HEADLINE = ['Сообщения,', 'которые читаете', 'только вы'];
/** Межстрочный интервал заголовка — доля кегля. */
const LINE_HEIGHT = 1.18;

export function WelcomeHeadline({
  entrance,
  size = welcomeStage.displaySize,
}: {
  entrance: Animated.Value[];
  size?: number;
}): React.ReactElement {
  const p = useWelcomePalette();
  return (
    <View style={styles.headline} accessible accessibilityRole="header" accessibilityLabel={HEADLINE.join(' ')}>
      {HEADLINE.map((line, i) => (
        <Animated.Text
          key={line}
          style={[
            styles.display,
            { fontSize: size, lineHeight: size * LINE_HEIGHT },
            { color: i === HEADLINE.length - 1 ? p.accentText : p.ink },
            riseStyle(entrance[i]),
          ]}
        >
          {line}
        </Animated.Text>
      ))}
    </View>
  );
}

// ─── раскладка ───────────────────────────────────────────────────────────────

/** Ступени верха, от крупной к мелкой: масштаб сцены, кегль заголовка, плотность. */
const TIERS = [
  { scale: 1, size: welcomeStage.displaySize, dense: false },
  { scale: 0.78, size: font.xxl + spacing.xs, dense: false },
  { scale: 0.64, size: font.xxl + spacing.xs / 2, dense: false },
  { scale: 0.52, size: font.xxl, dense: true },
] as const;

type Tier = (typeof TIERS)[number];

/** Высота верха на ступени — по константам, без замера, чтобы выбор не зацикливался. */
function topHeight(t: Tier): number {
  return (
    HERO_H * t.scale +
    spacing.sm +
    HEADLINE.length * t.size * LINE_HEIGHT +
    (t.dense ? spacing.md : spacing.lg)
  );
}

/**
 * Приветствие целиком: сцена и заголовок сверху, карточка формы в нижней части
 * экрана — кнопки под большим пальцем.
 *
 * Под карточкой остаётся `footRatio` высоты, всё выше отдаётся сцене: она берёт
 * самую крупную ступень, которая там помещается, и центруется в своей области.
 * Если не помещается и самая мелкая, поле снизу ужимается, чтобы обе кнопки
 * остались на экране.
 *
 * С ширины `centeredMinWidth` (веб, планшет) большого пальца внизу нет, и
 * прижатая книзу карточка отрывается от сцены пустотой. Там верх и карточка
 * собираются в один блок с зазором `groupGap`, а блок стоит чуть выше
 * середины: свободное место делится 2 к 3.
 *
 * `viewport` — высота прокручиваемой области, без неё раскладка не видна: иначе
 * первый кадр мелькнул бы не на своих местах.
 */
export function WelcomeLayout({
  viewport,
  children,
}: {
  viewport: number;
  children: React.ReactNode;
}): React.ReactElement {
  const entrance = useEntrance(5);
  const [cardH, setCardH] = useState(0);
  const centered = useWindowDimensions().width >= welcomeStage.centeredMinWidth;
  const avail = Math.max(0, viewport - 2 * spacing.lg);
  const smallest = TIERS[TIERS.length - 1];
  const foot = centered
    ? 0
    : Math.max(0, Math.min(avail * welcomeStage.footRatio, avail - cardH - topHeight(smallest)));
  const extraGap = centered ? welcomeStage.groupGap - spacing.lg : 0;
  const room = avail - cardH - foot - extraGap;
  const tier = TIERS.find((t) => topHeight(t) <= room) ?? smallest;
  const ready = viewport > 0 && cardH > 0;
  const gap = centered ? welcomeStage.groupGap : tier.dense ? spacing.md : spacing.lg;

  return (
    <View style={[styles.layout, !ready && styles.pending]}>
      {centered && <View style={styles.aboveGroup} />}
      <View style={[styles.top, centered && styles.topInGroup, { paddingBottom: gap }]}>
        <Animated.View style={riseStyle(entrance[0])}>
          <WelcomeScene scale={tier.scale} />
        </Animated.View>
        <WelcomeHeadline entrance={entrance.slice(1, 4)} size={tier.size} />
      </View>
      <Animated.View
        style={riseStyle(entrance[4])}
        onLayout={(e) => setCardH(e.nativeEvent.layout.height)}
      >
        {children}
      </Animated.View>
      {centered ? <View style={styles.belowGroup} /> : <View style={{ height: foot }} />}
    </View>
  );
}

/**
 * Блик на главной кнопке: светлая полоса проходит слева направо и пропадает.
 * Кладётся первым ребёнком кнопки, под подпись.
 */
export function WelcomeSheen(): React.ReactElement | null {
  const p = useWelcomePalette();
  const x = useRef(new Animated.Value(0)).current;
  const still = useReducedMotion();
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(welcomeStage.sheenGapMs),
        Animated.timing(x, {
          toValue: 1,
          duration: welcomeStage.riseMs * 1.4,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: NATIVE,
          isInteraction: false,
        }),
        Animated.timing(x, { toValue: 0, duration: 0, useNativeDriver: NATIVE, isInteraction: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [still, x]);

  if (still) return null;
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.clip]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width <= 0 ? null : (
      <Animated.View
        style={[
          styles.sheen,
          {
            backgroundColor: withAlpha(p.sheen, welcomeStage.sheenAlpha),
            transform: [
              { translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-spacing.xxl * 2, width + spacing.xxl] }) },
              { rotate: '18deg' },
            ],
          },
        ]}
      />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  pending: { opacity: 0 },
  layout: { flexGrow: 1 },
  top: { flexGrow: 1, justifyContent: 'center' },
  topInGroup: { flexGrow: 0 },
  aboveGroup: { flexGrow: 2 },
  belowGroup: { flexGrow: 3 },
  heroSlot: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: {
    width: HERO_W,
    height: HERO_H,
  },
  deviceBox: {
    position: 'absolute',
    width: CAPSULE_W,
    height: CAPSULE_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsule: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.full,
    borderWidth: 1.5,
  },
  core: {
    width: CORE,
    height: CORE,
    borderRadius: radius.full,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: spacing.md,
    elevation: 6,
  },
  ring: {
    position: 'absolute',
    width: CORE,
    height: CORE,
    borderRadius: radius.full,
    borderWidth: 1.5,
  },
  tick: {
    position: 'absolute',
    top: -spacing.xl,
  },
  spark: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: SPARK,
    height: SPARK,
    borderRadius: radius.full,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: spacing.sm,
    elevation: 8,
  },
  headline: {
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  display: {
    fontWeight: weight.bold,
    textAlign: 'center',
  },
  sheen: {
    position: 'absolute',
    top: -spacing.xl,
    bottom: -spacing.xl,
    width: spacing.xl,
  },
});
