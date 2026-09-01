import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import type { GroupMessageRow } from '../../../../core/storage/local';
import { scrim } from '../../../theme';
import { COPY_ACTION, COPY_LINK_ACTION } from '../../../clipboardText';

export interface GroupQuickReactModalProps {
  msg: GroupMessageRow | null;
  onClose: () => void;
  onReact: (emoji: string) => void;
  recentReactions: string[];
  reactionEmojis: string[];
  onOpenMore: () => void;
  onReply: () => void;
  onCopy: () => void;
  onForward: () => void;
  onPin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopyLink: () => void;
  isSys: boolean;
  isTextLike: boolean;
  canPin: boolean;
  isPinned: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

const noop = () => {};

function GroupQuickReactModalImpl(props: GroupQuickReactModalProps) {
  const {
    msg, onClose, onReact, recentReactions, reactionEmojis,
    onOpenMore, onReply, onCopy, onForward, onPin, onEdit, onDelete, onCopyLink,
    isSys, isTextLike, canPin, isPinned, canEdit, canDelete,
  } = props;
  const visible = !!msg;
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <AppPressable style={styles.overlay} onPress={onClose}>
        <AppPressable style={[styles.picker, { backgroundColor: colors.surface }]} onPress={noop}>
          {mounted && msg ? (
            <>
              {!isSys && recentReactions.length > 0 ? (
                <>
                  <Text style={[styles.recentLabel, { color: colors.textMuted }]}>Недавние</Text>
                  <View style={styles.pickerRow}>
                    {recentReactions.map((e) => (
                      <AppPressable key={`r_${e}`} style={styles.pickerBtn} onPress={() => onReact(e)}>
                        <Text style={styles.emoji}>{e}</Text>
                      </AppPressable>
                    ))}
                  </View>
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                </>
              ) : null}
              {!isSys ? (
                <View style={styles.pickerRow}>
                  {reactionEmojis.map((e) => (
                    <AppPressable key={e} style={styles.pickerBtn} onPress={() => onReact(e)}>
                      <Text style={styles.emoji}>{e}</Text>
                    </AppPressable>
                  ))}
                  <AppPressable style={styles.pickerBtn} onPress={onOpenMore}>
                    <View style={[styles.moreBtn, { borderColor: colors.border, backgroundColor: colors.surfaceHigh }]}>
                      <Ionicons name="add" size={20} color={colors.text} />
                    </View>
                  </AppPressable>
                </View>
              ) : null}
              {isSys ? <View style={styles.sysSpacer} /> : null}
              {!isSys ? (
                <AppPressable style={[styles.replyBtn, { borderTopColor: colors.border }]} onPress={onReply}>
                  <Ionicons name="return-down-back-outline" size={16} color={colors.text} style={styles.actionIcon} />
                  <Text style={[styles.actionLabel, { color: colors.text }]}>Ответить</Text>
                </AppPressable>
              ) : null}
              {isTextLike ? (
                <AppPressable style={[styles.replyBtn, { borderTopColor: colors.border }]} onPress={onCopy}>
                  <Ionicons name="copy-outline" size={16} color={colors.text} style={styles.actionIcon} />
                  <Text style={[styles.actionLabel, { color: colors.text }]}>{COPY_ACTION}</Text>
                </AppPressable>
              ) : null}
              {isTextLike ? (
                <AppPressable style={[styles.replyBtn, { borderTopColor: colors.border }]} onPress={onForward}>
                  <Ionicons name="arrow-redo-outline" size={16} color={colors.text} style={styles.actionIcon} />
                  <Text style={[styles.actionLabel, { color: colors.text }]}>Переслать</Text>
                </AppPressable>
              ) : null}
              {canPin ? (
                <AppPressable style={[styles.replyBtn, { borderTopColor: colors.border }]} onPress={onPin}>
                  <Ionicons name={isPinned ? 'pin' : 'pin-outline'} size={16} color={colors.text} style={styles.actionIcon} />
                  <Text style={[styles.actionLabel, { color: colors.text }]}>{isPinned ? 'Открепить' : 'Закрепить'}</Text>
                </AppPressable>
              ) : null}
              {canEdit ? (
                <AppPressable style={[styles.replyBtn, { borderTopColor: colors.border }]} onPress={onEdit}>
                  <Ionicons name="create-outline" size={16} color={colors.text} style={styles.actionIcon} />
                  <Text style={[styles.actionLabel, { color: colors.text }]}>Редактировать</Text>
                </AppPressable>
              ) : null}
              {canDelete ? (
                <AppPressable style={[styles.replyBtn, { borderTopColor: colors.border }]} onPress={onDelete}>
                  {/* v4.32.383: '#ff3b30' — заливочный красный Apple, а здесь
                      им пишут текст: 3.2:1 на белом фоне светлой темы. */}
                  <Ionicons name="trash-outline" size={16} color={colors.error} style={styles.actionIcon} />
                  <Text style={[styles.actionLabel, { color: colors.error }]}>Удалить</Text>
                </AppPressable>
              ) : null}
              <AppPressable style={[styles.replyBtn, { borderTopColor: colors.border }]} onPress={onCopyLink}>
                <Ionicons name="link-outline" size={16} color={colors.text} style={styles.actionIcon} />
                <Text style={[styles.actionLabel, { color: colors.text }]}>{COPY_LINK_ACTION}</Text>
              </AppPressable>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: scrim.modal },
  picker: { borderRadius: 16, paddingTop: 12, paddingHorizontal: 8, minWidth: 300 },
  recentLabel: { fontSize: 10, fontWeight: '600', paddingHorizontal: 8, paddingTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  pickerRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4, paddingBottom: 8 },
  pickerBtn: { padding: 10 },
  emoji: { fontSize: 26 },
  moreBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 8, marginBottom: 4 },
  sysSpacer: { paddingVertical: 4 },
  replyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  actionIcon: { marginRight: 6 },
  actionLabel: { fontSize: 14 },
});

export const GroupQuickReactModal = memo(GroupQuickReactModalImpl);
