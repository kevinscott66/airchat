import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { font, scrim, spacing } from '../../../theme';
import { COPY_ACTION, COPY_LINK_ACTION } from '../../../clipboardText';
import { messageMenu, type MessageMenuAction } from './messageMenuModel';

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
  /**
   * v4.32.569: «Копировать» и «Переслать» скрыты — по этой переписке включён
   * запрет на копирование и пересылку (core/social/copyGuard). Пункты именно
   * убираются, а не отключаются: серая строка обещала бы, что где-то их можно
   * включить.
   */
  copyBlocked?: boolean;
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

/** Размер эмодзи в ряду реакций: он тут не текст, а мишень для пальца. */
const EMOJI_SIZE = 28;

function ChatQuickReactModalImpl(props: ChatQuickReactModalProps) {
  const {
    target, onClose, recentReactions, reactionEmojis,
    onPickReaction, onOpenMore, onReply, onCopy, copyBlocked, onForward, onEdit,
    onToggleStar, onMarkUnread, onShowInfo, onRemind, onDelete,
    onTranslate, onCopyLink, onTogglePin, pinned, onSelect,
    canClosePoll, onClosePoll,
  } = props;
  const visible = !!target;
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);

  // Каждое новое сообщение открывается со свёрнутым «Ещё»: развёрнутое от
  // прошлого раза — это то же самое длинное полотно, от которого уходим.
  useEffect(() => { if (!visible) setExpanded(false); }, [visible]);

  const isMedia = !!target && target.text.startsWith('\x01');
  const isOut = target?.direction === 'out';
  const starred = !!target?.starred;

  const menu = useMemo(() => messageMenu({
    isOut: !!isOut,
    isMedia,
    copyBlocked: !!copyBlocked,
    canClosePoll: !!canClosePoll && !!onClosePoll,
  }), [isOut, isMedia, copyBlocked, canClosePoll, onClosePoll]);

  /** Значок, подпись и обработчик каждого пункта. */
  const spec = useMemo((): Record<MessageMenuAction, ActionSpec> => ({
    reply: { icon: 'return-down-back-outline', label: 'Ответить', onPress: onReply },
    copy: { icon: 'copy-outline', label: COPY_ACTION, onPress: onCopy },
    forward: { icon: 'arrow-redo-outline', label: 'Переслать', onPress: onForward },
    edit: { icon: 'pencil-outline', label: 'Редактировать', onPress: onEdit },
    pin: { icon: pinned ? 'pin' : 'pin-outline', label: pinned ? 'Открепить' : 'Закрепить', onPress: onTogglePin },
    delete: { icon: 'trash-outline', label: 'Удалить', onPress: onDelete, destructive: true },
    translate: { icon: 'language-outline', label: 'Перевести', onPress: onTranslate },
    copyLink: { icon: 'link-outline', label: COPY_LINK_ACTION, onPress: onCopyLink },
    star: {
      icon: starred ? 'star' : 'star-outline',
      iconColor: starred ? colors.star : undefined,
      label: starred ? 'Убрать из избранного' : 'В избранное',
      onPress: onToggleStar,
    },
    remind: { icon: 'alarm-outline', label: 'Напомнить', onPress: onRemind },
    info: { icon: 'information-circle-outline', label: 'Сведения', onPress: onShowInfo },
    markUnread: { icon: 'mail-unread-outline', label: 'Отметить непрочитанным', onPress: onMarkUnread },
    select: { icon: 'checkmark-circle-outline', label: 'Выбрать', onPress: onSelect },
    closePoll: { icon: 'stop-circle-outline', label: 'Завершить опрос', onPress: onClosePoll ?? noop },
  }), [
    onReply, onCopy, onForward, onEdit, onTogglePin, pinned, onDelete, onTranslate,
    onCopyLink, onToggleStar, starred, colors.star, onRemind, onShowInfo,
    onMarkUnread, onSelect, onClosePoll,
  ]);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  const row = (id: MessageMenuAction) => {
    const a = spec[id];
    return (
      <ActionRow
        key={id}
        icon={a.icon}
        iconColor={a.destructive ? colors.error : a.iconColor ?? colors.text}
        label={a.label}
        onPress={a.onPress}
        textColor={a.destructive ? colors.error : colors.text}
      />
    );
  };

  const visibleActions = menu.primary.filter((a) => a !== 'delete');
  const hasDelete = menu.primary.includes('delete');

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
                        <Ionicons name="add" size={font.xl} color={colors.text} />
                      </View>
                    </AppPressable>
                  </View>
                  <View style={[styles.dividerTop, { backgroundColor: colors.border }]} />
                </>
              ) : null}
              <ScrollView style={styles.scroll} keyboardShouldPersistTaps="always">
                <View style={styles.actions}>
                  {visibleActions.map(row)}
                  {menu.more.length > 0 ? (
                    <>
                      <AppPressable
                        style={styles.action}
                        onPress={toggleExpanded}
                        accessibilityState={{ expanded }}
                      >
                        <Ionicons
                          name={expanded ? 'chevron-up' : 'ellipsis-horizontal'}
                          size={font.lg}
                          color={colors.textSecondary}
                          style={styles.actionIcon}
                        />
                        <Text style={[styles.actionLabel, { color: colors.textSecondary }]}>
                          {expanded ? 'Свернуть' : 'Ещё'}
                        </Text>
                      </AppPressable>
                      {expanded ? menu.more.map(row) : null}
                    </>
                  ) : null}
                  {hasDelete ? (
                    <>
                      <View style={[styles.dividerTop, { backgroundColor: colors.border }]} />
                      {row('delete')}
                    </>
                  ) : null}
                </View>
              </ScrollView>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

interface ActionSpec {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor?: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
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
}
function ActionRowImpl({ icon, iconColor, label, onPress, textColor }: ActionRowProps) {
  return (
    <AppPressable style={styles.action} onPress={onPress}>
      <Ionicons name={icon} size={font.lg} color={iconColor ?? textColor} style={styles.actionIcon} />
      <Text style={[styles.actionLabel, { color: textColor }]}>{label}</Text>
    </AppPressable>
  );
}
const ActionRow = memo(ActionRowImpl);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: scrim.modal, justifyContent: 'flex-end' },
  // Полотно списка ограничено по высоте: с развёрнутым «Ещё» оно прокручивается,
  // а не упирается в верх экрана.
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20, maxHeight: '82%' },
  scroll: { flexGrow: 0 },
  sectionLabel: { fontSize: font.xs, fontWeight: '600', paddingHorizontal: spacing.md, paddingTop: spacing.md, textTransform: 'uppercase', letterSpacing: 0.5 },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.sm, paddingTop: spacing.md },
  emojiRowTight: { paddingTop: 0 },
  emojiBtn: { padding: 6, marginHorizontal: spacing.xs },
  emojiText: { fontSize: EMOJI_SIZE },
  moreBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: spacing.md, marginVertical: 6 },
  dividerTop: { height: StyleSheet.hairlineWidth, marginHorizontal: spacing.md, marginTop: 6, marginBottom: spacing.xs },
  actions: { paddingHorizontal: spacing.xs },
  action: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  actionIcon: { marginRight: 10 },
  actionLabel: { fontSize: font.md },
});

export const ChatQuickReactModal = memo(ChatQuickReactModalImpl);
