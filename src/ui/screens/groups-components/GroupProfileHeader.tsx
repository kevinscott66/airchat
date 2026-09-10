/**
 * GroupProfileHeader — шапка группы и канала, собранная как профиль
 * (v4.32.682).
 *
 * До этой версии шапка была строкой в две колонки прямо в разметке экрана на
 * шесть тысяч строк: слева снимок 80pt, справа столбик из названия, адреса,
 * описания, счётчика и постоянного идентификатора. Тот же экран рисует
 * переписку, список участников, поиск и полтора десятка окон — и шапка в нём
 * тонула: чтобы понять её состав, приходилось запускать приложение.
 *
 * Здесь она собрана так, как в приложении выглядит профиль человека: снимок по
 * центру, под ним имя, под именем — кто это и сколько тут людей, и лишь затем
 * подробности отдельными строками на стеклянной подложке. Это не вкусовая
 * правка: группа и канал — такие же собеседники, как человек, и открывая их
 * шапку пользователь ждёт профиль, а не строку списка.
 *
 * Состав и слова сюда не записаны — они в `groupProfileModel`, где их можно
 * проверить без React. Здесь только стекло, отступы и обработка нажатий.
 *
 * Числа кегля берутся из `font` целиком, без единого литерала: у этого файла
 * нет и не должно быть своей записи в `FONT_SIZE_BASELINE`
 * (см. `geometryScale.test.ts`).
 */

