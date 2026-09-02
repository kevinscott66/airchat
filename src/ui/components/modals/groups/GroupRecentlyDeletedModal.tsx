import React, { memo, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { badgeTint, font, radius, scrim, type TintedIcon } from '../../../theme';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { POLL_PREFIX } from '../../../../core/storage/local';
import { dayMonthShort } from '../../../../core/time/ruDateTime';

export interface GroupRecentlyDeletedEntry {
  id: string;
  text: string;
  senderName: string;
  deletedAt: number;
}

export interface GroupRecentlyDeletedModalProps {
  visible: boolean;
  onClose: () => void;
  items: GroupRecentlyDeletedEntry[];
  onRestore: (entry: GroupRecentlyDeletedEntry) => void;
}

const noop = () => {};

function GroupRecentlyDeletedModalImpl({ visible, onClose, items, onRestore }: GroupRecentlyDeletedModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  // v4.32.409: плашка «Восстановить» — от поверхности окна, надпись — от
  // плашки. Считается здесь, а не в строке: строка обёрнута в memo.
  const restore = useMemo(() => badgeTint(colors, 'accent', colors.surface), [colors]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <AppPressable
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          onPress={noop}
        >
          {mounted ? (
            <>
              <View style={[styles.header, { borderColor: colors.border }]}>
                <Ionicons name="trash-outline" size={18} color={colors.textMuted} style={styles.headerIcon} />
                <Text style={[styles.title, { color: colors.text }]}>Недавно удалённые</Text>
                <AppPressable onPress={onClose} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              <Text style={[styles.hint, { color: colors.textMuted }]}>
                {'Сообщения хранятся 7 дней после удаления. Восстановление только локально.'}
              </Text>
              <ScrollView contentContainerStyle={styles.scrollPad}>
                {items.length === 0 ? (
                  <Text style={[styles.empty, { color: colors.textMuted }]}>Нет недавно удалённых сообщений</Text>
                ) : items.map((entry) => (
                  <DeletedRow
                    key={entry.id}
                    entry={entry}
                    onRestore={onRestore}
                    textColor={colors.text}
                    mutedColor={colors.textMuted}
                    borderColor={colors.border}
                    restore={restore}
                  />
                ))}
              </ScrollView>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

interface RowProps {
  entry: GroupRecentlyDeletedEntry;
  onRestore: (entry: GroupRecentlyDeletedEntry) => void;
  textColor: string;
  mutedColor: string;
  borderColor: string;
  restore: TintedIcon;
}

function DeletedRowImpl({ entry, onRestore, textColor, mutedColor, borderColor, restore }: RowProps) {
  const handleRestore = useCallback(() => onRestore(entry), [onRestore, entry]);
  const preview = entry.text.startsWith('\x01')
    ? '[Медиасообщение]'
    : entry.text.startsWith(POLL_PREFIX)
      ? '[Опрос]'
      : entry.text;
  return (
    <View style={[styles.row, { borderColor }]}>
      <View style={styles.rowHead}>
        <Ionicons name="person-outline" size={12} color={mutedColor} style={styles.rowIcon} />
        <Text style={[styles.rowSender, { color: mutedColor }]}>{entry.senderName}</Text>
        <Text style={[styles.rowDate, { color: mutedColor }]}>
          {dayMonthShort(entry.deletedAt)}
        </Text>
      </View>
      <Text style={[styles.rowText, { color: textColor }]} numberOfLines={3}>{preview}</Text>
      <AppPressable
        style={[styles.restoreBtn, { backgroundColor: restore.fill }]}
        onPress={handleRestore}
      >
        <Text style={[styles.restoreText, { color: restore.ink }]}>Восстановить</Text>
      </AppPressable>
    </View>
  );
}
const DeletedRow = memo(DeletedRowImpl);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: scrim.modal },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '75%' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  headerIcon: { marginRight: 10 },
  title: { fontSize: 17, fontWeight: '700', flex: 1 },
  hint: { fontSize: 12, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  scrollPad: { paddingBottom: 32 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
  row: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  rowIcon: { marginRight: 4 },
  rowSender: { fontSize: font.xs, flex: 1 },
  rowDate: { fontSize: font.xs },
  rowText: { fontSize: 14, marginBottom: 8 },
  restoreBtn: { alignSelf: 'flex-start', borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 5 },
  restoreText: { fontSize: 13, fontWeight: '600' },
});

export const GroupRecentlyDeletedModal = memo(GroupRecentlyDeletedModalImpl);
