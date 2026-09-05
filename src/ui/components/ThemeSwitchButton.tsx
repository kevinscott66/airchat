/**
 * Переключатель светлой и тёмной темы на экранах без аккаунта.
 *
 * v4.32.592. Тема живёт в настройках, а настройки — за аккаунтом: человек,
 * который только поставил приложение, до них не доберётся. Пока он не завёл
 * аккаунт, приложение для него — это три экрана, и все три он видит в той
 * теме, которую выбрали за него (по умолчанию тёмная). Кнопка возвращает ему
 * этот выбор ровно там, где он сейчас находится.
 *
 * Две позиции, а не три. В настройках у темы есть ещё «как в системе», и это
 * правильно там, где рядом видно, что выбрано. Здесь виден только значок, и
 * третье состояние по нему не прочитать: значок солнца при «как в системе»
 * обещает светлую тему, а даст ту, что стоит в системе. Поэтому нажатие
 * ставит `light` или `dark` явно — от того, что нарисовано СЕЙЧАС (`scheme`),
 * а не от того, что записано в `mode`: при «как в системе» и при авторежиме
 * ночи это разные вещи, и человек смотрит на первое.
 *
 * Значок показывает, куда переключит, а не что включено: у кнопки с одним
 * значком это единственное чтение, которое не требует догадки.
 *
 * Стекла здесь нет намеренно. На этих экранах уже есть стеклянная карточка, а
 * `GlassSurface` заведён для навигации и крупных панелей: второй независимый
 * blur-контейнер на том же экране стоит кадров и ничего не добавляет. Кнопке
 * хватает кромки — той же, что у вторичной кнопки и полей внутри карточки
 * (`authCardRim`), и по той же причине: токен `border` на этих фонах даёт
 * около 1.2:1 при пороге графики 3:1, то есть кромки не видно вовсе.
 */
import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from './AppPressable';
import { useColors, useTheme } from '../ThemeContext';
import { authCardRim, radius, TOUCH_TARGET_MIN } from '../theme';

/** Кегль значка внутри цели касания: цель 44, значок вдвое меньше. */
const GLYPH = 20;

export function ThemeSwitchButton({ style }: { style?: StyleProp<ViewStyle> }): React.ReactElement {
  const colors = useColors();
  const { scheme, setMode } = useTheme();
  const toDark = scheme === 'light';
  const onPress = useCallback(() => {
    void setMode(toDark ? 'dark' : 'light');
  }, [setMode, toDark]);
  return (
    <View style={[styles.slot, style]} pointerEvents="box-none">
      <AppPressable
        onPress={onPress}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={toDark ? 'Тёмная тема' : 'Светлая тема'}
        testID="btn_theme_switch"
        style={[styles.button, { borderColor: authCardRim(colors) }]}
      >
        <Ionicons
          name={toDark ? 'moon-outline' : 'sunny-outline'}
          size={GLYPH}
          color={colors.textSecondary}
        />
      </AppPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Гнездо абсолютом: кнопка стоит над содержимым экрана, а не в его потоке, —
   * иначе она сдвигала бы карточку с середины. Абсолют внутри `SafeScreen`
   * отсчитывается от его внутренней рамки, поэтому под вырез кнопка не уедет.
   */
  slot: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 1,
  },
  button: {
    width: TOUCH_TARGET_MIN,
    height: TOUCH_TARGET_MIN,
    borderRadius: radius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
