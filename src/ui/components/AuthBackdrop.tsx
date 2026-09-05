/**
 * Фон экранов без аккаунта: база темы и два медленно дышащих пятна палитры.
 *
 * v4.32.591. Начало, восстановление и показ секретных слов лежали на ровной
 * заливке `background`. Это первое, что человек видит, поставив приложение, и
 * оно ничего о нём не говорит. Слой не картинка: пять чисел на пятно и
 * радиальный градиент в `react-native-svg`, который уже в зависимостях, — тот
 * же приём, что у обоев переписки (см. WallpaperBackground), и по той же
 * причине.
 *
 * Числа — не здесь, а в `authWash`: там же записано, из каких замеров они
 * взяты и почему пятна разведены по высоте. Здесь только слои.
 *
 * Дрейф намеренно длиннее, чем у обоев, и мельче: под этим слоем нет ленты,
 * которую нужно оживить, — под ним форма входа, и всё заметное на фоне
 * отвлекает от неё. При включённом «уменьшении движения» слой стоит.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet } from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useColors } from '../ThemeContext';
import { authWash } from '../theme';
import { isReducedMotion } from '../motionPrefs';

export function AuthBackdrop(): React.ReactElement {
  const colors = useColors();
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isReducedMotion()) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: authWash.driftMs / 2,
          useNativeDriver: Platform.OS !== 'web',
          isInteraction: false,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: authWash.driftMs / 2,
          useNativeDriver: Platform.OS !== 'web',
          isInteraction: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [drift]);

  return (
    // `overflow: 'hidden'` — рамка слоя, а не украшение: дрейф увеличивает
    // пятна и возит их на десяток точек, и без клипа слой вылезает за экран.
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.clip, { backgroundColor: colors.background }]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [
              { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [-10, 10] }) },
              { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [8, -8] }) },
              { scale: drift.interpolate({ inputRange: [0, 1], outputRange: [1.05, 1.1] }) },
            ],
          },
        ]}
      >
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <RadialGradient id="auth-wash-a" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={colors.primary} stopOpacity={authWash.peakA} />
              {/* Средняя остановка — как у обоев: без неё пятно гаснет линейно
                  и его край виден ровно там, где он должен быть незаметен. */}
              <Stop offset="0.55" stopColor={colors.primary} stopOpacity={authWash.midA} />
              <Stop offset="1" stopColor={colors.primary} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="auth-wash-b" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={colors.accent} stopOpacity={authWash.peakB} />
              <Stop offset="0.55" stopColor={colors.accent} stopOpacity={authWash.midB} />
              <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          {/* База — под самим SVG тоже, иначе при дрейфе из-под сдвинутого
              слоя видна полоса родительского фона. */}
          <Rect x="0" y="0" width="100%" height="100%" fill={colors.background} />
          <Ellipse
            cx={`${authWash.a.cx}%`}
            cy={`${authWash.a.cy}%`}
            rx={`${authWash.a.rx}%`}
            ry={`${authWash.a.ry}%`}
            fill="url(#auth-wash-a)"
          />
          <Ellipse
            cx={`${authWash.b.cx}%`}
            cy={`${authWash.b.cy}%`}
            rx={`${authWash.b.rx}%`}
            ry={`${authWash.b.ry}%`}
            fill="url(#auth-wash-b)"
          />
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
