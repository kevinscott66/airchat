import React, { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { AirChatWordmark } from './AirChatWordmark';
import { useColors } from '../ThemeContext';

/**
 * Штамп под «островом» (v4.32.554).
 *
 * Видно его только на снимке экрана. «Остров» — чёрная маска, которую система
 * рисует поверх окна и в снимок не отдаёт: на устройстве штамп закрыт ею
 * целиком, а на скриншоте оказывается на её месте.
 *
 * Форма — один овал по контуру самой маски. Ни заливки, ни хвоста: заливка
 * читалась плашкой и спорила с буквами, а свешенный хвост торчал бы из-под
 * маски, то есть был бы виден в работе, — а этого штамп делать не должен.
 * Остаётся обводка и слово внутри неё.
 *
 * Цвет — тот же градиент accent → primary, которым набрано само слово: обводка
 * и буквы идут одной гаммой и следом за темой, а не живут отдельными
 * шестнадцатеричными. Обводка светлее букв (стёкла у неё за спиной нет, и в
 * полную силу она била бы по глазам на снимке).
 *
 * Числа здесь, а не в теме: они не про оформление, а про габариты чужой маски.
 * «Остров» около 125×37 точек (iPhone 14 Pro и новее), капсула взята с запасом
 * по краям — на разных аппаратах маска отличается на пару точек, и запас важнее
 * точного совпадения.
 */
const CAPSULE_W = 115;
const CAPSULE_H = 31;
const STROKE = 1.5;
/** Высота букв внутри овала. */
const WORDMARK = 13;
/** Прозрачность обводки: слово впереди, овал за ним. */
const STROKE_ALPHA = 0.7;

/**
 * Овал одним путём: два полукруга и две прямые между ними.
 *
 * Считается из тех же чисел, что и размеры контейнера, — иначе рамка на SVG и
 * рамка контейнера разъезжаются на полтолщины обводки, и на скриншоте это видно.
 */
function capsulePath(): string {
  const half = STROKE / 2;
  const r = (CAPSULE_H - STROKE) / 2;
  const top = half;
  const bottom = CAPSULE_H - half;
  const xL = half + r;
  const xR = CAPSULE_W - half - r;
  return [
    `M ${xL} ${top}`,
    `H ${xR}`,
    `A ${r} ${r} 0 0 1 ${xR} ${bottom}`,
    `H ${xL}`,
    `A ${r} ${r} 0 0 1 ${xL} ${top}`,
    'Z',
  ].join(' ');
}

export function IslandStamp(): React.ReactElement {
  const colors = useColors();
  // Свой идентификатор градиента на экземпляр: общий отобрал бы заливку
  // у того знака, что отрисован позже.
  const gradientId = `island-stamp-${useId()}`;
  return (
    <View pointerEvents="none" style={styles.stamp}>
      <Svg width={CAPSULE_W} height={CAPSULE_H} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={colors.accent} stopOpacity={STROKE_ALPHA} />
            <Stop offset="1" stopColor={colors.primary} stopOpacity={STROKE_ALPHA} />
          </LinearGradient>
        </Defs>
        <Path
          d={capsulePath()}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={STROKE}
          strokeLinejoin="round"
        />
      </Svg>
      <View style={styles.body}>
        <AirChatWordmark height={WORDMARK} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stamp: {
    width: CAPSULE_W,
    height: CAPSULE_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { alignItems: 'center', justifyContent: 'center' },
});
