import React, { memo, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { scrim } from '../../../theme';
import {
  type GroupMessageRow,
  type StarredMessageEntry,
  setGroupMessageStarred,
} from '../../../../core/storage/local';
import { shortIdentity } from '../../../identity/shortId';
import { dayMonthShortYear } from '../../../../core/time/ruDateTime';
import { isUnreadableMessage, UNREADABLE_MESSAGE_TEXT } from '../../../../core/storage/unreadableText';

export interface GroupStarredModalProps {
  visible: boolean;
  onClose: () => void;
  starredEntries: StarredMessageEntry[];
  setStarredEntries: React.Dispatch<React.SetStateAction<StarredMessageEntry[]>>;
  onReload: () => void;
}

function GroupStarredModalImpl({ visible, onClose, starredEntries, setStarredEntries, onReload }: GroupStarredModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  const stopPropagation = useCallback((e: { stopPropagation?: () => void }) => { e.stopPropagation?.(); }, []);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <AppPressable
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          onPress={stopPropagation}
        >
          {mounted ? (
            <>
              <View style={[styles.header, { borderColor: colors.border }]}>
                <Ionicons name="star" size={18} color={colors.star} style={styles.headerIcon} />
                <Text style={[styles.title, { color: colors.text }]}>Избранные сообщения</Text>
                <AppPressable onPress={onClose}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              <ScrollView contentContainerStyle={styles.scrollContent}>
                {starredEntries.length === 0 ? (
                  <Text style={[styles.empty, { color: colors.textMuted }]}>Нет избранных сообщений</Text>
                ) : starredEntries.map((entry) => (
                  <StarredRow
                    key={(entry.message as GroupMessageRow).id}
                    entry={entry}
                    textColor={colors.text}
                    mutedColor={colors.textMuted}
                    primaryColor={colors.primary}
                    starColor={colors.star}
                    borderColor={colors.border}
                    setStarredEntries={setStarredEntries}
                    onReload={onReload}
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
  entry: StarredMessageEntry;
  textColor: string;
  mutedColor: string;
  primaryColor: string;
  starColor: string;
  borderColor: string;
  setStarredEntries: React.Dispatch<React.SetStateAction<StarredMessageEntry[]>>;
  onReload: () => void;
}

function StarredRowImpl({ entry, textColor, mutedColor, primaryColor, starColor, borderColor, setStarredEntries, onReload }: RowProps) {
  const grpMsg = entry.message as GroupMessageRow;
  const handleUnstar = useCallback(() => {
    void setGroupMessageStarred(grpMsg.id, false).then(() => {
      setStarredEntries((prev) => prev.filter((e) => (e.message as GroupMessageRow).id !== grpMsg.id));
      onReload();
    });
  }, [grpMsg.id, setStarredEntries, onReload]);
  const unreadable = isUnreadableMessage(grpMsg);

  return (
    <View style={[styles.row, { borderColor }]}>
      <View style={styles.rowHeader}>
        <Ionicons name="star" size={12} color={starColor} style={styles.rowHeaderIcon} />
        <Text style={[styles.rowMeta, { color: mutedColor }]}>
          {dayMonthShortYear(grpMsg.createdAt)}
          {' · '}
          {grpMsg.senderName ?? shortIdentity(grpMsg.senderPubB64)}
        </Text>
      </View>
      <Text
        style={[styles.rowText, unreadable ? styles.rowTextUnreadable : null, { color: unreadable ? mutedColor : textColor }]}
        numberOfLines={4}
      >{unreadable ? UNREADABLE_MESSAGE_TEXT : grpMsg.text}</Text>
      <AppPressable onPress={handleUnstar} style={styles.unstarBtn}>
        <Text style={[styles.unstarText, { color: primaryColor }]}>Убрать из избранного</Text>
      </AppPressable>
    </View>
  );
}
const StarredRow = memo(StarredRowImpl);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: scrim.modal },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '75%' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  headerIcon: { marginRight: 10 },
  title: { fontSize: 17, fontWeight: '700', flex: 1 },
  scrollContent: { paddingBottom: 24 },
  empty: { textAlign: 'center', marginTop: 32, fontSize: 15 },
  row: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  rowHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  rowHeaderIcon: { marginRight: 6 },
  rowMeta: { fontSize: 11 },
  rowText: { fontSize: 14 },
  rowTextUnreadable: { fontStyle: 'italic' },
  unstarBtn: { marginTop: 6 },
  unstarText: { fontSize: 12 },
});

export const GroupStarredModal = memo(GroupStarredModalImpl);
