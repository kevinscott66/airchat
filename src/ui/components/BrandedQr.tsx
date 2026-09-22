/**
 * QR-код со знаком AirChat посередине.
 *
 * Знак закрывает часть модулей, и код остаётся читаемым только за счёт
 * избыточности: уровень коррекции H восстанавливает до 30 % кодовых слов, а
 * плашка со знаком занимает `LOGO_SHARE` стороны — около 5 % площади. Запас
 * шестикратный, поэтому код ловится и с бликом, и под углом. Поднимать долю
 * выше или опускать уровень коррекции — значит тратить этот запас.
 *
 * Знак ставится не всегда. H берёт под избыточность почти две трети ёмкости,
 * и длинная строка на нём разрастается в мелкую сетку: приглашение в группу
 * со списком участников — это сотни байт. Поэтому уровень выбирается по
 * строке: если на H код укладывается в `LOGO_MAX_VERSION`, он рисуется со
 * знаком; иначе — без знака на M, а что не лезет и туда — на L. Строка, для
 * которой нет версии вовсе, даёт пустое место, а не падение окна: без
 * `onError` библиотека бросает исключение прямо из отрисовки.
 *
 * Знак лежит поверх кода отдельным слоем, а не через `logo` библиотеки: там
 * только растровая картинка, а марка — контуры, и ей не нужен PNG в трёх
 * плотностях. Цвета знака — фирменные (`BRAND_MARK`), а не из темы.
 */
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import QRMatrix from 'qrcode';
import type { QRCodeErrorCorrectionLevel } from 'qrcode';
import { AirChatMark } from './AirChatMark';
import { BRAND_MARK, QR_CODE } from '../theme';

/** Сторона плашки со знаком относительно стороны кода. */
export const LOGO_SHARE = 0.22;

/**
 * Самая густая сетка, на которую ещё кладётся знак: версия 15 — 77 модулей,
 * это 2,3 pt на модуль в коде шириной 180 pt. Контакт (≈75 байт) выходит на
 * версию 8 и сюда укладывается с большим запасом.
 */
export const LOGO_MAX_VERSION = 15;

type Plan = { ecl: QRCodeErrorCorrectionLevel; logo: boolean } | null;

function versionAt(value: string, ecl: QRCodeErrorCorrectionLevel): number | null {
  try {
    return QRMatrix.create(value, { errorCorrectionLevel: ecl }).version;
  } catch {
    return null;
  }
}

/** Уровень коррекции и то, влезает ли знак. `null` — строку не закодировать. */
export function planQr(value: string): Plan {
  const high = versionAt(value, 'H');
  if (high !== null && high <= LOGO_MAX_VERSION) return { ecl: 'H', logo: true };
  if (versionAt(value, 'M') !== null) return { ecl: 'M', logo: false };
  if (versionAt(value, 'L') !== null) return { ecl: 'L', logo: false };
  return null;
}

export type BrandedQrProps = {
  value: string;
  size: number;
};

export function BrandedQr({ value, size }: BrandedQrProps): React.ReactElement | null {
  const plan = useMemo(() => planQr(value), [value]);
  if (plan === null) return null;
  const chip = Math.round(size * LOGO_SHARE);
  return (
    <View style={{ width: size, height: size }}>
      <QRCode value={value} size={size} ecl={plan.ecl} color={QR_CODE.ink} backgroundColor={QR_CODE.fill} />
      {plan.logo ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
          <View style={[styles.chip, { width: chip, height: chip, borderRadius: chip * 0.24 }]}>
            <AirChatMark size={chip * 0.7} from={BRAND_MARK.from} to={BRAND_MARK.to} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  chip: { alignItems: 'center', justifyContent: 'center', backgroundColor: QR_CODE.fill },
});
