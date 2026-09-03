import React from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';
import { useColors } from '../ThemeContext';
import { glass, lightColors, withAlpha } from '../theme';
import { useReducedTransparency } from '../motionPrefs';

export type GlassSurfaceProps = ViewProps & {
  /** Нативная сила blur. По умолчанию берётся из `glass.intensity[variant]`. */
  intensity?: number;
  /** Выраженность стеклянной подложки. */
  variant?: 'clear' | 'regular' | 'prominent';
  /** Кромка сверху — «толщина» стекла. Выключается там, где панель прижата к краю. */
  rim?: boolean;
  /**
   * Подкрас стекла: два мягких пятна палитры (`primary` слева, `accent`
   * справа) под размытием.
   *
   * Без него капсула — это ровно то, что под ней, только замыленное: на
   * светлой ленте почти белая, на тёмной почти чёрная. Подкрас даёт шапке
   * собственный цвет.
   *
   * v4.32.551: признак назывался `watermark` и, кроме подкраса, клал в стекло
   * буквы «AirChat». Знака здесь больше нет — он вернулся в полосу статуса,
   * вплотную под «остров» (см. `islandMark` в App.tsx). 545-я увела его в
   * подложку размытия, где силой 52 от восемнадцати точек высоты не остаётся
   * ничего; 573-я подняла буквы поверх стекла — и стало видно, что дело не в
   * порядке слоёв, а в месте: шапка это заголовок экрана, и знак в ней спорит
   * с заголовком, а не лежит за ним. Подкрас остался: он и задумывался как
   * фон, и размытие ему на пользу.
   *
   * Признаком, а не всегда: стеклянных панелей в приложении больше, чем шапок
   * (таббар, листы), и цветное пятно в каждой из них — это уже обои.
   */
  wash?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * Подкрас под стеклом шапки.
 *
 * v4.32.545. Рисуется ДО `BlurView` — то есть попадает в его подложку и
 * размывается вместе с лентой; отсюда и мягкость, которой в самих числах нет.
 * Букв здесь больше нет (см. признак `wash`): пятну размытие на пользу, знаку
 * оно было на уничтожение — и знак ушёл из шапки совсем.
 *
 * Пятна, а не линейный градиент: линейный даёт полосу с видимым направлением,
 * и в капсуле высотой в полсотни точек эта полоса читается как шов. Два пятна
 * по краям красят капсулу изнутри и не дают горизонта. SVG уже в зависимостях
 * (см. WallpaperBackground) — новой библиотеки под это не заводится.
 *
 * Непрозрачность низкая намеренно: слой лежит под заголовком и кнопками шапки,
 * и всё, что на нём различимо само по себе, спорит с ними за внимание.
 */
function CapsuleWash({ primary, accent }: { primary: string; accent: string }): React.ReactElement {
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%">
      <Defs>
        <RadialGradient id="gs-wash-a" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={primary} stopOpacity={0.34} />
          {/* Средняя остановка — как у обоев: без неё пятно гаснет линейно
              и его край виден ровно там, где он должен быть незаметен. */}
          <Stop offset="0.55" stopColor={primary} stopOpacity={0.13} />
          <Stop offset="1" stopColor={primary} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="gs-wash-b" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={accent} stopOpacity={0.26} />
          <Stop offset="0.55" stopColor={accent} stopOpacity={0.1} />
          <Stop offset="1" stopColor={accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {/* Пятна шире капсулы и выходят за её края: клип по `overflow: hidden`
          обрезает их на границе, и внутри не остаётся места, где пятно кончается
          само — иначе на широком экране в углах видно два размытых круга. */}
      <Ellipse cx="6%" cy="18%" rx="62%" ry="150%" fill="url(#gs-wash-a)" />
      <Ellipse cx="96%" cy="88%" rx="58%" ry="140%" fill="url(#gs-wash-b)" />
    </Svg>
  );
}

/**
 * Единый контейнер Liquid Glass для крупных функциональных слоёв.
 *
 * Glass применяется только к навигации и важным панелям: большое количество
 * независимых blur-контейнеров дорого для рендера и ухудшает читаемость.
 *
 * v4.32.532: добавлена кромка. Стекло — это три слоя, а не один: размытие
 * подложки, полупрозрачная заливка поверх него и светлый кант по верхнему краю
 * с тёмным по нижнему. Кант и есть то, что отличает стекло от матового окна:
 * он показывает толщину. Без него панель выглядит как замыленный участок фона.
 *
 * Числа берутся из `glass` в теме, а не пишутся здесь, чтобы «сколько стекла»
 * настраивалось в одном месте вместе с остальными токенами.
 *
 * Системное «уменьшить прозрачность» выключает размытие целиком и делает
 * подложку глухой. Стекло — это украшение поверх содержимого; человеку, которому
 * оно мешает читать, оно не должно доставаться ни в каком виде.
 *
 * Дети рендерятся прямо в контейнер, без промежуточной обёртки: обёртка сбивала
 * `flexDirection` со стиля, переданного снаружи, и шапка диалога разъезжалась в
 * три строки. Кромки лежат абсолютом, поэтому порядок детей им не мешает.
 */
export function GlassSurface({
  children,
  intensity,
  variant = 'regular',
  rim = true,
  wash = false,
  style,
  ...viewProps
}: GlassSurfaceProps): React.ReactElement {
  const colors = useColors();
  const isLight = colors.background === lightColors.background;
  const tint = isLight ? 'light' : 'dark';
  const solid = useReducedTransparency();
  const fillAlpha = solid ? 1 : glass.fill[variant];

  return (
    <View
      {...viewProps}
      style={[
        styles.container,
        {
          backgroundColor: withAlpha(colors.surface, fillAlpha),
          borderColor: withAlpha(colors.text, Platform.OS === 'web' ? 0.1 : 0.16),
        },
        style,
      ]}
    >
      {/* Подкрас — ДО BlurView: он ложится размытию в подложку, и мягкость у
          него оттуда, а не из чисел. При выключенной прозрачности стекла нет
          вовсе — прятать не за что, и подкрас не рисуется: на глухой заливке
          он оказался бы чётким пятном и заметнее всего именно там, где просили
          меньше. */}
      {wash && !solid ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <CapsuleWash primary={colors.primary} accent={colors.accent} />
        </View>
      ) : null}
      {solid ? null : (
        <BlurView
          pointerEvents="none"
          intensity={intensity ?? glass.intensity[variant]}
          tint={tint}
          style={StyleSheet.absoluteFill}
        />
      )}
      {rim ? (
        <>
          <View
            pointerEvents="none"
            style={[styles.rim, { backgroundColor: withAlpha(colors.text, glass.rim) }]}
          />
          <View
            pointerEvents="none"
            style={[styles.shade, { backgroundColor: withAlpha(glass.shadeInk, glass.shade) }]}
          />
        </>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  rim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
  },
  shade: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
  },
});
