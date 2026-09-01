import React from 'react';
import { Switch, type SwitchProps } from 'react-native';

import { useTheme } from '../ThemeContext';
import { switchTone } from '../theme';

/**
 * Переключатель приложения.
 *
 * Цвета намеренно НЕ выведены наружу: `trackColor` и `thumbColor` вычеркнуты из
 * пропсов. До v4.32.400 каждый из шестнадцати переключателей называл их сам, и
 * все шестнадцать называли одинаково неверно — дорожку красили токеном
 * волосяной линии, отчего в светлой теме выключенный переключатель пропадал с
 * экрана целиком (1.52:1 и к карточке, и к бегунку). Пока цвет можно указать на
 * месте вызова, эта ошибка возвращается с каждым новым переключателем; здесь
 * указать его нельзя.
 *
 * Вывод самих значений — в `switchTone`, там же измерения.
 */
export type AppSwitchProps = Omit<SwitchProps, 'trackColor' | 'thumbColor'>;

export function AppSwitch(props: AppSwitchProps): React.ReactElement {
  const { colors } = useTheme();
  const tone = switchTone(colors);
  return (
    <Switch
      {...props}
      trackColor={{ false: tone.trackOff, true: tone.trackOn }}
      thumbColor={tone.thumb}
    />
  );
}
