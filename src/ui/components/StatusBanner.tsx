import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from './AppPressable';
import { useTheme } from '../ThemeContext';
import { fadedOn, font, radius, type AppColors } from '../theme';

/**
 * StatusBanner — полоска состояния над содержимым.
 *
 * v4.32.385. Таких полосок в приложении три (очередь отправки, нехватка места,
 * защищённый канал), и каждая была написана заново: свой StyleSheet, свои
 * скругления, свои отступы и — главное — своя палитра, вписанная руками:
 * '#2a2318' / '#4a3d28' / '#e8b060' у одной, '#2a1818' / '#ffb4b4' у второй,
 * '#1a2238' / '#142318' / '#8fd99a' / '#9aa3c0' у третьей. Ни одна из трёх не
 * спрашивала тему вовсе.
 *
 * То есть в светлой теме поверх белого фона рисовались тёмно-коричневая и
 * тёмно-красная карточки со светлым текстом — ровно то, чего палитра и
 * контрастный тест призваны не допускать, но проверить они это не могли:
 * значения лежали не в палитре.
 *
 * Здесь остаётся одна полоска на все три случая. Цвет задаётся не цветом, а
 * НАЗНАЧЕНИЕМ (tone) и разворачивается в токены палитры, поэтому пороги
 * контраста для неё проверяются тем же тестом, что и для всего остального.
 */
export type BannerTone = 'neutral' | 'ok' | 'warn' | 'error';

/**
 * Прозрачность цветной рамки. Рамка — намёк на назначение, а не носитель
 * смысла: смысл несут значок и текст, поэтому порог для графики к ней не
 * применяется и её можно держать приглушённой.
 *
 * v4.32.416: было `'55'` — строкой, чтобы приклеиться к цвету восьмым и
 * девятым знаком хекса. Такой цвет не разбирается ничем и не измеряется
 * ничем, поэтому рамка единственная из трёх величин полоски не проверялась
 * вовсе. Теперь это число, а цвет считается от подложки и остаётся
 * непрозрачным — тот же самый, байт в байт, но уже измеримый.
 */
const BORDER_ALPHA = 0x55 / 255;

/**
 * Цвет текста и заливки полоски. Чистая функция: используется и тестом.
 *
 * Заливка — приподнятая поверхность, а не оттенок самого цвета. Оттенок
 * пробовался и не прошёл: у светлой палитры семантические цвета лежат на
 * 4.5–5.9:1, то есть у самого порога, и подмешивание их же в фон опускало
 * текст до 3.7–4.3:1. Цвет остаётся в значке, тексте и рамке — там он ничего
 * не портит.
 */
export function bannerColors(
  tone: BannerTone,
  colors: AppColors
): { ink: string; fill: string; border: string } {
  const ink =
    tone === 'ok' ? colors.success
      : tone === 'warn' ? colors.warning
        : tone === 'error' ? colors.error
          : colors.textSecondary;
  const fill = colors.surfaceHigh;
  return { ink, fill, border: fadedOn(ink, fill, BORDER_ALPHA) };
}

export interface StatusBannerProps {
  tone: BannerTone;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  text: string;
  /** Нажатие на всю полоску (например, «повторить подключение»). */
  onPress?: () => void;
  accessibilityLabel?: string;
  /** 'assertive' — для того, что человек должен услышать сразу (потеря данных). */
  liveRegion?: 'none' | 'polite' | 'assertive';
  /**
   * Правый край полоски — крестик «скрыть» и подобное. Получает цвет текста:
   * иначе крестик пришлось бы красить вторым правилом и он бы отстал.
   */
  trailing?: (ink: string) => React.ReactNode;
}

export function StatusBanner({
  tone,
  icon,
  text,
  onPress,
  accessibilityLabel,
  liveRegion = 'none',
  trailing,
}: StatusBannerProps): React.ReactElement {
  const { colors } = useTheme();
  const { ink, fill, border } = bannerColors(tone, colors);
  const skin = { backgroundColor: fill, borderColor: border };

  const body = (
    <>
      <Ionicons name={icon} size={14} color={ink} />
      <Text style={[styles.text, { color: ink }]} accessibilityLiveRegion={liveRegion}>
        {text}
      </Text>
      {trailing ? trailing(ink) : null}
    </>
  );

  if (onPress) {
    return (
      <AppPressable
        onPress={onPress}
        style={({ pressed }) => [styles.row, skin, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        {body}
      </AppPressable>
    );
  }

  return <View style={[styles.row, skin]}>{body}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 12,
    marginTop: 4,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  pressed: { opacity: 0.85 },
  text: { fontSize: font.xs, flex: 1, marginLeft: 6, marginRight: 8 },
});