import React from 'react';
import { View, Text, TextInput, Image, StyleSheet, Clipboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../components/AppPressable';
import { GlassSurface } from '../../components/GlassSurface';
import { showSuccess } from '../../components/userFeedback';
import { useTheme } from '../../ThemeContext';
import { avatarShape, contrastingInk, font, radius, spacing, TOUCH_TARGET_MIN } from '../../theme';
import { COPIED_ID } from '../../clipboardText';
import {
  groupProfileRows,
  groupProfileSubtitle,
  groupProfileTitle,
  type GroupProfileFacts,
  type GroupProfileRow,
} from '../../components/groupProfileModel';
import { OWN_GROUP_DESC_MAX, OWN_GROUP_NAME_MAX } from '../../../core/social/groupNameRule';
import { USERNAME_MAX } from '../../../core/identity/username';
import { GroupAvatar } from './GroupAvatar';

export type GroupProfileHeaderProps = {
  facts: GroupProfileFacts;
  /** Снимок группы, если он загружен. */
  avatarUri: string | null;
  onPickAvatar: () => void;

  editingName: boolean;
  nameInput: string;
  onNameChange: (v: string) => void;
  onNameEdit: () => void;
  onNameSave: () => void;

  editingHandle: boolean;
  handleInput: string;
  onHandleChange: (v: string) => void;
  onHandleEdit: () => void;
  onHandleSave: () => void;

  editingDesc: boolean;
  descInput: string;
  onDescChange: (v: string) => void;
  onDescEdit: () => void;
  onDescSave: () => void;
};

/** Цвет строки: непрочитанная ячейка предупреждает, адрес зовёт, прочее молчит. */
function rowInk(
  row: GroupProfileRow,
  colors: { primary: string; warning: string; text: string; textMuted: string },
): string {
  if (row.unreadable === true) return colors.warning;
  if (row.value === null) return colors.textMuted;
  if (row.id === 'handle') return colors.primary;
  if (row.id === 'public_id') return colors.textMuted;
  return colors.text;
}

export function GroupProfileHeader(props: GroupProfileHeaderProps): React.ReactElement {
  const { facts } = props;
  const { colors } = useTheme();
  const rows = groupProfileRows(facts);

  const openRow = (row: GroupProfileRow): void => {
    if (row.id === 'handle') props.onHandleEdit();
    else if (row.id === 'description') props.onDescEdit();
  };

  const copyRow = (row: GroupProfileRow): void => {
    if (row.value === null) return;
    Clipboard.setString(row.value);
    showSuccess(row.id === 'public_id' ? COPIED_ID : 'Публичный адрес скопирован');
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <AppPressable
        onPress={props.onPickAvatar}
        disabled={!facts.amAdmin}
        accessibilityRole="button"
        accessibilityLabel={facts.type === 'channel' ? 'Изменить фото канала' : 'Изменить фото группы'}
        accessibilityState={{ disabled: !facts.amAdmin }}
      >
        {props.avatarUri ? (
          <Image source={{ uri: props.avatarUri }} style={avatarShape(88)} />
        ) : (
          <GroupAvatar name={facts.name} size={88} type={facts.type} />
        )}
        {facts.amAdmin ? (
          <View style={[styles.avatarBadge, { backgroundColor: colors.primary, borderColor: colors.surface }]}>
            <Ionicons name="camera" size={14} color={contrastingInk(colors.primary)} />
          </View>
        ) : null}
      </AppPressable>

      {props.editingName ? (
        <TextInput
          style={[styles.nameInput, { color: colors.text, borderColor: colors.primary }]}
          value={props.nameInput}
          onChangeText={props.onNameChange}
          onSubmitEditing={props.onNameSave}
          onBlur={props.onNameSave}
          maxLength={OWN_GROUP_NAME_MAX}
          autoFocus
          returnKeyType="done"
          testID="group_profile_name_input"
        />
      ) : (
        <AppPressable
          onPress={facts.amAdmin ? props.onNameEdit : undefined}
          accessibilityRole={facts.amAdmin ? 'button' : 'header'}
          accessibilityLabel={groupProfileTitle(facts)}
          testID="group_profile_name"
        >
          <Text
            style={[styles.name, { color: facts.nameUnreadable === true ? colors.warning : colors.text }]}
            numberOfLines={2}
          >
            {groupProfileTitle(facts)}
          </Text>
        </AppPressable>
      )}

      <Text style={[styles.subtitle, { color: colors.textMuted }]} testID="group_profile_subtitle">
        {groupProfileSubtitle(facts)}
      </Text>

      {/*
        Правка адреса и описания живёт над списком строк, а не внутри него:
        поле ввода — это не строка карточки, а её временная замена, и модель
        про поля ввода ничего не знает.
      */}
      {props.editingHandle ? (
        <TextInput
          style={[styles.field, { color: colors.primary, borderColor: colors.primary }]}
          value={props.handleInput}
          onChangeText={props.onHandleChange}
          onSubmitEditing={props.onHandleSave}
          onBlur={props.onHandleSave}
          placeholder="публичный_адрес"
          placeholderTextColor={colors.textMuted}
          maxLength={USERNAME_MAX}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="done"
          testID="group_profile_handle_input"
        />
      ) : null}
      {props.editingDesc ? (
        <TextInput
          style={[styles.field, styles.fieldTall, { color: colors.textSecondary, borderColor: colors.border }]}
          value={props.descInput}
          onChangeText={props.onDescChange}
          onBlur={props.onDescSave}
          placeholder={facts.type === 'channel' ? 'Описание канала…' : 'Описание группы…'}
          placeholderTextColor={colors.textMuted}
          maxLength={OWN_GROUP_DESC_MAX}
          multiline
          autoFocus
          testID="group_profile_desc_input"
        />
      ) : null}

      {rows.length > 0 ? (
        <GlassSurface variant="regular" rim={false} style={styles.rows}>
          {rows.map((row, i) => {
            const hidden =
              (row.id === 'handle' && props.editingHandle) || (row.id === 'description' && props.editingDesc);
            if (hidden) return null;
            const text = row.value ?? row.placeholder ?? '';
            const pressable = row.editable === true || row.copyable === true;
            return (
              <AppPressable
                key={row.id}
                style={[
                  styles.row,
                  i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border } : null,
                ]}
                onPress={
                  pressable
                    ? () => {
                        if (row.editable === true) openRow(row);
                        else copyRow(row);
                      }
                    : undefined
                }
                accessibilityRole={pressable ? 'button' : 'text'}
                accessibilityLabel={row.a11y}
                testID={`group_profile_row_${row.id}`}
              >
                <Text
                  style={[styles.rowText, { color: rowInk(row, colors) }]}
                  numberOfLines={row.id === 'description' ? 4 : 1}
                >
                  {text}
                </Text>
                {row.copyable === true && row.editable !== true ? (
                  <Ionicons name="copy-outline" size={14} color={colors.textMuted} />
                ) : null}
                {row.unreadable === true ? (
                  <Ionicons name="lock-closed-outline" size={14} color={colors.warning} />
                ) : null}
              </AppPressable>
            );
          })}
        </GlassSurface>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatarBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 26,
    height: 26,
    borderRadius: radius.full,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: font.xl, fontWeight: '700', textAlign: 'center' },
  nameInput: {
    alignSelf: 'stretch',
    fontSize: font.xl,
    fontWeight: '700',
    textAlign: 'center',
    borderBottomWidth: 1,
    paddingVertical: 2,
  },
  subtitle: { fontSize: font.sm },
  field: {
    alignSelf: 'stretch',
    fontSize: font.sm,
    borderBottomWidth: 1,
    paddingVertical: 2,
    textAlign: 'center',
  },
  fieldTall: { minHeight: 44, textAlign: 'left' },
  rows: {
    alignSelf: 'stretch',
    marginTop: spacing.xs,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: TOUCH_TARGET_MIN,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowText: { fontSize: font.sm, flexShrink: 1, textAlign: 'center' },
});
