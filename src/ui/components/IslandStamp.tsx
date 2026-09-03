import React, { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { AirChatSignature } from './AirChatSignature';
import { useColors } from '../ThemeContext';

/**
 * Штамп под «островом» (v4.32.555).
 *
 * Видно его только на снимке экрана. «Остров» — чёрная маска, которую система
 * рисует поверх окна и в снимок не отдаёт: на устройстве штамп закрыт ею
 * целиком, а на скриншоте оказывается на её месте.
 *
 * Форма — один овал по контуру самой маски. Ни заливки, ни хвоста: заливка
 * читалась плашкой и спорила с буквами, а свешенный хвост торчал бы из-под
 * маски, то есть был бы виден в работе, — а этого штамп делать не должен.
 * Остаётся обводка и подпись внутри неё.
 *
 * Название набрано рукописным росчерком (AirChatSignature), а не гротеском, как
 * везде в интерфейсе: штамп попадает только в кадр, и подпись читается там
 * автографом на снимке, а не надписью, случайно уехавшей под часы.
 *
 * Цвет — перелив по двум цветам темы: accent → primary → accent → primary по
 * диагонали. Две брендовые краски, разложенные по длине дважды, дают отблеск —
 * знак играет по всей капсуле, а не гаснет к правому краю, как при простой
 * паре. Тот же набор идёт и в буквы, поэтому кольцо и слово переливаются
 * заодно. Своих шестнадцатеричных здесь нет: перелив следует за темой и за
 * акцентом, выбранным в настройках. Две эти краски — всё, что в палитре относится
 * к бренду: остальные токены — семантика (success, error, star), и тянуть их
 * в украшение значило бы сломать их роль. Обводка чуть прозрачнее подписи —
 * подпись впереди, кольцо за ней.
 *
 * Числа здесь, а не в теме: они не про оформление, а про габариты чужой маски.
 * «Остров» около 125×37 точек (iPhone 14 Pro и новее), капсула взята с запасом
 * по краям — на разных аппаратах маска отличается на пару точек, и запас важнее
 * точного совпадения.
 */
const CAPSULE_W = 115;
const CAPSULE_H = 31;
const STROKE = 1.5;
/** Высота росчерка внутри овала. */
const SIGNATURE = 20;
/** Прозрачность обводки: слово впереди, овал за ним. */
const STROKE_ALPHA = 0.7;
/**
 * Сколько раз пара accent → primary укладывается по длине. Один проход — это
 * обычный градиент, он темнеет к концу; два дают отблеск посередине.
 */
const SHEEN_CYCLES = 2;

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
  const sheen = React.useMemo(
    () =>
      Array.from({ length: SHEEN_CYCLES * 2 }, (_, i) =>
        i % 2 === 0 ? colors.accent : colors.primary,
      ),
    [colors.accent, colors.primary],
  );
  return (
    <View pointerEvents="none" style={styles.stamp}>
      <Svg width={CAPSULE_W} height={CAPSULE_H} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            {sheen.map((color, i, all) => (
              <Stop
                key={`${i}-${color}`}
                offset={i / (all.length - 1)}
                stopColor={color}
                stopOpacity={STROKE_ALPHA}
              />
            ))}
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
        <AirChatSignature height={SIGNATURE} stops={sheen} />
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
