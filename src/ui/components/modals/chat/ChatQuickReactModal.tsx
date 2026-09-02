import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { font, scrim } from '../../../theme';
import { COPY_ACTION, COPY_LINK_ACTION } from '../../../clipboardText';

export interface QuickReactTarget {
  id: string;
  text: string;
  direction: string;
  starred?: boolean;
}

export interface ChatQuickReactModalProps {
  target: QuickReactTarget | null;
  onClose: () => void;
  recentReactions: string[];
  reactionEmojis: string[];
  onPickReaction: (emoji: string) => void;
  onOpenMore: () => void;
  onReply: () => void;
  onCopy: () => void;
  onForward: () => void;
  onEdit: () => void;
  onToggleStar: () => void;
  onMarkUnread: () => void;
  onShowInfo: () => void;
  onRemind: () => void;
  onDelete: () => void;
  /**
   * v4.32.252: пункты, которые до этого были только в iOS-меню. На Android они
   * не существовали вовсе — длинное нажатие открывает эту модалку.
   */
  onTranslate: () => void;
  onCopyLink: () => void;
  onTogglePin: () => void;
  /** true — сообщение уже закреплено (меняет подпись пункта). */
  pinned?: boolean;
  onSelect: () => void;
  /** Показывать «Завершить опрос»: своя строка-опрос, ещё открытая. */
  canClosePoll?: boolean;
  onClosePoll?: () => void;
}

const noop = () => {};

