/**
 * Фон разговора: градиент из набора, снимок из галереи или плоский цвет.
 *
 * v4.32.533. До этой версии лента лежала на `backgroundColor: feed.ground` —
 * одном плоском цвете, — и «сменить фон» означало выбрать другой плоский цвет
 * из одиннадцати почти неразличимых тёмных квадратов. Здесь фон стал слоем:
 * базовая заливка плюс несколько мягких пятен света.
 *
 * Почему SVG, а не картинка и не `expo-linear-gradient`. Картинку пришлось бы
 * класть в бандл в трёх плотностях на каждый пресет; линейный градиент даёт
 * полосу, а не свечение, и это отдельная зависимость. `react-native-svg` уже
 * в списке (его тянет QR-код), радиальный градиент в нём есть, а размер
 * описания одного фона — пять чисел.
 *
 * Движение здесь намеренно медленное: слой лежит ПОД перепиской, и всё, что
 * на нём заметно, отвлекает от текста. Полный цикл — двадцать восемь секунд,
 * сдвиг — проценты экрана; при включённом «уменьшении движения» слой стоит.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Image, Platform, StyleSheet, View } from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Rect, Stop } from 'react-native-svg';
import { isReducedMotion } from '../motionPrefs';
import { meshById, type Wallpaper } from '../wallpapers';

/** Полный цикл дрейфа. Не токен `motion`: там миллисекунды интерфейса, здесь — фон. */
const DRIFT_MS = 28000;

function MeshLayer({ id }: { id: string }): React.ReactElement | null {
  // `meshById` возвращает новый объект не каждый раз, а элемент константного
  // набора, но зависимостью хука это всё равно быть не может: тест формы
  // исходников не читает реализацию, а видит вызов функции в замыкании.
  const mesh = useMemo(() => meshById(id), [id]);
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!mesh || isReducedMotion()) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: DRIFT_MS / 2, useNativeDriver: Platform.OS !== 'web', isInteraction: false }),
        Animated.timing(drift, { toValue: 0, duration: DRIFT_MS / 2, useNativeDriver: Platform.OS !== 'web', isInteraction: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [drift, mesh]);

  if (!mesh) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          transform: [
            { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [-14, 14] }) },
            { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [10, -10] }) },
            { scale: drift.interpolate({ inputRange: [0, 1], outputRange: [1.06, 1.12] }) },
          ],
        },
      ]}
    >
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          {mesh.blobs.map((b, i) => (
            <RadialGradient key={i} id={`${mesh.id}-${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={b.color} stopOpacity={b.opacity} />
              {/* Средняя остановка: без неё пятно гаснет линейно и видно его край. */}
              <Stop offset="0.55" stopColor={b.color} stopOpacity={b.opacity * 0.35} />
              <Stop offset="1" stopColor={b.color} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={mesh.base} />
        {mesh.blobs.map((b, i) => (
          <Ellipse
            key={i}
            cx={`${b.x * 100}%`}
            cy={`${b.y * 100}%`}
            rx={`${b.rx * 100}%`}
            ry={`${b.ry * 100}%`}
            fill={`url(#${mesh.id}-${i})`}
          />
        ))}
      </Svg>
    </Animated.View>
  );
}

/**
 * Слой под лентой.
 *
 * `ground` — непрозрачная подложка: она нужна и под снимком (пока он грузится),
 * и под градиентом (пока не смонтирован SVG), и сама по себе, если обои —
 * плоский цвет.
 */
export function WallpaperBackground({
  wallpaper,
  ground,
}: {
  wallpaper: Wallpaper | null;
  ground: string;
}): React.ReactElement {
  // Под градиентом подложка — его собственная база, а не `ground`: `ground` —
  // это худшая точка градиента, и мигать ею до монтирования SVG незачем.
  const backing = wallpaper?.type === 'mesh' ? meshById(wallpaper.value)?.base ?? ground : ground;
  return (
    // `overflow: 'hidden'` — не украшение, а рамка слоя. Дрейф увеличивает
    // пятна до 1.12 и возит их на десяток точек: без клипа слой вылезает за
    // свои границы вверх, а в диалоге он лежит ПОСЛЕ шапки, то есть верхний
    // край обоев рисуется поверх неё и медленно ездит туда-обратно
    // (v4.32.535). Клип ставится здесь, а не у вызывающего: границы слоя —
    // дело самого слоя, и обе ленты, и квадратики в наборе получают их разом.
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: backing, overflow: 'hidden' }]}>
      {wallpaper?.type === 'mesh' ? <MeshLayer id={wallpaper.value} /> : null}
      {wallpaper?.type === 'image' ? (
        <Image
          source={{ uri: wallpaper.value }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}
