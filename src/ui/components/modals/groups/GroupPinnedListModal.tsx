import React, { memo, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { isUnreadableMessage, UNREADABLE_MESSAGE_TEXT } from '../../../../core/storage/unreadableText';
import { scrim } from '../../../theme';

/**
 * v4.32.576: `unreadable` — своя копия сообщения не открывается ключом
 * данных. Текст при этом пуст, и без пометки строка списка выглядела как
 * закрепление без текста.
 */
export interface GroupPinnedItem {
  id: string;
  text: string;
  unreadable?: boolean;
}

export interface GroupPinnedListModalProps {
  visible: boolean;
  onClose: () => void;
  pinnedList: GroupPinnedItem[];
  canPin: boolean;
  onJumpTo: (id: string, idx: number) => void;
  onUnpin: (id: string) => void;
}

function GroupPinnedListModalImpl({ visible, onClose, pinnedList, canPin, onJumpTo, onUnpin }: GroupPinnedListModalProps) {
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
                <Ionicons name="pin" size={18} color={colors.accent} style={styles.headerIcon} />
                <Text style={[styles.title, { color: colors.text }]}>
                  Закреплённые ({pinnedList.length})
                </Text>
                <AppPressable onPress={onClose}>
                  <Ionicons name="close" size={20} color={colors.textMuted} />
                </AppPressable>
              </View>
              <ScrollView>
                {pinnedList.map((pin, idx) => (
                  <PinnedRow
                    key={pin.id}
                    pin={pin}
                    idx={idx}
                    canPin={canPin}
                    onJumpTo={onJumpTo}
                    onUnpin={onUnpin}
                    textColor={colors.text}
                    mutedColor={colors.textMuted}
                    borderColor={colors.border}
                  />
                ))}
                {pinnedList.length === 0 ? (
                  <Text style={[styles.empty, { color: colors.textMuted }]}>Нет закреплённых сообщений</Text>
                ) : null}
              </ScrollView>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

interface RowProps {
  pin: GroupPinnedItem;
  idx: number;
  canPin: boolean;
  onJumpTo: (id: string, idx: number) => void;
  onUnpin: (id: string) => void;
  textColor: string;
  mutedColor: string;
  borderColor: string;
}

function PinnedRowImpl({ pin, idx, canPin, onJumpTo, onUnpin, textColor, mutedColor, borderColor }: RowProps) {
  const handleJump = useCallback(() => onJumpTo(pin.id, idx), [onJumpTo, pin.id, idx]);
  const handleUnpin = useCallback(() => onUnpin(pin.id), [onUnpin, pin.id]);
  const unreadable = isUnreadableMessage(pin);
  return (
    <AppPressable style={[styles.row, { borderColor }]} onPress={handleJump}>
      <View style={styles.rowContent}>
        <Text
          style={[styles.rowText, unreadable ? styles.rowTextUnreadable : null, { color: unreadable ? mutedColor : textColor }]}
          numberOfLines={2}
        >
          {unreadable ? UNREADABLE_MESSAGE_TEXT : pin.text}
        </Text>
      </View>
      {canPin ? (
        <AppPressable hitSlop={10} onPress={handleUnpin} style={styles.unpinBtn}>
          <Ionicons name="close-circle-outline" size={20} color={mutedColor} />
        </AppPressable>
      ) : null}
    </AppPressable>
  );
}
const PinnedRow = memo(PinnedRowImpl);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: scrim.modal, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '70%', paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  headerIcon: { marginRight: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowContent: { flex: 1 },
  rowText: { fontSize: 14 },
  rowTextUnreadable: { fontStyle: 'italic' },
  unpinBtn: { padding: 8 },
  empty: { textAlign: 'center', padding: 24 },
});

export const GroupPinnedListModal = memo(GroupPinnedListModalImpl);