function ChatQuickReactModalImpl(props: ChatQuickReactModalProps) {
  const {
    target, onClose, recentReactions, reactionEmojis,
    onPickReaction, onOpenMore, onReply, onCopy, onForward, onEdit,
    onToggleStar, onMarkUnread, onShowInfo, onRemind, onDelete,
    onTranslate, onCopyLink, onTogglePin, pinned, onSelect,
    canClosePoll, onClosePoll,
  } = props;
  const visible = !!target;
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();

  const isMedia = !!target && target.text.startsWith('\x01');
  const isOut = target?.direction === 'out';
  const starred = !!target?.starred;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <AppPressable
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          onPress={noop}
        >
          {mounted && target ? (
            <>
              {!isMedia ? (
                <>
                  {recentReactions.length > 0 ? (
                    <>
                      <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>Недавние</Text>
                      <View style={styles.emojiRow}>
                        {recentReactions.slice(0, 8).map((e) => (
                          <EmojiTile key={`r_${e}`} emoji={e} onPress={onPickReaction} />
                        ))}
                      </View>
                      <View style={[styles.divider, { backgroundColor: colors.border }]} />
                    </>
                  ) : null}
                  <View style={[styles.emojiRow, recentReactions.length > 0 ? styles.emojiRowTight : null]}>
                    {reactionEmojis.slice(0, 6).map((e) => (
                      <EmojiTile key={e} emoji={e} onPress={onPickReaction} />
                    ))}
                    <AppPressable style={styles.emojiBtn} onPress={onOpenMore}>
                      <View style={[styles.moreBtn, { borderColor: colors.border, backgroundColor: colors.surfaceHigh }]}>
                        <Ionicons name="add" size={20} color={colors.text} />
                      </View>
                    </AppPressable>
                  </View>
                  <View style={[styles.dividerTop, { backgroundColor: colors.border }]} />
                </>
              ) : null}
              <View style={styles.actions}>
                <ActionRow icon="return-down-back-outline" label="Ответить" onPress={onReply} textColor={colors.text} borderColor={colors.border} />
                {!isMedia ? (
                  <ActionRow icon="copy-outline" label={COPY_ACTION} onPress={onCopy} textColor={colors.text} borderColor={colors.border} />
                ) : null}
                {!isMedia ? (
                  <ActionRow icon="arrow-redo-outline" label="Переслать" onPress={onForward} textColor={colors.text} borderColor={colors.border} />
                ) : null}
                {isOut && !isMedia ? (
                  <ActionRow icon="pencil-outline" label="Редактировать" onPress={onEdit} textColor={colors.text} borderColor={colors.border} />
                ) : null}
                {!isMedia ? (
                  <ActionRow icon="language-outline" label="Перевести" onPress={onTranslate} textColor={colors.text} borderColor={colors.border} />
                ) : null}
                <ActionRow icon="link-outline" label={COPY_LINK_ACTION} onPress={onCopyLink} textColor={colors.text} borderColor={colors.border} />
                <ActionRow
                  icon={pinned ? 'pin' : 'pin-outline'}
                  label={pinned ? 'Открепить' : 'Закрепить'}
                  onPress={onTogglePin}
                  textColor={colors.text}
                  borderColor={colors.border}
                />
                <ActionRow
                  icon={starred ? 'star' : 'star-outline'}
                  iconColor={starred ? colors.star : colors.text}
                  label={starred ? 'Убрать из избранного' : 'В избранное'}
                  onPress={onToggleStar}
                  textColor={colors.text}
                  borderColor={colors.border}
                />
                {!isOut ? (
                  <ActionRow icon="mail-unread-outline" label="Отметить непрочитанным" onPress={onMarkUnread} textColor={colors.text} borderColor={colors.border} />
                ) : null}
                <ActionRow icon="information-circle-outline" label="Сведения" onPress={onShowInfo} textColor={colors.text} borderColor={colors.border} />
                <ActionRow icon="alarm-outline" label="Напомнить" onPress={onRemind} textColor={colors.text} borderColor={colors.border} />
                <ActionRow icon="checkmark-circle-outline" label="Выбрать" onPress={onSelect} textColor={colors.text} borderColor={colors.border} />
                {canClosePoll && onClosePoll ? (
                  <ActionRow icon="stop-circle-outline" label="Завершить опрос" onPress={onClosePoll} textColor={colors.text} borderColor={colors.border} />
                ) : null}
                <ActionRow icon="trash-outline" label="Удалить" onPress={onDelete} textColor={colors.error} iconColor={colors.error} noBorder />
              </View>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

interface EmojiTileProps { emoji: string; onPress: (emoji: string) => void }
function EmojiTileImpl({ emoji, onPress }: EmojiTileProps) {
  const handlePress = useCallback(() => onPress(emoji), [onPress, emoji]);
  return (
    <AppPressable style={styles.emojiBtn} onPress={handlePress}>
      <Text style={styles.emojiText}>{emoji}</Text>
    </AppPressable>
  );
}
const EmojiTile = memo(EmojiTileImpl);

interface ActionRowProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor?: string;
  label: string;
  onPress: () => void;
  textColor: string;
  borderColor?: string;
  noBorder?: boolean;
}
function ActionRowImpl({ icon, iconColor, label, onPress, textColor, borderColor, noBorder }: ActionRowProps) {
  return (
    <AppPressable
      style={[styles.action, !noBorder && borderColor ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: borderColor } : null]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={18} color={iconColor ?? textColor} style={styles.actionIcon} />
      <Text style={[styles.actionLabel, { color: textColor }]}>{label}</Text>
    </AppPressable>
  );
}
const ActionRow = memo(ActionRowImpl);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: scrim.modal, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20 },
  sectionLabel: { fontSize: font.xs, fontWeight: '600', paddingHorizontal: 12, paddingTop: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingTop: 12 },
  emojiRowTight: { paddingTop: 0 },
  emojiBtn: { padding: 6, marginHorizontal: 4 },
  emojiText: { fontSize: 28 },
  moreBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 12, marginVertical: 6 },
  dividerTop: { height: StyleSheet.hairlineWidth, marginHorizontal: 12, marginTop: 6, marginBottom: 4 },
  actions: { paddingHorizontal: 4 },
  action: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12 },
  actionIcon: { marginRight: 10 },
  actionLabel: { fontSize: 15 },
});

export const ChatQuickReactModal = memo(ChatQuickReactModalImpl);
