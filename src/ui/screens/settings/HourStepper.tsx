/**
 * Выбор часа стрелками: «▾ 22:00 ▴».
 *
 * В настройках он встречается трижды — начало и конец ночного режима, граница
 * тихих часов, — и все три раза был выписан целиком, вместе с одинаковой
 * арифметикой перехода через полночь. Три копии одного вычисления означают
 * три места, где эту полночь можно однажды не учесть.
 *
 * Компонент объявлен на уровне модуля, а стили и палитра приходят пропсами:
 * если объявлять его внутри экрана, React на каждом рендере видел бы новый тип
 * и сносил бы поддерево вместо обновления.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppPressable } from '../../components/AppPressable';
import type { AppColors } from '../../theme';
import type { makeStyles } from './settingsStyles';

type SettingsStyles = ReturnType<typeof makeStyles>;

export type HourStepperProps = {
  styles: SettingsStyles;
  colors: AppColors;
  /** Текущий час, 0–23. */
  hour: number;
  /** Получает уже посчитанный новый час — вызывающему не нужно знать про полночь. */
  onChange: (hour: number) => void;
  /** Подпись сверху: нужна, когда рядом стоит второй такой же. */
  caption?: string;
  /**
   * Чем этот выбор является — для озвучки: «начало ночного режима».
   * Стрелки сами по себе безымянны, а когда их на экране четыре, «часом
   * раньше» без уточнения не говорит ничего.
   */
  a11yName?: string;
  /** Ширина поля с часом и размер цифр: одиночный выбор показывают крупнее. */
  minWidth?: number;
  fontSize?: number;
};

export function HourStepper({
  styles,
  colors,
  hour,
  onChange,
  caption,
  a11yName,
  minWidth = 44,
  fontSize,
}: HourStepperProps): React.ReactElement {
  const about = a11yName ? `: ${a11yName}` : '';
  const value = `${String(hour).padStart(2, '0')}:00`;
  return (
    <View style={{ alignItems: 'center' }}>
      {caption ? <Text style={[styles.desc, { marginBottom: 4 }]}>{caption}</Text> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <AppPressable
          onPress={() => onChange((hour - 1 + 24) % 24)}
          style={styles.hourBtn}
          accessibilityRole="button"
          accessibilityLabel={`Часом раньше${about}`}
        >
          <Ionicons name="chevron-down" size={18} color={colors.text} />
        </AppPressable>
        <Text
          style={[styles.label, { minWidth, textAlign: 'center' }, fontSize ? { fontSize } : null]}
          accessibilityLabel={a11yName ? `${a11yName}: ${value}` : value}
        >
          {value}
        </Text>
        <AppPressable
          onPress={() => onChange((hour + 1) % 24)}
          style={styles.hourBtn}
          accessibilityRole="button"
          accessibilityLabel={`Часом позже${about}`}
        >
          <Ionicons name="chevron-up" size={18} color={colors.text} />
        </AppPressable>
      </View>
    </View>
  );
}
