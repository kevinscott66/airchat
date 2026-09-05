/**
 * Марка AirChat — знак без слова.
 *
 * v4.32.592. До этой версии марка жила только файлами: `assets/logo/
 * airchat-mark.svg` и растр с него для иконки приложения и favicon. В самом
 * интерфейсе знака не было ни разу — название везде стояло буквами. Отсюда и
 * странность: иконка на домашнем экране и первый экран приложения не имели
 * между собой ничего общего.
 *
 * Контуры, а не `<Image source={require(...)}>`: PNG пришлось бы держать в
 * трёх плотностях, он не следует за темой и за выбранным акцентом, а на
 * пол-точки промахивается по краю. `react-native-svg` уже в зависимостях.
 * Геометрия повторяет файл один в один — те же координаты, та же толщина.
 *
 * Рамка обрезана по чернилам (`90 90 332 332` вместо `0 0 512 512`): в файле
 * вокруг знака оставлены поля под маску иконки iOS, а в строке рядом с
 * подписью эти поля читались бы просто отступом непонятно откуда. Заданный
 * `size` — это габарит самого знака.
 *
 * Заливка — из палитры (accent → primary), как у подписи: знак идёт за темой
 * и за акцентом, выбранным в настройках. В файле те же две краски вписаны
 * шестнадцатеричными, потому что растеризатору взять их неоткуда.
 */
import React, { useId } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';
import type { StyleProp, ViewStyle } from 'react-native';
import { useColors } from '../ThemeContext';

/** Чернильные границы знака в координатах файла: узлы радиусом 38 по краям. */
const BOX = { x: 90, y: 90, size: 332 } as const;

/** Три луча «А», две перекладины и кольцо в перекрестье. */
const STROKES = [
  'M256 128 L128 384',
  'M256 128 L384 384',
  'M160 320 L224 320',
  'M288 320 L352 320',
] as const;

/** Узлы на концах лучей — залитые кружки, а не обводка. */
const NODES = [
  { cx: 256, cy: 128 },
  { cx: 128, cy: 384 },
  { cx: 384, cy: 384 },
] as const;

const STROKE = 32;
const RING_STROKE = 20;
const RING_R = 24;
const NODE_R = 38;

export type AirChatMarkProps = {
  /** Габарит знака в точках. Знак квадратный. */
  size?: number;
  /** Начало градиента. По умолчанию — акцент темы. */
  from?: string;
  /** Конец градиента. По умолчанию — основной цвет темы. */
  to?: string;
  style?: StyleProp<ViewStyle>;
};

export function AirChatMark({ size = 28, from, to, style }: AirChatMarkProps): React.ReactElement {
  const colors = useColors();
  // Свой идентификатор градиента на экземпляр: общий отобрал бы заливку у той
  // марки, что нарисована позже (та же причина, что у подписи).
  const gradientId = `airchat-mark-${useId()}`;
  const paint = `url(#${gradientId})`;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`${BOX.x} ${BOX.y} ${BOX.size} ${BOX.size}`}
      style={[styles.mark, style]}
    >
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={from ?? colors.accent} />
          <Stop offset="1" stopColor={to ?? colors.primary} />
        </LinearGradient>
      </Defs>
      <G fill="none" stroke={paint} strokeLinecap="round" strokeLinejoin="round">
        {STROKES.map((d) => (
          <Path key={d} d={d} strokeWidth={STROKE} />
        ))}
        <Circle cx={256} cy={320} r={RING_R} strokeWidth={RING_STROKE} />
      </G>
      {NODES.map((n) => (
        <Circle key={`${n.cx}-${n.cy}`} cx={n.cx} cy={n.cy} r={NODE_R} fill={paint} />
      ))}
    </Svg>
  );
}

const styles = StyleSheet.create({
  /**
   * `position: relative` — не оформление, а web.
   *
   * `react-native-svg` отдаёт в браузере обычный `<svg>`, и он, в отличие от
   * `View`, остаётся статичным в потоке. Внутри `GlassSurface` слои стекла
   * лежат абсолютом, а по правилам отрисовки CSS позиционированный элемент
   * с z-index 0 красится ПОВЕРХ непозиционированных — то есть `BlurView`
   * забирал статичный `<svg>` себе в подложку и размывал знак. На устройстве
   * этого нет вовсе: там порядок задаётся деревом, а не позиционированием.
   */
  mark: { position: 'relative' },
});
