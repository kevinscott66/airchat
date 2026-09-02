import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../ThemeContext';

/**
 * Официальная галочка рядом с именем (v4.32.547).
 *
 * Одна на все экраны намеренно. Значок, означающий «это тот самый аккаунт»,
 * обязан выглядеть одинаково в списке чатов, в карточке и в ленте: галочка,
 * нарисованная в каждом месте по-своему, перестаёт быть узнаваемой — а узнать
 * её с одного взгляда и есть вся её работа.
 *
 * Цвет — `accent`, тот же, что у ссылок и активной вкладки, и берётся из темы,
 * а не вписан рядом: галочка должна следовать выбранному акценту, иначе на
 * тёмной теме с другим акцентом она читалась бы как чужеродная наклейка.
 *
 * Размер задаётся вызывающим и по умолчанию равен строчной высоте подписи:
 * галочка — спутник имени, а не самостоятельный элемент, и вырасти больше
 * имени она не должна.
 *
 * Значок не интерактивный и намеренно `accessibilityRole` не получает: он
 * ничего не делает по нажатию. Для чтения с экрана у него есть подпись —
 * иначе слепой человек не узнал бы об официальности вовсе.
 */
export function VerifiedMark({
  size = 14,
  label,
  style,
}: {
  size?: number;
  /** Что произносит озвучка. Текст даёт экран: в разных местах он разный. */
  label: string;
  style?: React.ComponentProps<typeof View>['style'];
}): React.ReactElement {
  const colors = useColors();
  return (
    <View style={[styles.wrap, style]} accessible accessibilityLabel={label}>
      <Ionicons name="checkmark-circle" size={size} color={colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginLeft: 4, justifyContent: 'center' },
});
