import React, { memo, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { scrim } from '../../../theme';
import { dayMonthShortYear } from '../../../../core/time/ruDateTime';
import { isUnreadableMessage, UNREADABLE_MESSAGE_TEXT } from '../../../../core/storage/unreadableText';

export interface StarredMessage {
  id: string;
  text: string;
  createdAt: number;
  direction: 'in' | 'out';
  /**
   * v4.32.578: текст не открылся ключом данных. Пустая строка в `text` без
   * этого признака выглядела как избранное сообщение вообще без текста.
   */
  unreadable?: boolean;
}

export interface ChatStarredModalProps {
  visible: boolean;
  onClose: () => void;
  entries: Array<{ message: StarredMessage }>;
  selfLabel: string;
  peerLabel: string;
  onUnstar: (id: string) => void;
}

const noop = () => {};

function ChatStarredModalImpl({ visible, onClose, entries, selfLabel, peerLabel, onUnstar }: ChatStarredModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();

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
                <Ionicons name="star" size={18} color={colors.star} style={styles.headerIcon} />
                <Text style={[styles.title, { color: colors.text }]}>Избранные сообщения</Text>
                <AppPressable onPress={onClose}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              <ScrollView contentContainerStyle={styles.scrollContent}>
                {entries.length === 0 ? (
                  <Text style={[styles.empty, { color: colors.textMuted }]}>Нет избранных сообщений</Text>
                ) : entries.map((entry) => (
                  <StarredRow
                    key={entry.message.id}
                    msg={entry.message}
                    onUnstar={onUnstar}
                    selfLabel={selfLabel}
                    peerLabel={peerLabel}
                    textColor={colors.text}
                    mutedColor={colors.textMuted}
                    borderColor={colors.border}
                    primaryColor={colors.primary}
                    starColor={colors.star}
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
  msg: StarredMessage;
  onUnstar: (id: string) => void;
  selfLabel: string;
  peerLabel: string;
  textColor: string;
  mutedColor: string;
  borderColor: string;
  primaryColor: string;
  starColor: string;
}

function StarredRowImpl({ msg, onUnstar, selfLabel, peerLabel, textColor, mutedColor, borderColor, primaryColor, starColor }: RowProps) {
  const handleUnstar = useCallback(() => onUnstar(msg.id), [onUnstar, msg.id]);
  const unreadable = isUnreadableMessage(msg);
  return (
    <View style={[styles.row, { borderColor }]}>
      <View style={styles.rowMetaWrap}>
        <Ionicons name="star" size={12} color={starColor} style={styles.starIcon} />
        <Text style={[styles.meta, { color: mutedColor }]}>
          {dayMonthShortYear(msg.createdAt)}
          {' · '}
          {msg.direction === 'out' ? selfLabel : peerLabel}
        </Text>
      </View>
      <Text
        style={[styles.rowText, unreadable ? styles.rowTextUnreadable : null, { color: unreadable ? mutedColor : textColor }]}
        numberOfLines={4}
      >{unreadable ? UNREADABLE_MESSAGE_TEXT : msg.text}</Text>
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
  rowMetaWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  starIcon: { marginRight: 6 },
  meta: { fontSize: 11 },
  rowTextUnreadable: { fontStyle: 'italic' },
  rowText: { fontSize: 14 },
  unstarBtn: { marginTop: 6 },
  unstarText: { fontSize: 12 },
});

export const ChatStarredModal = memo(ChatStarredModalImpl);
