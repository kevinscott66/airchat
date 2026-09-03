import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { AirChatWordmark } from './AirChatWordmark';
import { useColors } from '../ThemeContext';
import { withAlpha } from '../theme';

/**
 * Штамп под «островом» (v4.32.553).
 *
 * Видно его только на снимке экрана. «Остров» — чёрная маска, которую система
 * рисует поверх окна и в снимок не отдаёт: на устройстве штамп закрыт ею
 * целиком, а на скриншоте оказывается на её месте. Поэтому здесь можно то, чего
 * в работающем интерфейсе быть не должно, — рамка, заливка, полная
 * непрозрачность: помешать они физически не могут.
 *
 * Форма — пузырь переписки по контуру самой маски: капсула с полным
 * скруглением и хвостом. На снимке это читается как фирменный знак ровно там,
 * где у аппарата вырез, — а не как надпись, случайно попавшая под часы.
 *
 * Хвост нарисован ВНУТРЬ габарита, а не свешен вниз, как у обычного пузыря.
 * Свешенный хвост торчал бы из-под маски — то есть был бы виден в работе, а это
 * ровно то, чего штамп не должен делать. Отсюда и разделение высоты: тело
 * пузыря BODY_H, под хвост остаётся CAPSULE_H - BODY_H, и наружу не выходит
 * ничего.
 *
 * Числа здесь, а не в теме: они не про оформление, а про габариты чужой маски.
 * «Остров» около 125×37 точек (iPhone 14 Pro и новее), капсула взята с запасом
 * по краям — на разных аппаратах маска отличается на пару точек, и запас важнее
 * точного совпадения.
 */
const CAPSULE_W = 115;
const CAPSULE_H = 31;
/** Высота тела пузыря; остаток габарита занимает хвост. */
const BODY_H = 24;
const STROKE = 1.5;
/** Высота букв внутри пузыря. */
const WORDMARK = 12;

/**
 * Контур пузыря одним путём: капсула плюс хвост, вписанные в CAPSULE_W×CAPSULE_H.
 *
 * Считается из тех же чисел, что и размеры контейнера, — иначе рамка и рамка на
 * SVG разъезжаются на полтолщины обводки, и на скриншоте это видно.
 */
function bubblePath(): string {
  const half = STROKE / 2;
  const r = (BODY_H - STROKE) / 2;
  const top = half;
  const bottom = BODY_H - half;
  const xL = half + r;
  const xR = CAPSULE_W - half - r;
  // Хвост: основание на нижней кромке тела, остриё — в оставшемся запасе.
  const tailTo = xL + 10;
  const tailFrom = xL + 19;
  const tip = CAPSULE_H - half;
  return [
    `M ${xL} ${top}`,
    `H ${xR}`,
    `A ${r} ${r} 0 0 1 ${xR} ${bottom}`,
    `H ${tailFrom}`,
    `L ${xL + 6} ${tip}`,
    `L ${tailTo} ${bottom}`,
    `H ${xL}`,
    `A ${r} ${r} 0 0 1 ${xL} ${top}`,
    'Z',
  ].join(' ');
}

export function IslandStamp(): React.ReactElement {
  const colors = useColors();
  return (
    <View pointerEvents="none" style={styles.stamp}>
      <Svg width={CAPSULE_W} height={CAPSULE_H} style={StyleSheet.absoluteFill}>
        <Path
          d={bubblePath()}
          fill={withAlpha(colors.surface, 0.55)}
          stroke={withAlpha(colors.primary, 0.55)}
          strokeWidth={STROKE}
          strokeLinejoin="round"
        />
      </Svg>
      {/* Буквы центруются по ТЕЛУ пузыря, а не по габариту: габарит выше на
          хвост, и центр по нему увёл бы надпись вниз, к самому хвосту. */}
      <View style={styles.body}>
        <AirChatWordmark height={WORDMARK} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stamp: { width: CAPSULE_W, height: CAPSULE_H },
  body: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: BODY_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
