/**
 * Повторяющиеся детали экрана настроек: шапка подэкрана, строка меню, плашка.
 *
 * Все три жили внутри SettingsScreen как локальные компоненты — то есть
 * объявлялись заново на каждый рендер экрана. Для React это каждый раз новый
 * тип компонента, а значит не обновление поддерева, а снос и построение
 * заново: терялось внутреннее состояние всего, что стоит под ними, и делалась
 * работа, которой могло не быть. Заметнее всего это на подэкранах с полем
 * ввода — там перемонтирование отбирает фокус посреди набора.
 *
 * Отсюда форма: не три отдельных экспорта, которым на каждом месте вызова
 * пришлось бы передавать палитру и стили (а таких мест под сорок), а фабрика.
 * Экран зовёт её один раз на тему и получает набор стабильных компонентов —
 * разметка при этом не меняется ни в одной строке.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppPressable } from '../../components/AppPressable';
import { badgeTint, tintedIcon, type AppColors, type BadgeTone, type MenuIconHue } from '../../theme';
import type { makeStyles } from './settingsStyles';

type SettingsStyles = ReturnType<typeof makeStyles>;

export type SubHeaderProps = { title: string };

export type MenuRowProps = {
  iconName: React.ComponentProps<typeof Ionicons>['name'];
  /** v4.32.392: ИМЯ тона, а не пара «цвет + тот же цвет с суффиксом 22». */
  hue: MenuIconHue;
  label: string;
  badge?: string;
  onPress: () => void;
  testID?: string;
};

export type StatusBadgeProps = { tone: BadgeTone; text: string };

export type SettingsChrome = {
  SubHeader: (p: SubHeaderProps) => React.ReactElement;
  MenuRow: (p: MenuRowProps) => React.ReactElement;
  StatusBadge: (p: StatusBadgeProps) => React.ReactElement;
};

/**
 * Собрать набор под конкретную тему. Вызывать один раз на палитру: смысл
 * выноса в том, что между рендерами компоненты остаются теми же самыми.
 */
export function createSettingsChrome(
  styles: SettingsStyles,
  colors: AppColors,
  onBack: () => void,
): SettingsChrome {
  const SubHeader = ({ title }: SubHeaderProps) => (
    <View style={styles.subHeader}>
      <AppPressable
        onPress={onBack}
        style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 20 }}
        android_ripple={{ color: colors.ripple, borderless: true, radius: 24 }}
      >
        <Ionicons name="chevron-back" size={24} color={colors.accent} />
        <Text style={styles.backBtnText}>Назад</Text>
      </AppPressable>
      <Text style={styles.subTitle} numberOfLines={1}>{title}</Text>
      <View style={{ width: 36 }} />
    </View>
  );

  /**
   * Плашка состояния справа в строке: «Вкл» / «Выкл» / счётчик.
   *
   * v4.32.396: подложка была одна на все состояния и вписана в StyleSheet
   * ('#1a3d2e'), а рядом с ней жили ещё два правила — тон с прозрачностью на
   * месте вызова и пара литералов '#2196f3' / '#2196f322'. Теперь строка
   * называет ТОН, а подложка с надписью считаются из него парой.
   */
  const StatusBadge = ({ tone, text }: StatusBadgeProps) => {
    const tint = badgeTint(colors, tone);
    return (
      <View style={[styles.badge, { backgroundColor: tint.fill }]}>
        <Text style={[styles.badgeText, { color: tint.ink }]}>{text}</Text>
      </View>
    );
  };

  const MenuRow = ({ iconName, hue, label, badge, onPress, testID }: MenuRowProps) => {
    const tint = tintedIcon(hue, colors);
    return (
      <AppPressable
        style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
        onPress={onPress}
        testID={testID}
        android_ripple={{ color: colors.ripple }}
      >
        <View style={[styles.menuIcon, { backgroundColor: tint.fill }]}>
          <Ionicons name={iconName} size={20} color={tint.ink} />
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.label}>{label}</Text>
          {badge ? <Text style={styles.desc}>{badge}</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </AppPressable>
    );
  };

  return { SubHeader, MenuRow, StatusBadge };
}
