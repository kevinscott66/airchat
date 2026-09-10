/**
 * Настройки группы и канала — своё окно с разделами (v4.32.680).
 *
 * Прежде их не было вовсе: пункты настроек лежали вперемешку с действиями над
 * перепиской в безымянном столбце, и столбцов этих было два — свой у
 * администратора, свой у участника. Почему так вышло и что теперь чему
 * подчиняется — в шапке `groupHubModel`.
 *
 * Состав, слова и текущие значения приходят готовыми оттуда; здесь только
 * оформление и раздача нажатий. Разделены намеренно: список пунктов должен
 * быть проверяем без React, а стекло и отступы проверять нечем.
 *
 * Лист стеклянный (`SheetShell`) — тот же, что у карточки профиля: окно,
 * открытое поверх переписки с обоями, обязано показывать, что под ним, иначе
 * читается как переход на другой экран.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { memo, useCallback } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppPressable } from '../../AppPressable';
import { AppSwitch } from '../../AppSwitch';
import { SheetShell } from '../../SheetShell';
import { useTheme } from '../../../ThemeContext';
import { font, glass, spacing, TOUCH_TARGET_MIN, withAlpha } from '../../../theme';
import {
  groupSettingsSections,
  groupSettingsTitle,
  type GroupHubFacts,
  type GroupSettingId,
} from '../../groupHubModel';

/** Значок строки. Одна таблица на все пункты: пропущенный id виден типом. */
const ICON: Record<GroupSettingId, React.ComponentProps<typeof Ionicons>['name']> = {
  mute: 'notifications-outline',
  auto_translate: 'language-outline',
  wallpaper: 'image-outline',
  font_size: 'text-outline',
  media: 'images-outline',
  starred: 'star-outline',
  recently_deleted: 'trash-bin-outline',
  slow_mode: 'hourglass-outline',
  disappear: 'timer-outline',
  invite_link: 'link-outline',
  stats: 'stats-chart-outline',
  admin_only_posting: 'create-outline',
  admin_only_pinning: 'pin-outline',
  require_approval: 'shield-checkmark-outline',
  anonymous_posting: 'eye-off-outline',
  export: 'download-outline',
  clear_history: 'trash-outline',
};

export interface GroupSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  facts: GroupHubFacts;
  /**
   * Нажали строку или дёрнули переключатель. Второй аргумент — положение, в
   * которое переключатель просят перевести; у обычной строки его нет.
   */
  onSelect: (id: GroupSettingId, next?: boolean) => void;
}

function GroupSettingsModalImpl({ visible, onClose, facts, onSelect }: GroupSettingsModalProps): React.ReactElement {
  const { colors } = useTheme();
  const sections = groupSettingsSections(facts);
  const rim = withAlpha(colors.text, glass.rim);

  // Обычная строка закрывает окно: за ней почти всегда следует другой лист
  // или подтверждение, и два наложенных листа — это то, ради чего окно и
  // переписывали. Переключатель окно НЕ закрывает: их дёргают подряд.
  const pick = useCallback(
    (id: GroupSettingId) => {
      onClose();
      onSelect(id);
    },
    [onClose, onSelect],
  );

  return (
    <SheetShell visible={visible} onClose={onClose} testID="group_settings_sheet">
      <Text style={[styles.title, { color: colors.text }]}>{groupSettingsTitle(facts)}</Text>
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {sections.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{section.title}</Text>
            {section.note ? (
              <Text style={[styles.sectionNote, { color: colors.textMuted }]}>{section.note}</Text>
            ) : null}
            {section.items.map((item) =>
              item.toggle === undefined ? (
                <AppPressable
                  key={item.id}
                  style={[styles.row, { borderTopColor: rim }]}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  onPress={() => pick(item.id)}
                >
                  <Ionicons name={ICON[item.id]} size={20} color={item.danger ? colors.error : colors.text} />
                  <Text style={[styles.rowLabel, { color: item.danger ? colors.error : colors.text }]}>
                    {item.label}
                  </Text>
                  {item.value ? (
                    <Text style={[styles.rowValue, { color: colors.textSecondary }]}>{item.value}</Text>
                  ) : null}
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </AppPressable>
              ) : (
                <View key={item.id} style={[styles.row, { borderTopColor: rim }]}>
                  <Ionicons name={ICON[item.id]} size={20} color={colors.text} />
                  <Text style={[styles.rowLabel, { color: colors.text }]}>{item.label}</Text>
                  <AppSwitch
                    value={item.toggle}
                    accessibilityLabel={item.label}
                    onValueChange={(next) => onSelect(item.id, next)}
                  />
                </View>
              ),
            )}
          </View>
        ))}
      </ScrollView>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.lg,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  // Высота ограничена: настройки администратора — четыре раздела, и без
  // потолка лист закрывает переписку целиком.
  scroll: { maxHeight: 480 },
  section: { marginBottom: spacing.md },
  sectionTitle: {
    fontSize: font.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.sm,
  },
  sectionNote: {
    fontSize: font.xs,
    marginTop: 2,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: TOUCH_TARGET_MIN,
  },
  rowLabel: {
    fontSize: font.md,
    flex: 1,
  },
  rowValue: {
    fontSize: font.sm,
  },
});

export const GroupSettingsModal = memo(GroupSettingsModalImpl);
