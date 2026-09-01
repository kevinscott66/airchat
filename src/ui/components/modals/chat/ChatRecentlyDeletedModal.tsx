import React, { memo, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { badgeTint, scrim, type TintedIcon } from '../../../theme';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { dayMonthShortTime, numericDate } from '../../../../core/time/ruDateTime';

export interface RecentlyDeletedItem {
  id: string;
  text: string;
  direction: string;
  deletedAt: number;
}

export interface ChatRecentlyDeletedModalProps {
  visible: boolean;
  onClose: () => void;
  items: RecentlyDeletedItem[];
  onRestore: (text: string) => void;
}

const noop = () => {};

function ChatRecentlyDeletedModalImpl({ visible, onClose, items, onRestore }: ChatRecentlyDeletedModalProps) {
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
              {items.length === 0 ? (
                <View style={styles.emptyWrap}>
                  <Ionicons name="trash-outline" size={44} color={colors.textMuted} />
                  <Text style={[styles.emptyTitle, { color: colors.textMuted }]}>Нет удалённых сообщений</Text>
                  <Text style={[styles.emptyHint, { color: colors.textMuted }]}>Сообщения хранятся 30 дней</Text>
                </View>
              ) : (
                <ScrollView style={styles.flex1}>
                  {items.map((m) => (
                    <DeletedRow
                      key={m.id}
                      item={m}
                      onRestore={onRestore}
                      textColor={colors.text}
                      mutedColor={colors.textMuted}
                      borderColor={colors.border}
                      restore={restore}
                    />
                  ))}
                </ScrollView>
              )}
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

interface RowProps {
  item: RecentlyDeletedItem;
  onRestore: (text: string) => void;
  textColor: string;
  mutedColor: string;
  borderColor: string;
  restore: TintedIcon;
}

function DeletedRowImpl({ item, onRestore, textColor, mutedColor, borderColor, restore }: RowProps) {
  const handleRestore = useCallback(() => onRestore(item.text), [onRestore, item.text]);
  return (
    <View style={[styles.row, { borderColor }]}>
      <View style={styles.rowContent}>
        <Text style={[styles.rowText, { color: textColor }]} numberOfLines={3}>{item.text}</Text>
        <Text style={[styles.rowMeta, { color: mutedColor }]}>
          {item.direction === 'out' ? '→ Вы' : '← Собеседник'} · {numericDate(item.deletedAt)}
        </Text>
        <Text style={[styles.rowMetaSmall, { color: mutedColor }]}>
          Удалено: {dayMonthShortTime(item.deletedAt)}
        </Text>
      </View>
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
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '70%', paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  headerIcon: { marginRight: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '700' },
  emptyWrap: { alignItems: 'center', paddingVertical: 40 },
  emptyTitle: { marginTop: 12, fontSize: 15 },
  emptyHint: { marginTop: 4, fontSize: 12 },
  flex1: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  rowContent: { flex: 1 },
  rowText: { fontSize: 14 },
  rowMeta: { fontSize: 11, marginTop: 4 },
  rowMetaSmall: { fontSize: 10 },
  restoreBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  restoreText: { fontSize: 13, fontWeight: '600' },
});

export const ChatRecentlyDeletedModal = memo(ChatRecentlyDeletedModalImpl);
