/**
 * GroupsScreen — список групп и каналов + экраны создания, участников и чата группы.
 * Структура:
 *   GroupsScreen: список всех групп текущего профиля
 *   GroupChatScreen: лента сообщений группы (аналог ChatThreadView для личных чатов)
 *   CreateGroupModal: форма создания группы / канала
 *   GroupMembersScreen: список участников с ролями
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  Alert,
  ActionSheetIOS,
  Platform,
  ActivityIndicator,
  ScrollView,
  Share,
  Image,
  Clipboard,
  PanResponder,
  Animated as RNAnimated,
  Vibration,
} from 'react-native';
import { promptMessageReminder } from '../utils/messageReminder';
import { AppPressable } from '../components/AppPressable';
import { KeyboardHost } from '../components/KeyboardHost';
import { showPermissionDeniedAlert } from '../permissionAlert';
// v4.32.27: AppModal = Modal + GestureHandlerRootView inside.
import { MediaPreviewModal } from '../components/MediaPreviewModal';
import { AttachSheet } from '../components/AttachSheet';
import { useTabRef } from '../TabRefContext';
import { useBackHandler } from '../../core/hooks/useBackHandler';
import { MAX_MESSAGE_TEXT } from '../../core/social/messageTextLimit';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { v4 as uuidv4 } from 'uuid';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { profileManager } from '../../core/identity/profileManager';
import { getOwnDisplayName } from '../../core/identity/ownProfile';
import { nameInitial } from '../../core/social/contactLabel';
import { outwardName, shownName, shownNameOrNull } from '../../core/social/unreadableName';
import {
  listGroups,
  getGroup,
  getGroupRead,
  listGroupMessages,
  listAllGroupMessages,
  listGroupMembers,
  insertGroupMessage,
  touchGroupConversation,
  markGroupRead,
  markGroupUnread,
  markAllGroupsRead,
  setGroupPinned,
  setGroupMuted,
  setGroupMutedUntil,

  setGroupSlowMode,
  setGroupArchived,
  listArchivedGroups,
  deleteGroup,
  upsertGroupMember,
  removeGroupMember,
  recountGroupMembers,
  updateGroupMemberRole,
  updateGroupMeta,
  updateGroupMessageText,
  deleteGroupMessage,
  clearGroupMessages,
  searchGroupMessages,
  makePollText,
  listGroupJoinRequests,
  updateGroupJoinRequestStatus,
  countPendingJoinRequests,
  type GroupJoinRequest,
  POLL_PREFIX,
  type GroupRow,
  type GroupMessageRow,
  type GroupMemberRow,
  subscribeChatWrites,
  setGroupMessageStarred,
  setGroupDraft,
  setGroupDisappearTimer,
  purgeDisappearedMessages,
  listStarredMessages,
  listGroupScheduledMessages,
  deleteScheduledMessage,
  getGroupStats,
  type StarredMessageEntry,
  type ScheduledMessage,
  type GroupStats,
  searchAllGroupMessages,
  type GroupMessageSearchResult,
  recentlyDeletedGroupKey,
} from '../../core/storage/local';
// v4.32.168: зеркалим group/channel mute в muteStore (FCM gate).
import { setMuted as muteSet, unmute as muteUnset, type MuteKind } from '../../core/notifications/muteStore';
import { decidePage, shouldApplyRows } from '../../core/storage/readResult';
import { atCreatedAt, hasMoreAfterRefresh, mergeListHead } from '../../core/storage/listHeadMerge';
import { setActiveGroupId } from '../../notifications/pushNotifications';
import { isUnreadableMessage, mayReuseMessageText, UNREADABLE_DESCRIPTION_TEXT, UNREADABLE_DRAFT_TEXT, UNREADABLE_MEDIA_TEXT, UNREADABLE_MESSAGE_TEXT, UNREADABLE_QUOTE_TEXT, UNREADABLE_REACTIONS_TEXT } from '../../core/storage/unreadableText';
import { quoteView } from '../../core/social/replyQuote';
import { decideDraftWrite, draftIsUnreadable, hasReadableDraft, unreadableAfterWrite } from '../../core/social/draftGuard';
import { searchSkippedBadge, searchSkippedNotice, type SearchScan } from '../../core/storage/searchScan';
import { decideOwnDescriptionWrite } from '../../core/social/groupMetaEvents';
import { SafeScreen } from '../components/SafeScreen';
import { showError, showSuccess } from '../components/userFeedback';
import { announceGroupSend } from '../groupSendAnnounce';
import { groupControlProblem } from '../../core/social/groupControlOutcome';
import { announceCtl, announceInviteToken } from '../groupControlAnnounce';
import { useTheme } from '../ThemeContext';
import { badgeTint, contrastingInk, identityAvatar, identityInk, inkOn, nestedFill, primaryInk, rippleOn, rowMark, scrim, searchMark } from '../theme';
import { feedGround, type Wallpaper } from '../wallpapers';
import { isVoiceMessage, parseVoiceMeta, makeVoiceText, ForwardModal, isContactCard, parseContactCard, ScheduleModal, WallpaperPickerModal, makeContactCardText, extractFirstUrl, LinkPreview, isForwardedMessage, makeForwardText, makeForwardBundleText, parseForwardedMessage, isDocMessage, makeDocText, isLocationMessage, parseLocationMeta, makeLocationText, reverseGeocodeLabel, makeViewOnceText, SendEffectOverlay, detectSendEffect, EmojiPanel } from './ChatScreen';
import { GifPickerModal, isGifMessage, parseGifUrl, GifBubble, isGifSearchAvailable } from '../components/GifPicker';
import {
  buildTranslateUrl,
  parseTranslation,
  translateBlockMessage,
  translateBlockReason,
  translateFailureMessage,
} from '../../core/social/cloudTranslate';
import { CLOUD_TRANSLATE_OFF_MESSAGE, cloudTranslateAllowed } from '../../core/social/translateConsent';
import { chatAutoTranslateKey, chatBgKey, chatFontSizeKey, groupConvId, groupLastSentKey, RECENT_REACTIONS_KEY, TRANSLATION_TARGET_LANG_KEY } from '../../core/storage/kvKeys';
import { scopedKvGet, scopedKvSet } from '../../core/storage/profileScopedKv';
import { AnimatedDots } from '../components/AnimatedDots';
// v4.32.227 (BUG-09): тёмный прокручиваемый action-sheet — замена Alert-меню,
// которые на Android обрезаются до 3 кнопок и становятся неотменяемыми.
import { ActionSheet, type ActionSheetState } from '../components/ActionSheet';
import { useMediaViewer } from '../components/MediaViewer';
import { isLiveLocMessage } from '../../core/social/liveLocationService';
import { readPlaceOnce } from '../../core/social/deviceLocation';
import { locationFailureText } from '../../core/social/locationFailure';
import { VoiceRecorderButton, VoicePlayer, type VoiceRecordingResult } from '../components/VoiceMessage';
import { fanoutGroupMessage, sendGroupReadReceipt, fanoutGroupControl, sendGroupInvite, sendGroupControlTo, ensureGroupInviteToken, rotateGroupInviteToken } from '../../core/social/groupMessaging';
import { formatDisappearLabel } from '../../core/social/disappearEnvelope';
import { CHAT_MAX_IMAGES, mergePickedImages, remainingImageSlots } from '../../core/social/mediaAttachPolicy';
import { previewLabelForText, truncateReplyPreview } from '../../core/social/messagePreview';
import { toggleAndSyncReaction } from '../../core/social/reactionSync';
import { closeAndSyncPoll } from '../../core/social/pollVoteSync';
import { resolvePinned, togglePinAndSync, groupPinRefusalText, clearPinned, applyLocalPin, type PinnedEntry } from '../../core/social/groupPinSync';
import { canPinInGroup, type PinRole } from '../../core/social/groupPinPolicy';
import { buildGroupInviteLink } from '../../core/social/groupInviteLink';
import { OWN_GROUP_DESC_MAX, OWN_GROUP_NAME_MAX, normalizeOwnGroupDescription, normalizeOwnGroupName } from '../../core/social/groupNameRule';
import { canSendToGroup, slowModeRemaining, slowModeSysLine, formatSlowMode, MAX_SLOWMODE_SECONDS, type SendRole } from '../../core/social/groupSendPolicy';
import { isAdminRole, ownGroupRole } from '../../core/social/ownGroupRole';
import { createTimerScope, type TimerScope } from '../../core/lifecycle/timerScope';
import { hitLabel, stepHitIndex } from '../../core/social/searchCursor';
import { parseReactionMap } from '../../core/social/reactionMapPolicy';
import { searchReactionChip, UNREADABLE_REACTION_MARK } from '../../core/social/searchReactionChip';
import { exportBody } from '../../core/social/exportLine';
import { mentionSkippedNotice, mentionableMembers, memberSkippedNotice, searchMembersByName, type MemberSearch } from '../../core/social/memberSearch';
import { voicePlaybackUri } from '../../core/social/voiceUriPolicy';
import { useResolvedMediaUrl } from './chat-components/useResolvedMediaUrls';
import { GroupPhotoGrid } from './chat-components/GroupPhotoGrid';
import { DocBubble } from './chat-components/DocBubble';
import { LiveLocationBubble } from './chat-components/LiveLocationBubble';
import { ContactCardBubble } from './chat-components/ContactCardBubble';
import { serializeMediaCids } from '../../core/media/mediaCidPolicy';
import { resolveMediaCidsToUris } from '../../core/media/resolveMediaCids';
import { guessImageMime, MAX_BLOB_BYTES } from '../../core/media/blobRef';
import { deleteCachedFileUris, uploadEncryptedBlob } from '../../core/media/mediaBlob';
import { fileSizeBytes } from '../../core/media/fileSize';
import { voiceUploadRefusal } from '../components/voiceLimit';
import { getPresenceState } from '../../core/social/presenceService';
import { scheduleGroupMessage } from '../../core/social/scheduledMessages';
import { getMessagingService } from '../../core/social/messaging';
import { CreateGroupModal } from '../components/modals/groups/GroupCreateModal';
import { PollCreatorModal } from '../components/modals/groups/GroupPollCreatorModal';
import { GroupReactionDetailModal } from '../components/modals/groups/GroupReactionDetailModal';
import { GrpMessageInfoModal } from '../components/modals/groups/GroupMessageInfoModal';
import { GroupSharedMediaModal } from '../components/modals/groups/GroupSharedMediaModal';
import { GroupQrModal } from '../components/modals/groups/GroupQrModal';
import { GroupSeenByModal } from '../components/modals/groups/GroupSeenByModal';
import { GroupPinnedListModal } from '../components/modals/groups/GroupPinnedListModal';
import { GroupStarredModal } from '../components/modals/groups/GroupStarredModal';
import { GroupStatsModal } from '../components/modals/groups/GroupStatsModal';
import { GroupRecentlyDeletedModal, type GroupRecentlyDeletedEntry } from '../components/modals/groups/GroupRecentlyDeletedModal';
import { GroupQuickRepliesModal } from '../components/modals/groups/GroupQuickRepliesModal';
import { GroupReactionsMoreModal } from '../components/modals/groups/GroupReactionsMoreModal';
import { ScheduledListModal } from '../components/modals/shared/ScheduledListModal';
import { GroupAdminLogModal } from '../components/modals/groups/GroupAdminLogModal';
import { GroupJoinRequestsModal } from '../components/modals/groups/GroupJoinRequestsModal';
import { GroupMemberSheetModal } from '../components/modals/groups/GroupMemberSheetModal';
import { GroupQuickReactModal } from '../components/modals/groups/GroupQuickReactModal';
import {
  type GrpDateSepItem,
  type GrpUnreadSepItem,
  type GrpListItem,
  injectGrpDateSeparators,
} from './groups-utils/dates';
import { muteRemainingLabel } from '../time/durationLabel';
import { formatListTime as formatTime, formatSearchTime } from '../time/listTime';
import { highlightSegments } from './groups-utils/highlight';
import { isGrpBigEmoji } from './groups-utils/emoji';
import {
  groupFlagCopy,
  groupFlagNext,
  groupFlagPatch,
  type GroupFlagKey,
} from './groups-utils/groupFlagToggle';
import { GrpMessageBlock } from './groups-components/text/GrpMessageBlock';
import { GrpCollapsibleBlock } from './groups-components/text/GrpCollapsibleBlock';
import { GroupAvatar } from './groups-components/GroupAvatar';
import { GrpSenderAvatar } from './groups-components/GrpSenderAvatar';
import { PollBubble } from './groups-components/PollBubble';

/**
 * Системные строки (вступил/вышел/исключён) хранятся с этим префиксом.
 * v4.32.258: определения переехали в core/social/groupSysLine — там же, где
 * живёт защита от подделки. Здесь остаётся реэкспорт: имена уже разошлись по
 * экранам и модалкам.
 */
import {
  GROUP_SYS_PREFIX,
  isGroupSysMessage,
  makeGroupSysText,
  parseGroupSysText,
} from '../../core/social/groupSysLine';
import { insertGroupSysMessage } from '../utils/groupSysMessage';
export { GROUP_SYS_PREFIX, isGroupSysMessage, makeGroupSysText, parseGroupSysText };

/**
 * Значения таймера исчезающих сообщений — те же, что в личных чатах.
 * «Выкл» — это 0, а не null: null означает «человек не выбирал», и туда
 * подставляется значение по умолчанию из настроек.
 */
const DISAPPEAR_OPTIONS = [
  { text: 'Выкл', ms: 0 },
  { text: '1 мин', ms: 60_000 },
  { text: '1 час', ms: 3_600_000 },
  { text: '1 день', ms: 86_400_000 },
  { text: '1 неделя', ms: 7 * 86_400_000 },
] as const;

/**
 * Сколько удалённое сообщение группы лежит в корзине. Срок должен совпадать у
 * того, кто кладёт, и у того, кто показывает: разъехавшись, они дали бы
 * «недавно удалённые», которые ничего не показывают, но продолжают хранить.
 */
const GRP_RECENTLY_DELETED_TTL_MS = 7 * 86_400_000;

// v4.32.227 (BUG-11): корректная русская плюрализация. Раньше всегда выводилось
// «N участников» → «1 участников». Единый источник правды теперь в
// ../utils/plural; реэкспортируем здесь для обратной совместимости.
import { ruPlural, membersLabel, subscribersLabel } from '../utils/plural';
import { ambiguityMessage, memberLabel, resolveMember } from '../utils/memberLookup';
import { isMentionOf } from '../../core/social/mentions';
import { canModerate } from '../../core/social/groupModerationPolicy';
import { openMapAt } from '../utils/openExternal';
import { roleChangeNoopText, roleChangeSysText, roleLabel, roleTone, sortMembersByRole, type AssignableRole } from '../../core/social/groupRolePolicy';
import { createEditCommitGate } from '../../core/utils/editCommitGate';
import { createCoalescedTask } from '../../core/utils/coalescedTask';
import { runViewOnceTap, VIEW_ONCE_DELETE_DELAY_MS } from './chat-utils/viewOnceTap';
import { shareTextExport } from '../../core/media/cacheFiles';
import { getEmojiSuggestions } from './chat-utils/emoji';
import { BubbleKindProvider } from '../BubbleKindContext';
import { shortIdentity } from '../identity/shortId';
import { fullDateTime } from '../../core/time/ruDateTime';
import { log } from '../../core/logger';
import { rawErrorText, userErrorText } from '../components/userErrorText';
import { runGuardedOp } from '../components/runGuardedOp';
import {
  firstFound,
  fromNullable,
  isTrulyMissing,
  lookupValue,
} from '../../core/utils/lookupResult';
import { COPY_ACTION, COPY_LINK_ACTION, COPIED_TEXT, COPIED_LINK } from '../clipboardText';
export { ruPlural, membersLabel, subscribersLabel };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GroupRow component
// ─────────────────────────────────────────────────────────────────────────────

function GroupListRow({
  item,
  onPress,
  onLongPress,
  gateway,
  onSwipeArchive,
  onSwipeRead,
  myPubB64,
}: {
  item: GroupRow;
  onPress: () => void;
  onLongPress: () => void;
  gateway?: string;
  onSwipeArchive?: () => void;
  onSwipeRead?: () => void;
  myPubB64?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  const avatarUri = useResolvedMediaUrl(item.avatarCid, gateway ?? '');
  /**
   * v4.32.580: подпись последней реплики не открылась ключом данных. «Нет
   * сообщений» здесь было прямой неправдой: сообщения есть, их не прочитать.
   */
  const previewUnreadable = !item.draftText && item.lastMessagePreviewUnreadable === true;
  const previewText = item.lastMessagePreview
    ? previewLabelForText(item.lastMessagePreview)
    : previewUnreadable
      ? UNREADABLE_MESSAGE_TEXT
      : (item.type === 'channel' ? 'Нет постов' : 'Нет сообщений');
  const isOutgoingLast = !!(myPubB64 && item.lastMessageSenderPub && item.lastMessageSenderPub === myPubB64);
  /**
   * v4.32.602: подпись автора не открылась ключом данных. Пустая строка вела
   * себя как «подписи нет» — а это законный случай, и строка рисовалась без
   * приставки: реплика соседа теряла автора молча.
   */
  const senderLabel = isOutgoingLast
    ? 'Вы'
    : shownNameOrNull(item.lastMessageSenderName, item.lastMessageSenderNameUnreadable);
  /**
   * v4.32.583: черновик группы не открылся ключом данных. Молчать о нём
   * нельзя — иначе строка обещает, что писать было нечего. См. draftGuard.
   */
  const draftUnreadable = draftIsUnreadable(item.draftUnreadable);
  const preview = item.draftText
    ? item.draftText
    : draftUnreadable
      ? UNREADABLE_DRAFT_TEXT
      : (item.lastMessagePreview && senderLabel
        ? `${senderLabel}: ${previewText}`
        : previewText);
  const showDraftLabel = !!item.draftText;
  const swipeAnim = useRef(new RNAnimated.Value(0)).current;
  const swipedRef = useRef(false);
  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.8,
    onPanResponderMove: (_, g) => {
      if (swipedRef.current) return;
      swipeAnim.setValue(Math.max(-100, Math.min(80, g.dx)));
    },
    onPanResponderRelease: (_, g) => {
      if (swipedRef.current) return;
      if (g.dx > 55 && onSwipeArchive) {
        Vibration.vibrate(20); swipedRef.current = true;
        RNAnimated.timing(swipeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => { swipedRef.current = false; });
        onSwipeArchive();
      } else if (g.dx < -55 && onSwipeRead) {
        Vibration.vibrate(20); swipedRef.current = true;
        RNAnimated.timing(swipeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => { swipedRef.current = false; });
        onSwipeRead();
      } else {
        RNAnimated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
      }
    },
    onPanResponderTerminate: () => { RNAnimated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start(); },
  })).current;

  return (
    <RNAnimated.View style={{ transform: [{ translateX: swipeAnim }] }} {...panResponder.panHandlers}>
    <AppPressable
      style={({ pressed }) => [
        glStyles.row,
        { backgroundColor: pressed ? colors.surfaceHigh : colors.background },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
    >
      {avatarUri ? (
        <Image source={{ uri: avatarUri }} style={{ width: 48, height: 48, borderRadius: 24 }} />
      ) : (
        <GroupAvatar name={item.name} type={item.type} />
      )}
      <View style={glStyles.body}>
        <View style={glStyles.top}>
          <View style={glStyles.nameRow}>
            {item.pinned ? <Ionicons name="pin" size={13} color={colors.textMuted} style={{ marginRight: 3 }} /> : null}
            {item.type === 'channel' ? <Ionicons name="megaphone-outline" size={13} color={colors.textMuted} style={{ marginRight: 3 }} /> : null}
            <Text style={[glStyles.name, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
            {item.memberCount > 0 ? (
              <Text style={{ fontSize: 11, color: colors.textMuted, marginLeft: 6, flexShrink: 0 }}>
                {item.type === 'channel' ? `${item.memberCount} подп.` : `${item.memberCount} уч.`}
              </Text>
            ) : null}
          </View>
          <Text style={[glStyles.time, { color: colors.textMuted }]}>{formatTime(item.lastMessageAt)}</Text>
        </View>
        <View style={glStyles.bottom}>
          <Text
            style={[
              glStyles.preview,
              previewUnreadable || draftUnreadable ? { fontStyle: 'italic' as const } : null,
              { color: showDraftLabel ? colors.error : draftUnreadable ? colors.warning : previewUnreadable ? colors.textMuted : colors.textSecondary },
            ]}
            numberOfLines={1}
          >
            {showDraftLabel ? <Text style={{ color: colors.error, fontWeight: '600' }}>Черновик: </Text> : null}{preview}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {item.muted ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                <Ionicons name="notifications-off-outline" size={13} color={colors.textMuted} />
                {item.mutedUntil ? (
                  <Text style={{ fontSize: 10, color: colors.textMuted }}>{muteRemainingLabel(item.mutedUntil)}</Text>
                ) : null}
              </View>
            ) : null}
            {item.mentionCount > 0 ? (
              <View style={[glStyles.mentionBadge, { backgroundColor: colors.errorFill }]}>
                <Text style={[glStyles.badgeText, { color: contrastingInk(colors.errorFill) }]}>@</Text>
              </View>
            ) : null}
            {item.unreadCount > 0 ? (
              <View style={[glStyles.badge, { backgroundColor: item.muted ? colors.mutedFill : colors.primary }]}>
                <Text style={[glStyles.badgeText, { color: contrastingInk(item.muted ? colors.mutedFill : colors.primary) }]}>{item.unreadCount > 99 ? '99+' : String(item.unreadCount)}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </AppPressable>
    </RNAnimated.View>
  );
}

const glStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 12 },
  body: { flex: 1, gap: 3 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nameRow: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  name: { fontSize: 16, fontWeight: '600', flex: 1 },
  time: { fontSize: 12 },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  preview: { fontSize: 14, flex: 1 },
  // v4.32.394: заливка приходит с места вызова — см. ChatListScreen.
  badge: { borderRadius: 10, minWidth: 20, paddingHorizontal: 5, paddingVertical: 2, alignItems: 'center' },
  mentionBadge: { borderRadius: 10, minWidth: 20, paddingHorizontal: 5, paddingVertical: 2, alignItems: 'center' },
  // Цвет надписи здесь не задан намеренно: заливок у плашки три
  // (errorFill / mutedFill / primary, последняя — выбор пользователя), и
  // чернила считаются на месте вызова из той, что выпала (v4.32.398).
  badgeText: { fontSize: 11, fontWeight: '700' },
});



// ─────────────────────────────────────────────────────────────────────────────
// GroupChatScreen — лента сообщений группы
// ─────────────────────────────────────────────────────────────────────────────

function GroupChatScreen({
  group,
  pair,
  onBack,
  onOpenMembers,
  onOpenDm,
  initialSearchQuery,
}: {
  group: GroupRow;
  pair: KeyPairBytes;
  onBack: () => void;
  onOpenMembers: () => void;
  onOpenDm?: (peerPubB64: string, displayName: string) => void;
  initialSearchQuery?: string;
}): React.ReactElement {
  const { colors, fontSize: themeFontSize } = useTheme();
  // v4.32.409: «непрочитанные», «выделено», «закреплено» и своя реакция —
  // одна и та же плашка акцента, и во всех пяти местах она подмешивалась
  // прозрачностью прямо на месте вызова. Подложка считается от поверхности,
  // на которой лежит, чернила — от подложки (386, 395).
  const activeTint = useMemo(() => badgeTint(colors, 'accent', colors.background), [colors]);
  const activeInk = useMemo(() => inkOn(colors, activeTint.fill), [colors, activeTint.fill]);
  const inputTint = useMemo(() => badgeTint(colors, 'accent', colors.surface), [colors]);
  // v4.32.227 (BUG-09): state-driven action-sheet. Меню с >3 пунктами
  // (настройки группы/канала, действия с сообщением, вложенные подменю) на
  // Android идут через ActionSheet вместо Alert — иначе обрезается до 3 кнопок.
  const [actionSheet, setActionSheet] = useState<ActionSheetState>(null);
  // v4.32.227 (BUG-09): открыть меню через ActionSheet из Alert-подобного массива
  // кнопок. Хвостовая { text: 'Отмена', style: 'cancel' } отбрасывается — у листа
  // своя липкая «Отмена». Принимает (как Alert) элементы или null/false.
  type SheetBtn = { text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void } | null | undefined | false;
  const openSheet = useCallback((title: string, message: string, buttons: SheetBtn[]) => {
    const options = buttons
      .filter((b): b is { text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void } => !!b && b.style !== 'cancel')
      .map((b) => ({ label: b.text, onPress: () => b.onPress?.(), destructive: b.style === 'destructive' }));
    setActionSheet({ title, message: message || undefined, options });
  }, []);
  const [grpChatFontSize, setGrpChatFontSize] = useState<number | null>(null);
  const msgFontSize = grpChatFontSize ?? themeFontSize;
  const [messages, setMessages] = useState<GroupMessageRow[]>([]);
  // v4.32.532: пусто — не то же самое, что «не смогли прочитать». Без этого
  // флага сбой базы рисовался как «Нет сообщений».
  const [msgReadFailed, setMsgReadFailed] = useState(false);
  // v4.32.533: текущий список нужен обновлению, но брать его из зависимостей
  // нельзя — loadMessages пересобирался бы на каждое сообщение и перезапускал
  // подписанные на него эффекты.
  const messagesRef = useRef<GroupMessageRow[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [text, setText] = useState('');
  // Keep the native TextInput value available to send() before React commits
  // the render caused by the last typed word.
  const textRef = useRef('');
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const [sending, setSending] = useState(false);
  const [mentionJumpIdx, setMentionJumpIdx] = useState(0);
  const [replyTo, setReplyTo] = useState<GroupMessageRow | null>(null);
  const [quickReact, setQuickReact] = useState<GroupMessageRow | null>(null);
  const [selectedGrpIds, setSelectedGrpIds] = useState<Set<string>>(new Set());
  const isGrpSelecting = selectedGrpIds.size > 0;
  const [pollVisible, setPollVisible] = useState(false);
  const [mentionFilter, setMentionFilter] = useState<string | null>(null);
  const [hashtagFilter, setHashtagFilter] = useState<string | null>(null);
  const [cmdFilter, setCmdFilter] = useState<string | null>(null);
  const [allMembers, setAllMembers] = useState<GroupMemberRow[]>([]);
  const [searchVisible, setSearchVisible] = useState(() => !!initialSearchQuery);
  const [searchQuery, setSearchQuery] = useState(() => initialSearchQuery ?? '');
  const [searchResults, setSearchResults] = useState<GroupMessageRow[] | null>(null);
  /**
   * v4.32.581: сколько реплик поиск не смог прочитать. Счётчик «0» без
   * этого числа одинаково выглядел и при честном отсутствии совпадений, и
   * при истории, которую не открыл ключ данных.
   */
  const [searchScan, setSearchScan] = useState<SearchScan | null>(null);
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef<TextInput>(null);
  const [editingMsg, setEditingMsg] = useState<GroupMessageRow | null>(null);
  const [forwardText, setForwardText] = useState<string | null>(null);
  const [pinnedMsgId, setPinnedMsgId] = useState<string | null>(group.pinnedMessageId ?? null);
  const [pinnedMsgText, setPinnedMsgTextRaw] = useState<string | null>(group.pinnedMessageText ?? null);
  /**
   * v4.32.603: наследный текст закрепления не открылся ключом данных. Пустая
   * строка вела себя как «ничего не закреплено» — полоса не рисовалась вовсе, и
   * объявление группы исчезало вместе со способом его открепить.
   */
  const [pinnedMsgUnreadable, setPinnedMsgUnreadable] = useState<boolean>(
    group.pinnedMessageTextUnreadable === true
  );
  /**
   * Любое новое значение приходит уже из списка закреплений, у которого своя
   * пометка (PinnedEntry.unreadable, v4.32.576). Поэтому наследная гаснет здесь,
   * а не в семи местах по отдельности — забыть её в одном из них было бы легко.
   */
  const setPinnedMsgText = useCallback((next: string | null) => {
    setPinnedMsgTextRaw(next);
    setPinnedMsgUnreadable(false);
  }, []);
  const [grpPinnedList, setGrpPinnedList] = useState<PinnedEntry[]>([]);
  const [grpPinnedIdx, setGrpPinnedIdx] = useState(0);
  const [grpPinnedListVisible, setGrpPinnedListVisible] = useState(false);
  const [disappearMs, setDisappearMs] = useState<number | null>(group.disappearAfterMs ?? null);
  const [isGrpMuted, setIsGrpMuted] = useState<boolean>(group.muted ?? false);
  const [adminOnlyPosting, setAdminOnlyPosting] = useState<boolean>(group.adminOnlyPosting ?? false);
  const [requireApproval, setRequireApproval] = useState<boolean>(group.requireApproval ?? false);
  const [anonymousPosting, setAnonymousPosting] = useState<boolean>(group.anonymousPosting ?? false);
  const [adminOnlyPinning, setAdminOnlyPinning] = useState<boolean>(group.adminOnlyPinning ?? true);
  const [mediaGalleryVisible, setMediaGalleryVisible] = useState(false);
  const [starredVisible, setStarredVisible] = useState(false);
  const [starredEntries, setStarredEntries] = useState<StarredMessageEntry[]>([]);
  const [reactionDetailGrp, setReactionDetailGrp] = useState<{ activeEmoji: string; map: Record<string, string[]> } | null>(null);
  const [grpMsgInfoTarget, setGrpMsgInfoTarget] = useState<GroupMessageRow | null>(null);
  const [grpEmojiPanelVisible, setGrpEmojiPanelVisible] = useState(false);
  const [grpScheduleVisible, setGrpScheduleVisible] = useState(false);
  const [grpScheduledMsgs, setGrpScheduledMsgs] = useState<ScheduledMessage[]>([]);
  const [grpQuickRepliesVisible, setGrpQuickRepliesVisible] = useState(false);
  const [grpRecentReactions, setGrpRecentReactions] = useState<string[]>([]);
  const [grpReactMoreVisible, setGrpReactMoreVisible] = useState(false);
  const [grpScheduledListVisible, setGrpScheduledListVisible] = useState(false);
  const [sendEffectParticles, setSendEffectParticles] = useState<string[] | null>(null);
  const [grpRecentlyDeletedVisible, setGrpRecentlyDeletedVisible] = useState(false);
  const [grpRecentlyDeletedList, setGrpRecentlyDeletedList] = useState<Array<{ id: string; text: string; senderName: string; deletedAt: number }>>([]);
  const [grpWallpaper, setGrpWallpaper] = useState<Wallpaper | null>(null);
  // v4.32.410: плашки, лежащие на ленте, — от обоев, а не от палитры.
  const feed = useMemo(() => feedGround(colors, grpWallpaper), [colors, grpWallpaper]);
  const [wallpaperPickerVisible, setWallpaperPickerVisible] = useState(false);
  const [grpStatsVisible, setGrpStatsVisible] = useState(false);
  const [grpStats, setGrpStats] = useState<GroupStats | null>(null);
  const [gateway, setGateway] = useState('');
  // v4.32.246: аватар может быть зашифрованным вложением (`nb:`) — тогда его
  // нужно скачать и расшифровать, адрес шлюза для него не собирается.
  const headerAvatarUri = useResolvedMediaUrl(group.avatarCid, gateway);
  const [pendingGrpImageUris, setPendingGrpImageUris] = useState<string[]>([]);
  const [grpImageCaption, setGrpImageCaption] = useState('');
  const [grpImageViewOnce, setGrpImageViewOnce] = useState(false);
  const [grpGifPickerVisible, setGrpGifPickerVisible] = useState(false);
  // v4.32.60: AttachSheet (Telegram-style hub) заменяет Alert attach menu
  const [grpAttachSheetOpen, setGrpAttachSheetOpen] = useState(false);
  const [autoTranslate, setAutoTranslate] = useState(false);
  const [grpTranslateLang, setGrpTranslateLang] = useState('ru');
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({});
  const [grpManualTranslatedIds, setGrpManualTranslatedIds] = useState<Set<string>>(new Set());
  const grpMediaViewer = useMediaViewer();
  useEffect(() => {
    void import('../../core/config').then((m) => m.loadConfig()).then((c) => setGateway(c.ipfs.gatewayUrl.replace(/\/$/, '')));
  }, []);
  useEffect(() => {
    void (async () => {
      // Фон пишет WallpaperPickerModal — тем же именем разговора `grp_<id>`.
      // v4.32.487: своё у каждого аккаунта — в одной группе это два разных
      // участника.
      const raw = await scopedKvGet(chatBgKey(groupConvId(group.id)));
      if (raw) {
        // v4.32.410: разбор без проверки формы клал в состояние что угодно из
        // базы — строку, массив, null, — и экран потом брал у этого поле value.
        // Та же проверка, что в личной переписке с 190-го.
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const o = parsed as Record<string, unknown>;
            if ((o.type === 'color' || o.type === 'image') && typeof o.value === 'string') {
              setGrpWallpaper({ type: o.type, value: o.value });
            }
          }
        } catch { /* ignore */ }
      }
    })();
  }, [group.id]);
  // Load auto-translate setting for this group
  useEffect(() => {
    void scopedKvGet(chatAutoTranslateKey(groupConvId(group.id))).then((raw) => {
      if (raw === '1') setAutoTranslate(true);
    });
  }, [group.id]);
  // Load per-group font size override
  useEffect(() => {
    void scopedKvGet(chatFontSizeKey(groupConvId(group.id))).then((raw) => {
      if (raw) { const n = parseInt(raw, 10); if (!isNaN(n) && n > 0) setGrpChatFontSize(n); }
    });
  }, [group.id]);
  // Load translation target language
  useEffect(() => {
    void scopedKvGet(TRANSLATION_TARGET_LANG_KEY).then((lang) => { if (lang) setGrpTranslateLang(lang); });
  }, []);
  // Load recently used reactions
  useEffect(() => {
    void scopedKvGet(RECENT_REACTIONS_KEY).then((raw) => {
      if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) setGrpRecentReactions(p as string[]); } catch { /* */ } }
    });
  }, []);
  const [typingMembers, setTypingMembers] = useState<Map<string, string>>(new Map());
  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groupFlashRef = useRef<any>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const showScrollBottomRef = useRef(false);
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const jumpHighlightAnim = useRef(new RNAnimated.Value(0)).current;
  /** ID of the message just sent this session — shows single ✓ until next reload. */
  const lastSentMsgIdRef = useRef<string | null>(null);
  /** "Seen by" modal: shows who has read a specific outgoing message */
  const [seenByMsg, setSeenByMsg] = useState<GroupMessageRow | null>(null);
  const myPubB64 = useMemo(() => Buffer.from(pair.publicKey).toString('base64'), [pair]);
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  // Load group pinned list
  // v4.32.233: текст больше не хранится копией в kv — читается из
  // group_messages, поэтому остаётся актуальным после правки сообщения.
  useEffect(() => {
    void (async () => {
      let list = await resolvePinned(group.id, pid);
      // Закрепления до 4.32.233 лежали только в groups.pinned_message_id и в kv
      // не попадали. Переносим один раз, иначе баннер пропал бы при первом же
      // обновлении списка.
      if (!list.length && group.pinnedMessageId) {
        list = await applyLocalPin({ groupId: group.id, ownerProfileId: pid, msgId: group.pinnedMessageId, on: true });
      }
      setGrpPinnedList(list);
      if (list.length) { setPinnedMsgId(list[0].id); setPinnedMsgText(list[0].text); }
    })();
  }, [group.id, pid, group.pinnedMessageId, setPinnedMsgText]);
  /** Count of online members (excluding self) — shown in group chat header subtitle. */
  const onlineMemberCount = useMemo(() => {
    return allMembers.filter((m) => m.peerPubB64 !== myPubB64 && getPresenceState(m.peerPubB64).bucket === 'online').length;
  }, [allMembers, myPubB64]);

  /**
   * v4.32.267: `group` — снимок строки, замороженный при открытии экрана, и
   * подпись «N участников» в шапке не менялась ни от бана, ни от исключения,
   * ни от одобрения заявки: цифра оставалась той, что была на входе. Список
   * allMembers обновляется при каждой из этих операций — он и есть ответ.
   * Снимок остаётся запасным вариантом на первые кадры, пока список пуст.
   */
  const headerMemberCount = allMembers.length || group.memberCount;

  const reloadGrpScheduled = useCallback(async () => {
    const list = await listGroupScheduledMessages(group.id, pid);
    setGrpScheduledMsgs(list);
  }, [group.id, pid]);

  useEffect(() => { void reloadGrpScheduled(); }, [reloadGrpScheduled]);
  const closeGrpScheduledList = useCallback(() => setGrpScheduledListVisible(false), []);
  const closeStarred = useCallback(() => setStarredVisible(false), []);
  const closeGrpStats = useCallback(() => setGrpStatsVisible(false), []);
  const handleDeleteGrpScheduled = useCallback((id: string) => {
    runGuardedOp(async () => {
      await deleteScheduledMessage(id);
      await reloadGrpScheduled();
    }, 'Не удалось удалить отложенное сообщение', 'ui_group_delete_scheduled_failed');
  }, [reloadGrpScheduled]);
  /**
   * Своя роль в группе — своя строка в group_members.
   *
   * v4.32.255: владелец больше не сплющивается в 'admin'. Раньше ветка
   * `if (amAdmin) return 'admin'` срабатывала первой, и роль 'owner' не
   * возвращалась никогда. Для права писать и закреплять разницы нет (там
   * владелец и админ равны), но модерация их различает: чужого админа может
   * тронуть только владелец, — и владелец не мог, потому что представлялся
   * админом.
   *
   * v4.32.512: та же ветка перебивала не только 'owner'. Флаг
   * `groups.is_admin` писал один createGroup и больше не менял никто, так что
   * ПОНИЖЕННЫЙ администратор — и забаненный участник — по-прежнему получали
   * здесь роль 'admin': полный набор админских кнопок, системная строка у
   * себя и ноль последствий у остальных (их устройства спрашивают роль у
   * group_members). Теперь порядок обратный: строка участника, а флаг —
   * только запасной ответ, пока список не прочитан.
   */
  const myRole = useMemo<SendRole>(
    () => ownGroupRole(allMembers, myPubB64, !!group.isAdmin),
    [allMembers, myPubB64, group.isAdmin]
  );
  const amAdmin = isAdminRole(myRole);
  /**
   * Право отправки. Тот же вердикт выносится в fanoutGroupMessage и на приёме
   * у получателя — UI лишь показывает его заранее, а не решает сам.
   */
  const sendVerdict = useMemo(
    () => canSendToGroup({ role: myRole, type: group.type, adminOnlyPosting }),
    [myRole, group.type, adminOnlyPosting]
  );
  /**
   * Право закрепления. До v4.32.233 пункт «Закрепить» просто прятался под
   * amAdmin; теперь решает та же canPinInGroup, что и на приёме конверта —
   * иначе своё же закрепление молча отбрасывалось бы у остальных.
   */
  const canPin = useMemo(
    () => canPinInGroup({ role: myRole as PinRole, adminOnlyPinning, type: group.type }),
    [myRole, adminOnlyPinning, group.type]
  );
  const [myDisplayName, setMyDisplayName] = useState('Я');
  useEffect(() => {
    void getOwnDisplayName().then((n) => { if (n) setMyDisplayName(n); });
  }, []);

  // Pending join requests count (shown as badge on members button for admins)
  const [pendingJoinCount, setPendingJoinCount] = useState(0);
  useEffect(() => {
    if (!amAdmin) return;
    void countPendingJoinRequests(group.id, pid).then(setPendingJoinCount);
  }, [amAdmin, group.id, pid]);

  const [msgOffset, setMsgOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const PAGE_SIZE = 60;
  const [grpOpenUnread, setGrpOpenUnread] = useState(group.unreadCount ?? 0);
  const grpOpenUnreadRef = useRef(group.unreadCount ?? 0);
  const [slowModeSeconds, setSlowModeSeconds] = useState(group.slowModeSeconds ?? 0);
  const [slowCooldownLeft, setSlowCooldownLeft] = useState(0);
  /**
   * v4.32.231: пять пунктов меню «Медленный режим» были пятью копиями одной и
   * той же строки в 380 символов — из-за этого рассылку нового ctl-конверта
   * пришлось бы дублировать пять раз. Одна функция, один список значений.
   */
  const applySlowMode = useCallback(async (secs: number): Promise<string> => {
    // v4.32.265: кап тот же, что у декодера входящего конверта. Иначе введённое
    // командой число оставалось бы у себя как есть, а у получателей молча
    // урезалось — и медленный режим у половины группы был бы другим.
    const clamped = Math.max(0, Math.min(MAX_SLOWMODE_SECONDS, Math.floor(secs)));
    await setGroupSlowMode(group.id, pid, clamped);
    setSlowModeSeconds(clamped);
    const label = slowModeSysLine(clamped);
    await insertGroupSysMessage(group.id, pid, myPubB64, label);
    announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'meta', slowModeSeconds: clamped }, myDisplayName));
    return label;
  }, [group.id, pid, myPubB64, myDisplayName]);
  /**
   * v4.32.238: таймер исчезающих сообщений записывался только в свою БД —
   * у остальных участников переписка оставалась целиком. Теперь администратор
   * рассылает его ctl-конвертом; участнику рассылать нечего (чужие устройства
   * примут meta только от администратора), поэтому у него настройка остаётся
   * локальной, о чём прямо сказано в подписи к списку.
   */
  const applyDisappear = useCallback(async (ms: number): Promise<void> => {
    await setGroupDisappearTimer(group.id, pid, ms > 0 ? ms : null);
    setDisappearMs(ms > 0 ? ms : null);
    if (!amAdmin) return;
    const label = ms > 0
      ? `Исчезающие сообщения включены: ${formatDisappearLabel(ms)}`
      : 'Исчезающие сообщения выключены';
    await insertGroupSysMessage(group.id, pid, myPubB64, label);
    announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'meta', disappearMs: ms > 0 ? ms : 0 }, myDisplayName));
  }, [group.id, pid, myPubB64, myDisplayName, amAdmin]);
  /**
   * Переключить одну настройку группы: сначала запись, потом слова.
   *
   * v4.32.531: четыре пункта меню делали это четырьмя копиями одного кода, и
   * ни одна копия не ловила отказ. updateGroupMeta бросает (см. local.ts), а
   * вызов шёл через `void ... .then(...)`: при занятой базе человек видел
   * «Писать могут все» рядом с переключателем, оставшимся в прежнем
   * положении, и ничего — в логах. Теперь состояние в экране меняется только
   * после подтверждённой записи, а отказ доходит до человека.
   *
   * Системная строка в ленту — отдельно: она приятна, но её отсутствие не
   * повод объявлять настройку неприменённой, раз запись уже прошла.
   */
  const toggleGroupFlag = useCallback((key: GroupFlagKey, current: boolean, apply: (next: boolean) => void): void => {
    const next = groupFlagNext(current);
    const copy = groupFlagCopy(key, current);
    requestAnimationFrame(() => {
      void (async () => {
        try {
          await updateGroupMeta(group.id, pid, groupFlagPatch(key, next));
        } catch (e) {
          showError(userErrorText(e, copy.failure));
          return;
        }
        apply(next);
        showSuccess(copy.success);
        try {
          await insertGroupSysMessage(group.id, pid, myPubB64, copy.sys);
        } catch (e) {
          log.warn('group_flag_sys_line_failed', { key, err: rawErrorText(e) });
        }
        announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'meta', ...groupFlagPatch(key, next) }, myDisplayName));
      })();
    });
  }, [group.id, pid, myPubB64, myDisplayName]);
  /**
   * Когда я в последний раз писал в эту группу — для медленного режима.
   *
   * v4.32.271: было useRef(0) без всякого хранения. Ref живёт ровно столько,
   * сколько смонтирован экран чата, а он размонтируется на «назад». То есть
   * медленный режим снимался не обходом протокола и не подделанным клиентом,
   * а выходом из группы и повторным входом — задержка в час обходилась за две
   * секунды. Отметка теперь лежит в kv и переживает и экран, и перезапуск.
   */
  const lastSentRef = useRef(0);
  // v4.32.505: отсчёт живёт в области таймеров, а не в голом ref. Голый ref
  // чистился в cleanup ниже, но восстановление отметки из kv заводило интервал
  // из `.then()` — то есть уже после уборки, и снять его было некому.
  const slowScopeRef = useRef<TimerScope | null>(null);
  if (slowScopeRef.current === null) slowScopeRef.current = createTimerScope();
  /**
   * v4.32.516: экран ещё жив? Нужен там, где после await нельзя ни показывать,
   * ни перечитывать список, — см. runViewOnceTap. Такой флаг был в личной
   * переписке с v4.32.125, а в группе не появился ни разу.
   */
  const isMountedRef = useRef(true);
  // v4.32.487: пауза медленного режима — своя у каждого аккаунта: общая
  // отметка заставляла второй профиль досиживать паузу первого.
  const slowKey = groupLastSentKey(group.id);
  /**
   * Обратный отсчёт медленного режима.
   *
   * v4.32.271: раньше отсчёт заводился прямо в обработчике отправки условием
   * `slowModeSeconds > 0` — без взгляда на роль. Сам запрет администрацию не
   * трогает (slowModeRemaining возвращает 0 для owner/admin), а вот плашка и
   * подпись поля ввода «Подождите N с…» показывались администратору тоже:
   * поле выглядело заблокированным, хотя писать было можно. Одно правило,
   * записанное дважды, — одна из копий разошлась.
   */
  const startSlowCooldown = useCallback((sentAt: number): void => {
    const scope = slowScopeRef.current;
    if (!scope || scope.disposed) return;
    lastSentRef.current = sentAt;
    scope.clearAll();
    const left0 = slowModeRemaining({ role: myRole, slowModeSeconds, lastSentAt: sentAt, now: Date.now() });
    setSlowCooldownLeft(left0);
    if (left0 <= 0) return;
    scope.interval(() => {
      const left = slowModeRemaining({ role: myRole, slowModeSeconds, lastSentAt: lastSentRef.current, now: Date.now() });
      setSlowCooldownLeft(left);
      if (left <= 0) scope.clearAll();
    }, 1000);
  }, [myRole, slowModeSeconds]);
  useEffect(() => {
    // Флаг нужен помимо области: при переходе в другую группу экран не
    // размонтируется, а ключ меняется — ответ по прежнему ключу завёл бы
    // чужой отсчёт.
    let cancelled = false;
    void scopedKvGet(slowKey).then((raw) => {
      if (cancelled) return;
      const ts = raw ? Number(raw) : 0;
      if (Number.isFinite(ts) && ts > 0) startSlowCooldown(ts);
    });
    return () => { cancelled = true; };
  }, [slowKey, startSlowCooldown]);
  const [showGrpFormatBar, setShowGrpFormatBar] = useState(false);
  const grpSelRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grpInputRef = useRef<any>(null);
  // v4.32.229: было три разные таблицы emoji на проект — общая в
  // chat-utils/emoji.ts (200+ имён, используется в ЛС), локальная копия на 41
  // имя здесь и мёртвая EMOJI_NAMES на 80 имён ниже по файлу. В группах
  // :rocket работал, а :dragon — нет. Оставляем одну общую.
  const grpEmojiSuggestions = useMemo(() => getEmojiSuggestions(text), [text]);
  // Compose-time link preview (mirrors ChatScreen behaviour)
  const [grpComposeLinkUrl, setGrpComposeLinkUrl] = useState<string | null>(null);
  const [grpComposeLinkDismissed, setGrpComposeLinkDismissed] = useState<string | null>(null);
  const grpComposeLinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v4.32.182 (Round-12 #3, #11): unmount cleanup for slow-mode ticker,
  // link-preview debounce, and per-peer typing timers (otherwise they fire
  // setState/setTypingMembers on an unmounted screen).
  // v4.32.505: отсчёт снимается через dispose() — он не только гасит живой
  // интервал, но и запрещает завести новый запоздавшим `.then()`.
  useEffect(() => {
    const typingTimers = typingTimersRef.current;
    const slowScope = slowScopeRef.current;
    // Присваивание, а не только сброс: при повторном монтировании того же
    // экрана ref остаётся прежним объектом со снятым флагом.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      slowScope?.dispose();
      if (grpComposeLinkTimerRef.current) { clearTimeout(grpComposeLinkTimerRef.current); grpComposeLinkTimerRef.current = null; }
      typingTimers.forEach((t) => clearTimeout(t));
      typingTimers.clear();
    };
  }, []);
  // Double-tap to ❤️ in group — track last tap time per message id
  const lastTapMapRef = useRef<Map<string, number>>(new Map());
  // v4.32.545: та же склейка вызовов, что и в переписке, — теперь общая.
  // Прежде сорвавшаяся загрузка уходила отказом в `void loadMessages()` и не
  // оставляла следа: список молча оставался вчерашним.
  const loadTaskRef = useRef(
    createCoalescedTask({
      onError: (e) => log.error('ui_group_load_messages_failed', { err: rawErrorText(e) }),
    }),
  );
  // v4.32.526: какие отметки о прочтении уже ушли за этот вход в группу.
  // Экран пересоздаётся по key={nav.group.id}, так что чистить набор не надо.
  const sentGroupReceiptsRef = useRef<Set<string>>(new Set());

  const loadMessages = useCallback(async () => {
    await loadTaskRef.current.run(async () => {
    // Purge any expired disappearing messages before loading
    await purgeDisappearedMessages();
    if (!isMountedRef.current) return;
    const read = await listGroupMessages({ groupId: group.id, limit: PAGE_SIZE, offset: 0, ownerProfileId: pid });
    if (!isMountedRef.current) return;
    // v4.32.532: сбой чтения — выходим до единой записи. Прежде пустой список
    // от занятой базы шёл дальше как факт: экран гасил подгрузку, писал «Нет
    // сообщений» и тут же отмечал группу прочитанной — счётчик непрочитанного
    // обнулялся из-за ошибки, а вернуть его нечем. Отметка о прочтении и
    // квитанции участникам оправданы только тем, что мы правда прочитали.
    if (!shouldApplyRows(read)) {
      log.warn('ui_group_load_messages_read_failed', { groupId: group.id });
      setMsgReadFailed(true);
      return;
    }
    setMsgReadFailed(false);
    const msgs = read;
    // v4.32.533: обновление читает первую страницу, а зовут его на каждую
    // запись в базе — на входящее сообщение, реакцию, правку, отметку о
    // прочтении. Прежде свежая страница ложилась на место всего списка, и
    // переписка, долистанная на полгода назад, схлопывалась до последних
    // шестидесяти сообщений, стоило кому-нибудь написать. Склеиваем свежую
    // голову с сохранённым хвостом — тем же кодом, что и лента.
    const merged = mergeListHead(messagesRef.current, msgs, PAGE_SIZE, atCreatedAt);
    setMessages(merged);
    setMsgOffset(merged.length);
    setHasMore((prevHas) => hasMoreAfterRefresh(msgs.length, merged.length, PAGE_SIZE, prevHas));
    // Capture unread count before marking as read
    if (grpOpenUnreadRef.current === 0 && group.unreadCount > 0) {
      grpOpenUnreadRef.current = group.unreadCount;
      setGrpOpenUnread(group.unreadCount);
    }
    await markGroupRead(group.id, pid);
    if (!isMountedRef.current) return;
    // v4.32.226: removed blind `view_count + 1` per-open increment. It counted the
    // local user's own re-opens (no viewer identity, no dedup) and inflated channel
    // view badges to thousands. Real views now come from distinct seen_by readers
    // (read-receipt backed) — see the eye-badge render + GroupMessageInfoModal.
    // Send read receipts for the most recent messages from other senders.
    // v4.32.526: дедупликация была только внутри одного вызова, а вызывается
    // loadMessages на каждую запись в хранилище — те же отметки уходили тем же
    // двадцати участникам снова и снова. Набор живёт на всём времени открытия
    // группы: повторно отправленная отметка адресату ничего не сообщает.
    const sentReceipts = new Set<string>();
    for (const msg of msgs.slice(0, 20)) {
      if (msg.senderPubB64 === myPubB64 || sentReceipts.has(msg.senderPubB64)) continue;
      sentReceipts.add(msg.senderPubB64);
      const mark = `${msg.senderPubB64}|${msg.id}`;
      if (sentGroupReceiptsRef.current.has(mark)) continue;
      sentGroupReceiptsRef.current.add(mark);
      void sendGroupReadReceipt(group.id, msg.id, msg.senderPubB64, myPubB64);
    }
    });
  }, [group.id, group.unreadCount, pid, myPubB64]);

  /**
   * Одноразовое фото в группе.
   *
   * v4.32.248: отправить его было можно (переключатель в окне выбора снимка
   * есть), а открыть — нельзя ни отправителю, ни участникам: нажатие на плитку
   * выдавало «Одноразовые фото доступны только в режиме просмотра» — фразу,
   * которая ничего не значит. То есть снимок уходил в группу и не показывался
   * там никому и никогда.
   *
   * Ведём себя как личный чат: показываем и сразу удаляем у себя. Удаление
   * локальное — у остальных снимок исчезнет, когда откроют его сами.
   *
   * v4.32.516: «как личный чат» стало буквальным — порядок один на оба экрана
   * (runViewOnceTap). Скопированный сюда, он растерял все проверки «экран ещё
   * жив», и уход из группы во время расшифровки заканчивался удалением снимка,
   * которого никто не увидел.
   */
  const handleGrpViewOnceTap = useCallback((item: GroupMessageRow) => {
    if (!item.mediaCids) return;
    const cids = item.mediaCids;
    void runViewOnceTap({
      resolve: () => resolveMediaCidsToUris(cids, gateway),
      alive: () => isMountedRef.current,
      open: (uris) => grpMediaViewer.open(uris, 0),
      later: (fn) => { setTimeout(fn, VIEW_ONCE_DELETE_DELAY_MS); },
      remove: () => deleteGroupMessage(item.id, pid),
      reload: () => { void loadMessages(); },
      // Вложение живёт на relay около трёх часов — старое уже не достать.
      onUnavailable: () => showError('Снимок больше недоступен'),
      onRemoveFailed: () => showError('Не удалось удалить одноразовый снимок'),
    });
  }, [gateway, grpMediaViewer, pid, loadMessages]);

  const reloadStarred = useCallback(() => { void loadMessages(); }, [loadMessages]);

  const closeGrpRecentlyDeleted = useCallback(() => setGrpRecentlyDeletedVisible(false), []);

  /**
   * v4.32.278: пункт «Недавно удалённые» есть в двух меню — обычной группы и
   * канала — и до этой версии его тело было выписано дважды слово в слово.
   * Два экземпляра одного правила (срок хранения, ключ, порядок) — это две
   * копии, которые разъедутся при первой же правке одной из них.
   */
  const openGrpRecentlyDeleted = useCallback(() => {
    requestAnimationFrame(() => {
      void (async () => {
        const { kvGetSecretScoped } = await import('../../core/storage/local');
        const raw = await kvGetSecretScoped(pid, recentlyDeletedGroupKey(group.id));
        let list: Array<{ id: string; text: string; senderName: string; deletedAt: number }> = [];
        try { list = raw ? (JSON.parse(raw) as Array<{ id: string; text: string; senderName: string; deletedAt: number }>) : []; } catch { list = []; }
        const cutoff = Date.now() - GRP_RECENTLY_DELETED_TTL_MS;
        list = list.filter((x) => x.deletedAt > cutoff);
        setGrpRecentlyDeletedList(list);
        setGrpRecentlyDeletedVisible(true);
      })();
    });
  }, [pid, group.id]);

  const handleGrpRestoreDeleted = useCallback((entry: GroupRecentlyDeletedEntry) => {
    void (async () => {
      try {
        const { v4: uuidv4r } = await import('uuid');
        const row: GroupMessageRow = {
          id: uuidv4r(),
          groupId: group.id,
          senderPubB64: myPubB64,
          senderName: entry.senderName,
          text: entry.text,
          mediaCids: null,
          replyToId: null,
          replyToPreview: null,
          reactions: null,
          createdAt: Date.now(),
          ownerProfileId: pid,
        };
        await insertGroupMessage(row);
        // v4.32.552: см. kvUpdateSecretScoped — непрочитанную корзину нельзя
        // переписывать пустым списком, иначе восстановление одного сообщения
        // уничтожает все остальные.
        const { kvUpdateSecretScoped } = await import('../../core/storage/local');
        await kvUpdateSecretScoped(pid, recentlyDeletedGroupKey(group.id), (raw) => {
          let list: GroupRecentlyDeletedEntry[] = [];
          try { list = raw ? (JSON.parse(raw) as GroupRecentlyDeletedEntry[]) : []; } catch { list = []; }
          return JSON.stringify(list.filter((x) => x.id !== entry.id));
        });
        setGrpRecentlyDeletedList((prev) => prev.filter((x) => x.id !== entry.id));
        await loadMessages();
        showSuccess('Сообщение восстановлено');
      } catch (e) {
        showError(userErrorText(e, 'Не удалось восстановить сообщение'));
      }
    })();
  }, [group.id, myPubB64, pid, loadMessages]);

  const loadMore = useCallback(async () => {
    if (!hasMore) return;
    const page = await listGroupMessages({ groupId: group.id, limit: PAGE_SIZE, offset: msgOffset, ownerProfileId: pid });
    // v4.32.532: раньше сбой приходил пустым списком и гасил «есть ещё» —
    // одна блокировка базы навсегда обрезала переписку до уже показанного.
    const decision = decidePage(page, PAGE_SIZE);
    if (decision.endOfList) setHasMore(false);
    if (!decision.apply || page === null) {
      if (!decision.endOfList) log.warn('ui_group_load_more_read_failed', { offset: msgOffset });
      return;
    }
    const more = page;
    // v4.32.181 (Round-11 #7): dedup — a realtime message may arrive between
    // SQL offset calc and result; appending blindly produces "two children with
    // the same key" warning + duplicated row.
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const fresh = more.filter((m) => !seen.has(m.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
    setMsgOffset((o) => o + more.length);
  }, [group.id, msgOffset, hasMore, pid]);

  useEffect(() => {
    // v4.32.230: забаненные остаются строками в group_members (это чёрный
    // список), но в упоминаниях/подсказках их быть не должно.
    void listGroupMembers(group.id, pid).then((ms) => setAllMembers(ms.filter((m) => m.role !== 'banned')));
  }, [group.id, pid]);

  // Auto-translate incoming group messages
  const translateGrpMessages = useCallback(async (msgs: GroupMessageRow[]) => {
    // v4.32.181 (Round-11 #9): открытый текст уходит стороннему сервису, поэтому
    // нужно явное согласие. v4.32.486: решение одно на все места перевода и своё
    // у каждого аккаунта — social/translateConsent.
    if (!(await cloudTranslateAllowed())) return;
    // v4.32.366: решение «что можно отдать наружу» общее для всех мест
    // перевода — core/social/cloudTranslate.
    const toTranslate = msgs.filter(
      (m) =>
        m.senderPubB64 !== myPubB64 &&
        !isGroupSysMessage(m.text) &&
        translateBlockReason(m.text ?? '') === null
    );
    const batch = toTranslate.slice(0, 20);
    const updates: Record<string, string> = {};
    for (const m of batch) {
      const url = buildTranslateUrl(m.text, grpTranslateLang);
      if (!url) break; // язык испорчен — остальные дадут тот же отказ
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        const out = parseTranslation(await res.json(), m.text);
        if (out.ok) updates[m.id] = out.text;
      } catch { /* ignore */ } finally { clearTimeout(to); }
    }
    if (Object.keys(updates).length > 0) {
      setTranslationCache((prev) => ({ ...prev, ...updates }));
    }
    // v4.32.181 (Round-11 #8): include grpTranslateLang so toggle takes effect
    // immediately; prev deps=[myPubB64] captured stale target language.
  }, [myPubB64, grpTranslateLang]);

  useEffect(() => {
    if (!autoTranslate || messages.length === 0) return;
    const untranslated = messages.filter(
      (m) => m.senderPubB64 !== myPubB64 && !translationCache[m.id] && m.text && !m.text.startsWith('\x01') && !isGroupSysMessage(m.text)
    );
    if (untranslated.length > 0) {
      void translateGrpMessages(untranslated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTranslate, messages, translateGrpMessages]);

  // Subscribe to typing signals from all group members
  useEffect(() => {
    if (allMembers.length === 0) return;
    const svc = getMessagingService();
    if (!svc) return;
    const unsubs = allMembers
      .filter((m) => m.peerPubB64 !== myPubB64)
      .map((m) => {
        return svc.onTyping(m.peerPubB64, () => {
          const name = m.displayName ?? shortIdentity(m.peerPubB64);
          setTypingMembers((prev) => new Map(prev).set(m.peerPubB64, name));
          const existing = typingTimersRef.current.get(m.peerPubB64);
          if (existing) clearTimeout(existing);
          const t = setTimeout(() => {
            setTypingMembers((prev) => { const n = new Map(prev); n.delete(m.peerPubB64); return n; });
          }, 4000);
          typingTimersRef.current.set(m.peerPubB64, t);
        });
      });
    return () => { unsubs.forEach((u) => u()); };
  }, [allMembers, myPubB64]);

  useEffect(() => {
    if (!searchVisible || !searchQuery.trim()) {
      setSearchResults(null);
      setSearchScan(null);
      return;
    }
    // v4.32.506: снятия таймера мало. Если запрос в базу уже ушёл, а поиск
    // за это время закрыли, ответ приходил в пустоту и снова подменял ленту
    // результатами — экран замирал на найденном списке без строки поиска.
    // На экране переписки этот флаг есть с v4.32.239, здесь его забыли.
    let alive = true;
    const t = setTimeout(() => {
      void searchGroupMessages(group.id, searchQuery.trim(), pid).then((res) => {
        if (!alive) return;
        setSearchResults(res.items);
        setSearchScan(res.scan);
        setSearchIdx(0);
      });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [searchQuery, searchVisible, group.id, pid]);

  const openSearch = useCallback(() => {
    setSearchVisible(true);
    setSearchQuery('');
    setSearchResults(null);
    setSearchScan(null);
    setTimeout(() => searchInputRef.current?.focus(), 100);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchQuery('');
    setSearchResults(null);
    setSearchScan(null);
    setSearchIdx(0);
  }, []);

  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draftSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Текст, ждущий записи в черновик; см. flushGroupDraft (v4.32.324). */
  const pendingGroupDraftRef = useRef<string | null>(null);
  /**
   * v4.32.583: черновик группы не открылся ключом данных. Поле ввода тогда
   * остаётся пустым — и первая же буква с последующим её удалением
   * записывала бы NULL поверх целого шифротекста. Флаг держится в ref:
   * решает не рендер, а обработчики ввода. См. draftGuard.
   */
  const draftUnreadableRef = useRef(draftIsUnreadable(group.draftUnreadable));
  useEffect(() => {
    draftUnreadableRef.current = draftIsUnreadable(group.draftUnreadable);
  }, [group.draftUnreadable]);

  /** Единственная точка записи черновика группы (v4.32.583). */
  const writeGroupDraft = useCallback((next: string | null) => {
    if (!decideDraftWrite(next, draftUnreadableRef.current).write) return;
    draftUnreadableRef.current = unreadableAfterWrite(next, draftUnreadableRef.current);
    void setGroupDraft(group.id, pid, next);
  }, [group.id, pid]);

  // Restore draft on mount
  useEffect(() => {
    if (group.draftText && hasReadableDraft(group.draftText, group.draftUnreadable)) setText(group.draftText);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Дописать черновик группы немедленно (v4.32.324, по образцу личных чатов).
   *
   * Отложенная на 600 мс запись переживает обычный уход с экрана — таймер
   * досрочно никто не отменял, — но не переживает смерть процесса. А процесс
   * как раз и рискует умереть под системной активити: галереей, камерой,
   * выбором документа. Уходило написанное за последние 600 мс.
   */
  const flushGroupDraft = useCallback(() => {
    if (!draftSaveRef.current) return;
    clearTimeout(draftSaveRef.current);
    draftSaveRef.current = null;
    const pending = pendingGroupDraftRef.current ?? '';
    pendingGroupDraftRef.current = null;
    writeGroupDraft(pending.trim() || null);
  }, [writeGroupDraft]);

  /** Снять черновик вместе с отложенной записью (текст уже ушёл или запланирован). */
  const clearGroupDraft = useCallback(() => {
    if (draftSaveRef.current) { clearTimeout(draftSaveRef.current); draftSaveRef.current = null; }
    pendingGroupDraftRef.current = null;
    writeGroupDraft(null);
  }, [writeGroupDraft]);

  // Уход из группы (и переход в другую) дописывает черновик.
  useEffect(() => {
    return () => { flushGroupDraft(); };
  }, [flushGroupDraft]);

  const handleTextChange = useCallback((t: string) => {
    textRef.current = t;
    setText(t);
    // Persist draft with debounce
    if (draftSaveRef.current) clearTimeout(draftSaveRef.current);
    pendingGroupDraftRef.current = t;
    draftSaveRef.current = setTimeout(() => {
      draftSaveRef.current = null;
      const pending = pendingGroupDraftRef.current ?? '';
      pendingGroupDraftRef.current = null;
      writeGroupDraft(pending.trim() || null);
    }, 600);
    // Send typing indicator to group members (debounced)
    if (t.trim()) {
      if (!typingDebounceRef.current) {
        void (async () => {
          const svc = getMessagingService();
          if (svc) {
            const members = allMembers.filter((m) => m.peerPubB64 !== myPubB64);
            for (const m of members.slice(0, 10)) { // limit fanout to 10 for performance
              void svc.sendTypingIndicator(m.peerPubB64).catch(() => {});
            }
          }
        })();
        typingDebounceRef.current = setTimeout(() => { typingDebounceRef.current = null; }, 3000);
      }
    }
    // Detect slash command trigger (only at start of message)
    if (t.startsWith('/') && !t.includes(' ')) {
      setCmdFilter(t.slice(1).toLowerCase());
      setMentionFilter(null);
      setHashtagFilter(null);
      return;
    }
    setCmdFilter(null);
    // Detect @-mention trigger
    const lastAt = t.lastIndexOf('@');
    if (lastAt >= 0) {
      const fragment = t.slice(lastAt + 1);
      if (!fragment.includes(' ')) {
        setMentionFilter(fragment.toLowerCase());
        setHashtagFilter(null);
        return;
      }
    }
    setMentionFilter(null);
    // Detect #hashtag trigger
    const htMatch = /#([a-zа-яё0-9_]{1,})$/i.exec(t);
    if (htMatch) {
      setHashtagFilter(htMatch[1].toLowerCase());
    } else {
      setHashtagFilter(null);
    }
    // Detect URL for compose-time link preview (debounced)
    if (grpComposeLinkTimerRef.current) clearTimeout(grpComposeLinkTimerRef.current);
    grpComposeLinkTimerRef.current = setTimeout(() => {
      const url = extractFirstUrl(t);
      if (url && url !== grpComposeLinkDismissed) {
        setGrpComposeLinkUrl(url);
      } else if (!url) {
        setGrpComposeLinkUrl(null);
        setGrpComposeLinkDismissed(null);
      }
    }, 600);
  }, [allMembers, myPubB64, grpComposeLinkDismissed, writeGroupDraft]);

  /** Псевдо-участник для упоминания всех (@все) */
  const everyoneSuggestion: GroupMemberRow | null = useMemo(() => {
    if (!amAdmin) return null;
    if (mentionFilter === null) return null;
    if (!'все'.startsWith(mentionFilter) && !'all'.startsWith(mentionFilter) && mentionFilter !== '') return null;
    return { id: -1, groupId: group.id, peerPubB64: '__everyone__', displayName: 'все', role: 'admin', joinedAt: 0, ownerProfileId: pid };
  }, [amAdmin, mentionFilter, group.id, pid]);

  /**
   * v4.32.606: участника, чьё имя не открыл ключ, подсказка предложить не может
   * — вместо имени подставился бы короткий ключ, и такое упоминание у
   * получателя не совпало бы ни с кем. Такие имена считаем и говорим о них
   * вслух, а не выкидываем молча.
   */
  const mentionHits = useMemo((): MemberSearch<GroupMemberRow> => {
    if (mentionFilter === null) return { matched: [], unreadable: 0 };
    const hits = mentionableMembers(
      allMembers.filter((m) => m.peerPubB64 !== myPubB64),
      mentionFilter
    );
    const base = hits.matched.slice(0, 5);
    return {
      matched: everyoneSuggestion ? [everyoneSuggestion, ...base] : base,
      unreadable: hits.unreadable,
    };
  }, [mentionFilter, allMembers, myPubB64, everyoneSuggestion]);
  const mentionSuggestions = mentionHits.matched;
  const mentionSkipped = mentionFilter === null ? null : mentionSkippedNotice(mentionHits.unreadable);

  const insertMention = useCallback((member: GroupMemberRow) => {
    const name = member.displayName ?? shortIdentity(member.peerPubB64);
    const lastAt = text.lastIndexOf('@');
    const newText = text.slice(0, lastAt) + `@${name} `;
    setText(newText);
    setMentionFilter(null);
  }, [text]);

  // ─── Hashtag suggestions ─────────────────────────────────────────────────────
  const grpHashtagSuggestions = useMemo(() => {
    if (hashtagFilter === null) return [];
    const counts = new Map<string, number>();
    for (const msg of messages) {
      const tags = (msg.text ?? '').match(/#([a-zа-яё0-9_]+)/gi) ?? [];
      for (const t of tags) counts.set(t.toLowerCase(), (counts.get(t.toLowerCase()) ?? 0) + 1);
    }
    return [...counts.keys()]
      .filter((t) => t.slice(1).startsWith(hashtagFilter) && t.slice(1) !== hashtagFilter)
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
      .slice(0, 8);
  }, [hashtagFilter, messages]);

  const insertHashtag = useCallback((tag: string) => {
    const newText = text.replace(/#([a-zа-яё0-9_]*)$/i, tag + ' ');
    setText(newText);
    setHashtagFilter(null);
  }, [text]);

  // ─── Slash command suggestions ───────────────────────────────────────────────
  type CmdDef = { cmd: string; desc: string; adminOnly: boolean };
  const ALL_CMDS: CmdDef[] = useMemo(() => [
    { cmd: '/dice', desc: 'Бросить кубик', adminOnly: false },
    { cmd: '/coin', desc: 'Подбросить монету', adminOnly: false },
    { cmd: '/magic', desc: 'Магический шар', adminOnly: false },
    { cmd: '/random', desc: 'Случайное число 0–99', adminOnly: false },
    { cmd: '/help', desc: 'Команды администратора', adminOnly: true },
    { cmd: '/kick', desc: 'Исключить участника', adminOnly: true },
    { cmd: '/ban', desc: 'Заблокировать участника', adminOnly: true },
    { cmd: '/unban', desc: 'Снять блокировку', adminOnly: true },
    { cmd: '/promote', desc: 'Назначить администратором', adminOnly: true },
    { cmd: '/demote', desc: 'Снять администратора', adminOnly: true },
    { cmd: '/mute', desc: 'Запретить участнику писать', adminOnly: true },
    { cmd: '/unmute', desc: 'Снять ограничение', adminOnly: true },
    { cmd: '/slowmode', desc: 'Установить медленный режим', adminOnly: true },
    { cmd: '/pin', desc: 'Закрепить сообщение', adminOnly: true },
    { cmd: '/unpin', desc: 'Открепить сообщение', adminOnly: true },
    { cmd: '/readonly', desc: 'Только чтение', adminOnly: true },
    { cmd: '/open', desc: 'Открыть чат для всех', adminOnly: true },
  ], []);

  const cmdSuggestions = useMemo((): CmdDef[] => {
    if (cmdFilter === null) return [];
    return ALL_CMDS.filter((c) => {
      if (c.adminOnly && !amAdmin) return false;
      return c.cmd.slice(1).startsWith(cmdFilter) || cmdFilter === '';
    }).slice(0, 6);
  }, [cmdFilter, amAdmin, ALL_CMDS]);



  const handleMentionPress = useCallback((name: string) => {
    const member = allMembers.find((m) => (m.displayName ?? '').toLowerCase() === name.toLowerCase());
    if (!member) return;
    const displayName = member.displayName ?? name;
    Alert.alert(displayName, '', [
      { text: 'Написать в ЛС', onPress: () => onOpenDm?.(member.peerPubB64, displayName) },
      { text: 'Отмена', style: 'cancel' },
    ]);
  }, [allMembers, onOpenDm]);

  useEffect(() => { void loadMessages(); }, [loadMessages]);
  // v4.32.16: gate через tabRef из Context. Prop isActive удалён — React.memo bail-out.
  const tabRefGroupChat = useTabRef();

  // v4.32.61: Android back в открытой групповой переписке — перехват
  // внутренних non-Modal overlays (selection, search, composer-бары),
  // дальше возврат false → App.tsx top-level handler закроет groupJump.
  useBackHandler(true, () => {
    if (tabRefGroupChat.current !== 'groups') return false;
    if (selectedGrpIds.size > 0) {
      setSelectedGrpIds(new Set());
      return true;
    }
    if (searchVisible) {
      setSearchVisible(false);
      return true;
    }
    if (editingMsg) {
      setEditingMsg(null);
      return true;
    }
    if (replyTo) {
      setReplyTo(null);
      return true;
    }
    if (grpEmojiPanelVisible) {
      setGrpEmojiPanelVisible(false);
      return true;
    }
    if (pendingGrpImageUris.length > 0) {
      setPendingGrpImageUris([]);
      setGrpImageCaption('');
      setGrpImageViewOnce(false);
      return true;
    }
    return false;
  });
  useEffect(() => {
    const unsub = subscribeChatWrites(() => {
      if (tabRefGroupChat.current !== 'groups') return;
      void loadMessages().then(() => {
        // Auto-scroll to newest message if already near the bottom
        if (!showScrollBottomRef.current) {
          groupFlashRef.current?.scrollToOffset({ offset: 0, animated: true });
        }
      });
      // Закрепление от другого участника приходит тем же путём, что сообщение,
      // поэтому баннер обновляем здесь же — иначе он оставался бы старым до
      // следующего входа в чат.
      void resolvePinned(group.id, pid).then((list) => {
        setGrpPinnedList(list);
        setPinnedMsgId(list[0]?.id ?? null);
        setPinnedMsgText(list[0]?.text ?? null);
      });
    });
    return unsub;
  }, [loadMessages, tabRefGroupChat, group.id, pid, setPinnedMsgText]);

  const applyReaction = useCallback(async (msg: GroupMessageRow, emoji: string) => {
    // v4.32.232: реакция писалась ТОЛЬКО в локальную БД — остальные участники
    // о ней не узнавали никогда. Разбор/склейка карты уехали в toggleReaction
    // (одно чтение вместо read-modify-write в трёх экранах), рассылка — в
    // toggleAndSyncReaction.
    // v4.32.273: отказ проговаривается — молчащая кнопка неотличима от сломанной.
    // v4.32.447: своя копия проверки роли отсюда убрана. Она считалась от myRole,
    // то есть от состояния экрана, а не от базы, и отставала от разжалования,
    // применённого минуту назад; сам toggleAndSyncReaction теперь возвращает
    // отказ с текстом, а не безмолвный null.
    const res = await toggleAndSyncReaction({ msgId: msg.id, emoji, groupId: group.id });
    if (!res.ok) {
      showError(res.reason);
      setQuickReact(null);
      return;
    }
    // Реакция записана у себя, но конверт мог никуда не уйти: без этой строки
    // участники её не увидят, а автор будет уверен, что увидели.
    if (res.warning) showError(res.warning);
    if (res.on) {
      const raw = await scopedKvGet(RECENT_REACTIONS_KEY);
      let list: string[] = [];
      try { list = raw ? (JSON.parse(raw) as string[]) : []; } catch { /* */ }
      list = [emoji, ...list.filter((e) => e !== emoji)].slice(0, 8);
      await scopedKvSet(RECENT_REACTIONS_KEY, JSON.stringify(list));
      setGrpRecentReactions(list);
    }
    setQuickReact(null);
    void loadMessages();
  }, [group.id, loadMessages]);

  const startEdit = useCallback((msg: GroupMessageRow) => {
    setEditingMsg(msg);
    setText(msg.text);
    setReplyTo(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingMsg(null);
    setText('');
  }, []);

  const pickGroupImage = useCallback(async () => {
    // v4.32.323: при исчерпанном пределе галерея больше не открывается ради
    // фотографии, которую всё равно срежут (`Math.max(1, 10 - выбрано)`).
    const remainingSlots = remainingImageSlots(pendingGrpImageUris.length);
    if (remainingSlots === 0) {
      showError(`Можно приложить не больше ${CHAT_MAX_IMAGES} фото`);
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { showPermissionDeniedAlert('Фото', 'Для прикрепления изображения нужен доступ к галерее.'); return; }
    // v4.32.54: quality:1 + exif:false чтобы expo-image-picker 16.1.4 не упал в
    // CompressionImageExporter.imageLoader (NoSuchMethodError на realme/Android 15).
    // При MAXIMUM_QUALITY нативный код идёт по RawImageExporter ветке, которая не
    // требует сломанного `appContext.imageLoader` extension property в expo-modules-core 55.
    // v4.32.57: Telegram-style — до 10 фото/видео за раз, учёт уже выбранных.
    // Набранный текст дописывается в черновик до открытия галереи: пока она
    // на экране, наш процесс на Android вправе убить.
    flushGroupDraft();
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 1,
      exif: false,
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      videoMaxDuration: 120,
    });
    if (res.canceled || res.assets.length === 0) return;
    // Send video assets as documents
    const videoAssets = res.assets.filter((a) => a.type === 'video');
    if (videoAssets.length > 0) {
      // v4.32.48: video size guard (см. ChatScreen.pickImage для полного комментария).
      // v4.32.245: без IPFS-сервера видео уезжает вложением, а там потолок 8 МБ.
      // Раньше порог был один (25 МБ) — файл принимался, а отправка молча
      // падала на «Не удалось загрузить видео».
      const { isIpfsEnabled } = await import('../../core/transport/ipfs/heliaNode');
      const { uploadLimitBytes, formatLimit, IPFS_VIDEO_MAX_BYTES } = await import('../../core/media/uploadRoute');
      const viaBlob = !isIpfsEnabled();
      const videoMaxBytes = uploadLimitBytes({ ipfsEnabled: !viaBlob, ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES });
      const tooLarge = videoAssets.find((va) => (va.fileSize ?? 0) > videoMaxBytes);
      if (tooLarge) {
        Alert.alert(
          'Видео слишком большое',
          viaBlob
            ? `Без IPFS-сервера видео передаётся вложением, а его предел — ${formatLimit(videoMaxBytes)}. Обрежьте видео или уменьшите качество.`
            : `Максимальный размер видео — ${formatLimit(videoMaxBytes)}. Обрежьте его перед отправкой.`,
        );
        return;
      }
      // v4.32.245: проверки «есть ли IPFS» больше нет — без него видео уходит
      // зашифрованным вложением, как в личных чатах. Раньше на телефоне видео
      // в группу отправить было нельзя вообще.
      setSending(true);
      try {
        const { uploadMediaToCid } = await import('../../core/media/mediaUpload');
        let sentAny = false;
        // v4.32.248: запасной счётчик к проверке выше. Та смотрит на fileSize
        // из галереи, а его отдают не все системы: при отсутствующем размере
        // ролик проходил проверку и падал на общем «Не удалось загрузить
        // видео», из которого не понять, что дело в размере.
        // v4.32.358: и падал не всегда — сначала читался целиком в память, без
        // единого ограничения сверху. Размер теперь спрашивается у файловой
        // системы до чтения, и запасной счётчик стал именно запасным.
        let skippedTooLarge = 0;
        for (const va of videoAssets) {
          const name = va.fileName ?? va.uri.split('/').pop() ?? 'video.mp4';
          const up = await uploadMediaToCid(va.uri, {
            mime: va.mimeType ?? 'video/mp4',
            ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES,
          });
          if (!up.ok) {
            if (up.reason === 'oversize') skippedTooLarge++;
            continue;
          }
          const cid = up.cid;
          const docText = makeDocText(name.includes('.') ? name : `${name}.mp4`, up.sizeBytes ?? va.fileSize ?? 0, cid);
          const row: GroupMessageRow = { id: uuidv4(), groupId: group.id, senderPubB64: myPubB64, senderName: myDisplayName, text: docText, mediaCids: null, replyToId: null, replyToPreview: null, reactions: null, createdAt: Date.now(), ownerProfileId: pid };
          await insertGroupMessage(row);
          await touchGroupConversation(group.id, pid, '🎬 Видео', false, myDisplayName, false, myPubB64);
          announceGroupSend(fanoutGroupMessage(group.id, docText, myDisplayName, myPubB64, row.id));
          sentAny = true;
        }
        if (skippedTooLarge > 0) showError(`Видео больше ${formatLimit(videoMaxBytes)} отправить нельзя (пропущено: ${skippedTooLarge})`);
        else if (!sentAny) showError('Не удалось загрузить видео');
        await loadMessages();
      } catch (e) {
        showError(userErrorText(e, 'Не удалось отправить видео'));
      } finally {
        setSending(false);
      }
      return;
    }
    // v4.32.244: проверки «есть ли IPFS» больше нет — при его отсутствии
    // sendGroupImages кладёт снимок в зашифрованное вложение, как в личных
    // чатах. Раньше здесь стоял алерт «Фото недоступно», и на телефоне
    // отправить фото в группу было нельзя вообще.
    const imageAssets = res.assets.filter((a) => a.type !== 'video');
    // v4.32.57: накапливаем с уже выбранными, truncate до лимита 10.
    setGrpImageCaption(text.trim());
    // v4.32.323: повторно отмеченная фотография больше не уходит в группу
    // дважды, а лишние сверх предела не пропадают молча.
    const merged = mergePickedImages(pendingGrpImageUris, imageAssets.map((a) => a.uri));
    setPendingGrpImageUris(merged.next);
    if (merged.overLimit > 0) showError(`Приложено не всё: предел — ${CHAT_MAX_IMAGES} фото`);
  }, [text, group.id, myPubB64, myDisplayName, pid, pendingGrpImageUris, flushGroupDraft, loadMessages]);

  const sendGroupImages = useCallback(async (uris: string[], caption: string, viewOnce = false) => {
    setSending(true);
    try {
      // v4.32.244: без IPFS кладём снимок в зашифрованное вложение — ключ
      // уезжает внутри уже зашифрованного конверта группы, на relay лежит
      // только шифртекст. Тот же путь, что в личных чатах.
      // v4.32.358: здесь не было ни одной проверки размера — ни до чтения, ни
      // после. Снимок читался целиком в память, и второй раз его читал
      // uploadEncryptedBlob. Теперь путь и предел выбирает mediaUpload.
      const { uploadMediaToCid } = await import('../../core/media/mediaUpload');
      const { formatLimit } = await import('../../core/media/uploadRoute');
      const cids: string[] = [];
      let limitBytes = MAX_BLOB_BYTES;
      for (const uri of uris) {
        const up = await uploadMediaToCid(uri, { mime: guessImageMime(uri) });
        if (up.ok) cids.push(up.cid);
        else if (up.reason === 'oversize') limitBytes = up.limitBytes;
      }
      if (cids.length === 0) { showError('Не удалось загрузить фото'); return; }
      // v4.32.245: молчать о выпавших снимках нельзя — человек видит в чате
      // меньше фотографий, чем выбрал, и не понимает почему.
      if (cids.length < uris.length) {
        showError(`Загружено ${cids.length} из ${uris.length} фото — остальные слишком большие (предел ${formatLimit(limitBytes)})`);
      }
      const baseText = caption.trim() || ' ';
      const msgText = viewOnce ? makeViewOnceText(baseText) : baseText;
      const row: GroupMessageRow = {
        id: uuidv4(),
        groupId: group.id,
        senderPubB64: myPubB64,
        senderName: myDisplayName,
        text: msgText,
        // v4.32.244: пишем тем же форматом, что и входящие сообщения —
        // раньше своя строка шла через запятую, чужая как JSON, и читатели
        // разбирали кто во что горазд.
        mediaCids: serializeMediaCids(cids),
        replyToId: null,
        replyToPreview: null,
        reactions: null,
        createdAt: Date.now(),
        ownerProfileId: pid,
      };
      await insertGroupMessage(row);
      await touchGroupConversation(group.id, pid, viewOnce ? '👁 Одноразовое фото' : (cids.length > 1 ? `📷 ${cids.length} фото` : '📷 Фото'), false, myDisplayName, false, myPubB64);
      // v4.32.244: cids не передавались вообще — снимок оставался только у
      // отправителя, у остальных приходил пустой текст.
      announceGroupSend(fanoutGroupMessage(group.id, msgText, myDisplayName, myPubB64, row.id, cids));
      await loadMessages();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось отправить фото'));
    } finally {
      setSending(false);
    }
  }, [group.id, myPubB64, myDisplayName, pid, loadMessages]);

  const pickGroupDoc = useCallback(async () => {
    const DocumentPicker = await import('expo-document-picker');
    flushGroupDraft();
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    // v4.32.193 (Round-23 #6): 50MB cap before base64 read (1.33× blow-up in
    // JS string). Mirrors MessageComposer.handleAttachFile cap.
    // v4.32.245: без IPFS-сервера файл уходит вложением с пределом 8 МБ —
    // говорим об этом сразу, а не после неудачной отправки.
    const { isIpfsEnabled } = await import('../../core/transport/ipfs/heliaNode');
    const { uploadLimitBytes, formatLimit, IPFS_DOC_MAX_BYTES } = await import('../../core/media/uploadRoute');
    const ipfsOn = isIpfsEnabled();
    const docMaxBytes = uploadLimitBytes({ ipfsEnabled: ipfsOn, ipfsMaxBytes: IPFS_DOC_MAX_BYTES });
    if (asset.size && asset.size > docMaxBytes) {
      showError(
        ipfsOn
          ? `Файл слишком большой (макс ${formatLimit(docMaxBytes)})`
          : `Файл слишком большой: без IPFS-сервера предел — ${formatLimit(docMaxBytes)}`,
      );
      return;
    }
    setSending(true);
    try {
      // v4.32.245: без IPFS файл уходит зашифрованным вложением — ключ едет
      // внутри уже зашифрованного конверта группы. Раньше здесь была просто
      // ошибка «Не удалось загрузить файл», и документы в группе не работали.
      const { uploadMediaToCid } = await import('../../core/media/mediaUpload');
      const up = await uploadMediaToCid(asset.uri, {
        mime: asset.mimeType,
        ipfsMaxBytes: IPFS_DOC_MAX_BYTES,
      });
      if (!up.ok) {
        showError(
          up.reason === 'oversize'
            ? `Файл слишком большой: предел — ${formatLimit(up.limitBytes)}`
            : 'Не удалось загрузить файл'
        );
        return;
      }
      const cid = up.cid;
      const docText = makeDocText(asset.name ?? 'document', asset.size ?? up.sizeBytes ?? 0, cid);
      const row: GroupMessageRow = {
        id: uuidv4(),
        groupId: group.id,
        senderPubB64: myPubB64,
        senderName: myDisplayName,
        text: docText,
        mediaCids: null,
        replyToId: null,
        replyToPreview: null,
        reactions: null,
        createdAt: Date.now(),
        ownerProfileId: pid,
      };
      await insertGroupMessage(row);
      await touchGroupConversation(group.id, pid, `📎 ${asset.name ?? 'Документ'}`, false, myDisplayName, false, myPubB64);
      announceGroupSend(fanoutGroupMessage(group.id, docText, myDisplayName, myPubB64, row.id));
      await loadMessages();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось отправить документ'));
    } finally {
      setSending(false);
    }
  }, [group.id, myPubB64, myDisplayName, pid, flushGroupDraft, loadMessages]);

  // v4.32.543: поиск места вынесен из общего try. Раньше один catch отвечал
  // и за приёмник, и за запись в базу, и за рассылку — на все три беды был
  // один текст «Не удалось отправить геопозицию», из которого не следовало ни
  // одного действия. Теперь выключенная геолокация называет себя сама, а
  // общий catch остаётся тому, чем он и был: отказу отправки.
  const sendGroupLocation = useCallback(async () => {
    const read = await readPlaceOnce();
    if (!isMountedRef.current) return;
    if (!read.ok) {
      if (read.kind === 'denied') {
        showPermissionDeniedAlert('Геолокация', 'Чтобы отправить местоположение, разрешите доступ к геолокации.');
        return;
      }
      showError(locationFailureText(read.kind));
      return;
    }
    setSending(true);
    try {
      const label = await reverseGeocodeLabel(read.coords.lat, read.coords.lon);
      const locText = makeLocationText(read.coords.lat, read.coords.lon, label);
      const row: GroupMessageRow = {
        id: uuidv4(),
        groupId: group.id,
        senderPubB64: myPubB64,
        senderName: myDisplayName,
        text: locText,
        mediaCids: null,
        replyToId: null,
        replyToPreview: null,
        reactions: null,
        createdAt: Date.now(),
        ownerProfileId: pid,
      };
      await insertGroupMessage(row);
      await touchGroupConversation(group.id, pid, '📍 Геолокация', false, myDisplayName, false, myPubB64);
      announceGroupSend(fanoutGroupMessage(group.id, locText, myDisplayName, myPubB64, row.id));
      await loadMessages();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось отправить геопозицию'));
    } finally {
      setSending(false);
    }
  }, [group.id, myPubB64, myDisplayName, pid, loadMessages]);

  // v4.32.60: хендлеры для AttachSheet (факторизация Alert-опций)
  const handleGroupCameraCapture = useCallback(async () => {
    // v4.32.323: как и в личных чатах — снимок добавляется к уже выбранному
    // (раньше затирал), а подпись берётся из поля ввода.
    if (remainingImageSlots(pendingGrpImageUris.length) === 0) {
      showError(`Можно приложить не больше ${CHAT_MAX_IMAGES} фото`);
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { showPermissionDeniedAlert('Камера', 'Для съёмки фото или видео нужен доступ к камере.'); return; }
    flushGroupDraft();
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, allowsEditing: false, quality: 1, exif: false });
    if (res.canceled || !res.assets[0]) return;
    setGrpImageCaption(text.trim());
    setPendingGrpImageUris(mergePickedImages(pendingGrpImageUris, [res.assets[0].uri]).next);
  }, [text, pendingGrpImageUris, flushGroupDraft]);

  // AttachSheet galleries уже фильтруют ассеты; группируем как в pickGroupImage (video → загрузка+doc, image → preview).
  const handleGroupAcceptGalleryAssets = useCallback(async (assets: Array<{ uri: string; type: 'image' | 'video' }>) => {
    const videoAssets = assets.filter((a) => a.type === 'video');
    const imageAssets = assets.filter((a) => a.type !== 'video');
    if (videoAssets.length > 0) {
      // v4.32.245: второй вход в галерею (лист вложений) повторял заглушки
      // «Видео недоступно» / «Фото недоступно», убранные в основном выборе, —
      // с него отправить в группу нельзя было ничего. Тот же путь: нет IPFS —
      // уходит зашифрованным вложением.
      setSending(true);
      try {
        const { uploadMediaToCid } = await import('../../core/media/mediaUpload');
        const { formatLimit, IPFS_VIDEO_MAX_BYTES } = await import('../../core/media/uploadRoute');
        let sentAny = false;
        let tooLarge = 0;
        let limitBytes = MAX_BLOB_BYTES;
        for (const va of videoAssets) {
          const name = va.uri.split('/').pop() ?? 'video.mp4';
          const up = await uploadMediaToCid(va.uri, {
            mime: 'video/mp4',
            ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES,
          });
          if (!up.ok) {
            if (up.reason === 'oversize') { tooLarge++; limitBytes = up.limitBytes; }
            continue;
          }
          const cid = up.cid;
          // v4.32.358: размер писался нулём — в списке файлов группы ролик
          // показывался как «0 Б», хотя он уже загружен и открывается.
          const docText = makeDocText(name.includes('.') ? name : `${name}.mp4`, up.sizeBytes ?? 0, cid);
          const row: GroupMessageRow = { id: uuidv4(), groupId: group.id, senderPubB64: myPubB64, senderName: myDisplayName, text: docText, mediaCids: null, replyToId: null, replyToPreview: null, reactions: null, createdAt: Date.now(), ownerProfileId: pid };
          await insertGroupMessage(row);
          await touchGroupConversation(group.id, pid, '🎬 Видео', false, myDisplayName, false, myPubB64);
          announceGroupSend(fanoutGroupMessage(group.id, docText, myDisplayName, myPubB64, row.id));
          sentAny = true;
        }
        if (tooLarge > 0) showError(`Видео больше ${formatLimit(limitBytes)} отправить нельзя (пропущено: ${tooLarge})`);
        else if (!sentAny) showError('Не удалось загрузить видео');
        await loadMessages();
      } catch (e) {
        showError(userErrorText(e, 'Не удалось отправить видео'));
      } finally {
        setSending(false);
      }
    }
    if (imageAssets.length > 0) {
      setGrpImageCaption(text.trim());
      // v4.32.323: тот же отбор, что и в pickGroupImage — здесь предел был
      // переписан отдельной строкой и повторы не отсеивались.
      const merged = mergePickedImages(pendingGrpImageUris, imageAssets.map((a) => a.uri));
      setPendingGrpImageUris(merged.next);
      if (merged.overLimit > 0) showError(`Приложено не всё: предел — ${CHAT_MAX_IMAGES} фото`);
    }
  }, [group.id, myPubB64, myDisplayName, pid, text, pendingGrpImageUris, loadMessages]);

  const handleGroupShareContact = useCallback(async (c: { peerPublicKey: string; displayName: string }) => {
    const cardText = makeContactCardText(c.displayName ?? '', c.peerPublicKey);
    const row: GroupMessageRow = {
      id: uuidv4(),
      groupId: group.id,
      senderPubB64: myPubB64,
      senderName: myDisplayName,
      text: cardText,
      mediaCids: null,
      replyToId: null,
      replyToPreview: null,
      reactions: null,
      createdAt: Date.now(),
      ownerProfileId: pid,
    };
    await insertGroupMessage(row);
    await touchGroupConversation(group.id, pid, `📇 ${c.displayName ?? ''}`, false, myDisplayName, false, myPubB64);
    announceGroupSend(fanoutGroupMessage(group.id, cardText, myDisplayName, myPubB64, row.id));
    await loadMessages();
  }, [group.id, myPubB64, myDisplayName, pid, loadMessages]);

  const handleGroupPickQuickReply = useCallback((qrText: string) => {
    setText((t) => t + qrText);
  }, []);

  const sendGroupGif = useCallback(async (gifText: string) => {
    setSending(true);
    try {
      const row: GroupMessageRow = {
        id: uuidv4(),
        groupId: group.id,
        senderPubB64: myPubB64,
        senderName: myDisplayName,
        text: gifText,
        mediaCids: null,
        replyToId: null,
        replyToPreview: null,
        reactions: null,
        createdAt: Date.now(),
        ownerProfileId: pid,
      };
      await insertGroupMessage(row);
      await touchGroupConversation(group.id, pid, '🎞 GIF', false, myDisplayName, false, myPubB64);
      announceGroupSend(fanoutGroupMessage(group.id, gifText, myDisplayName, myPubB64, row.id));
      await loadMessages();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось отправить GIF'));
    } finally {
      setSending(false);
    }
  }, [group.id, myPubB64, myDisplayName, pid, loadMessages]);

  const deleteMsg = useCallback((msg: GroupMessageRow) => {
    const isOwn = msg.senderPubB64 === myPubB64;
    if (!isOwn && !amAdmin) return;
    Alert.alert('Удалить сообщение?', '', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить', style: 'destructive',
        onPress: () => {
          void (async () => {
            const { kvUpdateSecretScoped } = await import('../../core/storage/local');
            const now = Date.now();
            await kvUpdateSecretScoped(pid, recentlyDeletedGroupKey(group.id), (raw) => {
              let list: Array<{ id: string; text: string; senderName: string; deletedAt: number }> = [];
              try { list = raw ? (JSON.parse(raw) as Array<{ id: string; text: string; senderName: string; deletedAt: number }>) : []; } catch { list = []; }
              list = list.filter((x) => x.deletedAt > now - GRP_RECENTLY_DELETED_TTL_MS);
              list.unshift({ id: msg.id, text: msg.text, senderName: msg.senderName ?? shortIdentity(msg.senderPubB64), deletedAt: now });
              if (list.length > 50) list = list.slice(0, 50);
              return JSON.stringify(list);
            });
            await deleteGroupMessage(msg.id, pid);
            // v4.32.232: удаление чистило только свою БД — у остальных
            // сообщение оставалось на месте.
            announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'del', msgId: msg.id }, myDisplayName));
            await loadMessages();
          })();
        },
      },
    ]);
  }, [myPubB64, amAdmin, pid, loadMessages, group.id, myDisplayName]);

  /**
   * Закрепляет или открепляет сообщение. Возвращает false, если прав не
   * хватило.
   *
   * v4.32.255: возвращаемое значение появилось из-за /pin и /unpin — они
   * вешали `.then(() => showSuccess('Сообщение закреплено'))`, а отказ в
   * правах выходил здесь обычным `return`, то есть промис успешно
   * разрешался. При отказе человек видел сразу два сообщения: «Нет прав»
   * и «Сообщение закреплено».
   */
  const pinMsg = useCallback(async (msg: { id: string }): Promise<boolean> => {
    const isAlreadyPinned = grpPinnedList.some((p) => p.id === msg.id) || pinnedMsgId === msg.id;
    // v4.32.233: закрепление уходило только в свой kv — у остальных участников
    // баннер не появлялся никогда. Право проверяется той же canPinInGroup,
    // что и на приёме (настройка «Закреплять могут все» + роль).
    // v4.32.453: отказ называется своей причиной, а не всегда «нет прав»: два
    // случая из трёх — незагруженный профиль и пропавшая группа, и совет
    // «попросите администратора» в них бесполезен.
    const res = await togglePinAndSync({
      groupId: group.id,
      msgId: msg.id,
      on: !isAlreadyPinned,
      actorName: myDisplayName,
    });
    if (!res.ok) {
      Alert.alert('AirChat', groupPinRefusalText(res.reason));
      return false;
    }
    announceCtl(res.sync);
    const newList = res.entries;
    setGrpPinnedList(newList);
    setGrpPinnedIdx(0);
    setPinnedMsgId(newList[0]?.id ?? null);
    setPinnedMsgText(newList[0]?.text ?? null);
    await insertGroupSysMessage(group.id, pid, myPubB64, isAlreadyPinned ? 'Сообщение откреплено' : 'Сообщение закреплено');
    return true;
  }, [grpPinnedList, pinnedMsgId, group.id, pid, myPubB64, myDisplayName, setPinnedMsgText]);

  const toggleGrpSelect = useCallback((item: GroupMessageRow) => {
    setSelectedGrpIds((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      return next;
    });
  }, []);

  const showMsgMenu = useCallback((item: GroupMessageRow) => {
    Vibration.vibrate(30);
    const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '👏'];
    const isOwn = item.senderPubB64 === myPubB64;
    const canEdit = (isOwn || amAdmin) && mayReuseMessageText(item) && !item.text.startsWith(POLL_PREFIX) && !isVoiceMessage(item.text) && !isDocMessage(item.text) && !isLocationMessage(item.text) && !isGroupSysMessage(item.text);
    const isSysMsg = isGroupSysMessage(item.text);
    // v4.32.559: у непрочитанного сообщения текста нет — есть пустая строка.
    // Копировать её, пересылать или подставлять в правку значит выдать пустоту
    // за содержимое ещё раз, теперь уже наружу.
    const isTextMsg = mayReuseMessageText(item) && !item.text.startsWith(POLL_PREFIX) && !isVoiceMessage(item.text) && !isDocMessage(item.text) && !isLocationMessage(item.text) && !isSysMsg;
    const canDelete = isOwn || amAdmin;
    const isStarred = Boolean(item.starred);
    const starLabel = isStarred ? 'Убрать из избранного' : 'В избранное';
    // v4.32.531: у обеих строк не было перехвата — отказ базы оставлял звезду
    // в прежнем виде и молча, а «отметить непрочитанным» не уводило с экрана,
    // хотя обещало именно это.
    const toggleStar = (): void => runGuardedOp(
      async () => {
        await setGroupMessageStarred(item.id, !isStarred);
        await loadMessages();
      },
      isStarred ? 'Не удалось убрать из избранного' : 'Не удалось добавить в избранное',
    );
    const markUnreadAndLeave = (): void => runGuardedOp(async () => {
      await markGroupUnread(group.id, pid);
      onBack();
    }, 'Не удалось отметить непрочитанным');
    const selectMsg = () => setSelectedGrpIds(new Set([item.id]));
    const isPollMsg = item.text.startsWith(POLL_PREFIX);
    const canClosePoll = isPollMsg && (isOwn || amAdmin);
    const closePoll = () => {
      Alert.alert('Завершить опрос?', 'Голосование будет закрыто, новые голоса не принимаются.', [
        // v4.32.251: завершение уходит участникам конвертом — раньше опрос
        // закрывался только на устройстве закрывшего, остальные продолжали
        // голосовать.
        // .catch: рассылка внутри уже переживает сбой сети сама, но запись
        // флага в хранилище — нет, и без обработчика отказ выглядел бы как
        // «ничего не произошло, и никто не сказал почему».
        // v4.32.446: «Опрос завершён» печаталось и тогда, когда конверт не ушёл
        // никому: у автора опрос закрыт, у участников открыт, и они спокойно
        // голосуют дальше. Теперь итог рассылки проговаривается.
        { text: 'Завершить', style: 'destructive', onPress: () => void closeAndSyncPoll({ msgId: item.id, myPubB64, groupId: group.id }).then((res) => { if (res.ok) showSuccess('Опрос завершён'); else showError(res.reason); }).catch(() => showError('Не удалось завершить опрос')) },
        { text: 'Отмена', style: 'cancel' },
      ]);
    };

    const msgLink = `airchat://group/${encodeURIComponent(group.id)}/msg/${encodeURIComponent(item.id)}`;
    const alreadyTranslated = grpManualTranslatedIds.has(item.id) && Boolean(translationCache[item.id]);
    const scheduleReminder = () => {
      const preview = item.text.startsWith('\x01') ? 'Медиасообщение' : isSysMsg ? parseGroupSysText(item.text) : item.text.slice(0, 40);
      promptMessageReminder(preview, showSuccess, showError);
    };
    // v4.32.335: одна копия на обе ветки меню (iOS и Android) — раньше их было
    // две, и проверять пришлось бы дважды. Проверка та же, что в пересылке:
    // sendMessage отвечает null, когда отправки не было (сам себе — часовой
    // лимит), а «Сохранено в избранное» показывалось в любом случае. Молчаливый
    // выход при отсутствии сервиса тоже убран: человек нажал и ждёт ответа.
    const saveToFavorites = () => {
      void (async () => {
        try {
          const svc = getMessagingService();
          const id = svc ? await svc.sendMessage(myPubB64, item.text) : null;
          if (id) showSuccess('Сохранено в избранное');
          else showError('Не удалось сохранить');
        } catch { showError('Не удалось сохранить'); }
      })();
    };
    const canTranslate = !isOwn && isTextMsg && !alreadyTranslated;
    /**
     * v4.32.366: ручной перевод отправлял текст группового сообщения на
     * сторонний сервис мимо выключателя «Облачный перевод» — тот проверял
     * только авто-перевод. В группе это ещё и чужие сообщения: согласие за
     * всех участников давал один человек одним тапом.
     */
    const translateMsg = () => {
      void (async () => {
        if (translationCache[item.id]) {
          setGrpManualTranslatedIds((prev) => new Set([...prev, item.id]));
          return;
        }
        const blocked = translateBlockReason(item.text ?? '');
        if (blocked) { showError(translateBlockMessage(blocked)); return; }
        if (!(await cloudTranslateAllowed())) {
          showError(CLOUD_TRANSLATE_OFF_MESSAGE);
          return;
        }
        const url = buildTranslateUrl(item.text, grpTranslateLang);
        if (!url) { showError('Не выбран язык перевода'); return; }
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 10_000);
        try {
          const res = await fetch(url, { signal: ctrl.signal });
          const out = parseTranslation(await res.json(), item.text);
          if (out.ok) {
            setTranslationCache((prev) => ({ ...prev, [item.id]: out.text }));
            setGrpManualTranslatedIds((prev) => new Set([...prev, item.id]));
          } else {
            showError(translateFailureMessage(out.reason));
          }
        } catch {
          showError('Ошибка перевода');
        } finally { clearTimeout(to); }
      })();
    };
    if (Platform.OS === 'ios') {
      const extra: string[] = [];
      if (isTextMsg) extra.push(COPY_ACTION);
      if (isTextMsg) extra.push('Переслать');
      if (isTextMsg && !isOwn) extra.push('В избранное');
      if (!isSysMsg) extra.push(COPY_LINK_ACTION);
      if (!isSysMsg) extra.push(starLabel);
      if (canTranslate) extra.push('Перевести');
      if (canPin) extra.push(grpPinnedList.some((p) => p.id === item.id) ? 'Открепить' : 'Закрепить');
      if (canEdit) extra.push('Редактировать');
      if (canClosePoll) extra.push('Завершить опрос');
      if (!isSysMsg) extra.push('Напомнить');
      if (!isOwn) extra.push('📩 Отметить непрочитанным');
      if (!isOwn && onOpenDm) extra.push('Написать в ЛС');
      extra.push('Сведения');
      if (canDelete) extra.push('Удалить');
      extra.push('Выбрать');
      const options = isSysMsg ? [...extra, 'Отмена'] : [...REACTION_EMOJIS, 'Ответить', ...extra, 'Отмена'];
      const cancelIdx = options.length - 1;
      // For system messages: no reactions or reply prefix; extra items start at index 0
      const replyIdx = isSysMsg ? -1 : REACTION_EMOJIS.length;
      const extraBase = isSysMsg ? 0 : REACTION_EMOJIS.length + 1; // after reactions+reply
      let offset = 0;
      const copyIdx = isTextMsg ? extraBase + offset++ : -1;
      const fwdIdx = isTextMsg ? extraBase + offset++ : -1;
      const favIdx = (isTextMsg && !isOwn) ? extraBase + offset++ : -1;
      const linkIdx = isSysMsg ? -1 : extraBase + offset++;
      const starIdx = isSysMsg ? -1 : extraBase + offset++;
      const translateIdx = canTranslate ? extraBase + offset++ : -1;
      const pinIdx = canPin ? extraBase + offset++ : -1;
      const editIdx = canEdit ? extraBase + offset++ : -1;
      const closeIdx = canClosePoll ? extraBase + offset++ : -1;
      const remindIdx = !isSysMsg ? extraBase + offset++ : -1;
      const markUnreadIdx = !isOwn ? extraBase + offset++ : -1;
      const dmIdx = (!isOwn && onOpenDm) ? extraBase + offset++ : -1;
      const infoIdx = extraBase + offset++;
      const delIdx = canDelete ? extraBase + offset++ : -1;
      const selIdx = extraBase + offset;
      ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: cancelIdx, destructiveButtonIndex: canDelete ? delIdx : undefined }, (i) => {
        if (!isSysMsg && i < REACTION_EMOJIS.length) void applyReaction(item, REACTION_EMOJIS[i]);
        else if (i === replyIdx) setReplyTo(item);
        else if (i === copyIdx) { Clipboard.setString(item.text); showSuccess(COPIED_TEXT); }
        else if (i === fwdIdx) setForwardText(makeForwardText(outwardName(item.senderName, item.senderUnreadable, shortIdentity(item.senderPubB64)), item.text));
        else if (i === favIdx) saveToFavorites();
        else if (i === linkIdx) { Clipboard.setString(msgLink); showSuccess(COPIED_LINK); }
        else if (i === starIdx) toggleStar();
        else if (i === translateIdx) translateMsg();
        else if (i === pinIdx) void pinMsg(item);
        else if (i === editIdx) startEdit(item);
        else if (i === closeIdx) closePoll();
        else if (i === remindIdx) scheduleReminder();
        else if (i === markUnreadIdx) markUnreadAndLeave();
        else if (i === dmIdx && onOpenDm) onOpenDm(item.senderPubB64, item.senderName ?? shortIdentity(item.senderPubB64));
        else if (i === infoIdx) setGrpMsgInfoTarget(item);
        else if (i === delIdx) deleteMsg(item);
        else if (i === selIdx) selectMsg();
      });
    } else {
      // v4.32.227 (BUG-09): меню действий с сообщением на Android через ActionSheet
      // (Alert обрезал список до 3 кнопок). Добавлены реакции сверху, как в iOS-ветке.
      openSheet('Сообщение', item.text.length > 60 ? item.text.slice(0, 60) + '…' : parseGroupSysText(item.text), [
        ...(isSysMsg ? [] : REACTION_EMOJIS.map((emoji) => ({ text: emoji, onPress: () => void applyReaction(item, emoji) }))),
        isSysMsg ? null : { text: 'Ответить', onPress: () => setReplyTo(item) },
        isTextMsg ? { text: COPY_ACTION, onPress: () => { Clipboard.setString(item.text); showSuccess(COPIED_TEXT); } } : null,
        canTranslate ? { text: '🌐 Перевести', onPress: translateMsg } : null,
        isTextMsg ? { text: 'Переслать', onPress: () => setForwardText(makeForwardText(outwardName(item.senderName, item.senderUnreadable, shortIdentity(item.senderPubB64)), item.text)) } : null,
        isTextMsg ? { text: 'Сохранить в Избранное', onPress: saveToFavorites } : null,
        isSysMsg ? null : { text: 'Напомнить', onPress: scheduleReminder },
        isSysMsg ? null : { text: COPY_LINK_ACTION, onPress: () => { Clipboard.setString(msgLink); showSuccess(COPIED_LINK); } },
        isSysMsg ? null : { text: starLabel, onPress: toggleStar },
        canPin ? { text: grpPinnedList.some((p) => p.id === item.id) ? 'Открепить' : 'Закрепить', onPress: () => void pinMsg(item) } : null,
        canEdit ? { text: 'Редактировать', onPress: () => startEdit(item) } : null,
        canClosePoll ? { text: 'Завершить опрос', onPress: closePoll } : null,
        { text: 'Сведения', onPress: () => setGrpMsgInfoTarget(item) },
        !isOwn ? { text: '📩 Отметить непрочитанным', onPress: markUnreadAndLeave } : null,
        canDelete ? { text: 'Удалить', style: 'destructive' as const, onPress: () => deleteMsg(item) } : null,
        { text: 'Выбрать', onPress: selectMsg },
        !isOwn && onOpenDm ? { text: 'Написать в ЛС', onPress: () => onOpenDm(item.senderPubB64, item.senderName ?? shortIdentity(item.senderPubB64)) } : null,
        { text: 'Отмена', style: 'cancel' as const },
      ]);
    }
  }, [applyReaction, openSheet, myPubB64, startEdit, amAdmin, canPin, pinMsg, deleteMsg, loadMessages, grpPinnedList, onOpenDm, onBack, group.id, pid, grpTranslateLang, translationCache, grpManualTranslatedIds, setTranslationCache, setGrpManualTranslatedIds, setGrpMsgInfoTarget]);

  const send = useCallback(() => {
    let t = textRef.current.trim();
    if (!t || sending) return;

    // ─── Fun slash commands (available to everyone) ──────────────────────
    if (t === '/dice' || t === '/кость') {
      const result = Math.floor(Math.random() * 6) + 1;
      const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
      t = `🎲 Кубик: ${faces[result - 1]} (${result})`;
      textRef.current = t;
      setText(t);
    } else if (t === '/coin' || t === '/монета') {
      t = `🪙 Монета: ${Math.random() < 0.5 ? 'Орёл' : 'Решка'}`;
      textRef.current = t;
      setText(t);
    } else if (t === '/magic' || t === '/шар') {
      const answers = ['Несомненно', 'Это точно', 'Без сомнений', 'Да', 'Скорее да', 'Не предсказуемо', 'Не уверен', 'Сомнительно', 'Нет', 'Определённо нет'];
      t = `🔮 Магический шар: ${answers[Math.floor(Math.random() * answers.length)]}`;
      textRef.current = t;
      setText(t);
    } else if (t === '/random' || t === '/рандом') {
      t = `🎰 Случайное число: ${Math.floor(Math.random() * 100)}`;
      textRef.current = t;
      setText(t);
    }
    // ─── Admin slash commands ────────────────────────────────────────────
    if (amAdmin && t.startsWith('/')) {
      const parts = t.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const argName = parts.slice(1).join(' ').replace(/^@/, '');
      /**
       * v4.32.255: раньше каждая команда искала цель сама —
       * `.find((m) => m.displayName.includes(arg))`, то есть по имени, которое
       * участник задаёт себе сам, и брала первое совпадение. Достаточно было
       * назваться «Аня Петрова» и оказаться в списке раньше настоящей Ани,
       * чтобы увести на себя `/kick`, `/ban` — или, наоборот, `/promote`, то
       * есть получить админа. Диалог подтверждения не спасал: в нём
       * показывалось имя найденного, то есть ровно та же подставная строка.
       * Теперь совпадения разрешает resolveMember, и неоднозначность не
       * «разрешается» вовсе — админа просят уточнить (в том числе хвостом
       * ключа, который подделать нельзя).
       */
      const pickMember = <T extends { peerPubB64: string; displayName: string | null }>(
        list: T[],
        notFound: string
      ): T | null => {
        const found = resolveMember(list, argName);
        if (found.kind === 'found') return found.member;
        Alert.alert(
          'AirChat',
          found.kind === 'ambiguous' ? ambiguityMessage(found.candidates) : notFound
        );
        return null;
      };
      /**
       * То же самое, но ещё и с проверкой, что роль позволяет тронуть именно
       * этого участника. Правило то же, что на приёме (groupModerationPolicy):
       * без него экран менял роль локально и рассылал конверт, который у всех
       * остальных отбрасывался, — расхождение, о котором никто не узнавал.
       */
      const pickTarget = <T extends { peerPubB64: string; displayName: string | null; role: GroupMemberRow['role'] }>(
        list: T[],
        notFound: string,
        /** Сообщение, если админ навёл команду на себя. */
        selfMessage = 'Эту команду нельзя применить к себе.'
      ): T | null => {
        const member = pickMember(list, notFound);
        if (!member) return null;
        // Про себя отвечаем раньше проверки роли: иначе админ, набравший
        // /kick на себе, получал бы «действие с другим администратором
        // доступно только владельцу» — формально верно, по смыслу мимо.
        if (member.peerPubB64 === myPubB64) { Alert.alert('AirChat', selfMessage); return null; }
        const verdict = canModerate(myRole, member.role);
        if (!verdict.allowed) { Alert.alert('Недостаточно прав', verdict.reason); return null; }
        return member;
      };
      /**
       * Смена роли: локальная запись, системная строка, тост и рассылка — одним
       * куском. v4.32.257: /promote и /demote делали это каждая по-своему, без
       * .catch (при отказе БД экран молчал), а /demote к тому же переводил в
       * 'member' участника с ограничением, объявляя это снятием админских прав.
       */
      const applyRoleChange = (target: GroupMemberRow, next: AssignableRole) => {
        const prevRole = target.role;
        const label = target.displayName ?? argName;
        const line = roleChangeSysText(next, prevRole, label, false);
        void updateGroupMemberRole(group.id, target.peerPubB64, next, pid).then(async () => {
          // Порядок тот же, что даёт база: повышенный участник переезжает к
          // администраторам сразу, а не при следующем открытии группы.
          setAllMembers((prev) => sortMembersByRole(prev.map((m) => m.peerPubB64 === target.peerPubB64 ? { ...m, role: next } : m)));
          showSuccess(line);
          await insertGroupSysMessage(group.id, pid, myPubB64, line);
          announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'role', target: target.peerPubB64, role: next, targetName: label }, myDisplayName));
        }).catch(() => showError('Не удалось изменить роль'));
      };
      if (cmd === '/help' || cmd === '/команды') {
        setText('');
        Alert.alert(
          'Команды администратора',
          '/kick @имя — исключить участника (сможет вернуться)\n/ban @имя — заблокировать участника\n/unban @имя — снять блокировку\n/promote @имя — назначить администратором\n/demote @имя — снять администратора\n/mute @имя — запретить писать (останется в группе и будет читать)\n/unmute @имя — снять ограничение\n/slowmode <сек> — установить медленный режим\n/pin — закрепить последнее сообщение\n/unpin — открепить\n/readonly — писать могут только администраторы\n/open — вернуть право писать всем\n\nИмена участники задают себе сами и могут совпадать. Если совпало несколько, укажите вместо имени последние 8 символов ключа — они видны в карточке участника.'
        );
        return;
      }
      if (cmd === '/kick' && argName) {
        setText('');
        const target = pickTarget(allMembers, `Участник «${argName}» не найден`, 'Нельзя исключить себя');
        if (!target) return;
        Alert.alert(`Исключить ${target.displayName ?? argName}?`, 'Сможет вернуться по приглашению.', [
          { text: 'Отмена', style: 'cancel' },
          {
            text: 'Исключить',
            style: 'destructive',
            onPress: () => {
              void removeGroupMember(group.id, target.peerPubB64, pid).then(async () => {
                await recountGroupMembers(group.id, pid);
                await insertGroupSysMessage(group.id, pid, myPubB64, `${target.displayName ?? argName} исключён(а) из группы`);
                announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'kick', target: target.peerPubB64, targetName: target.displayName ?? argName }, myDisplayName));
                setAllMembers((prev) => prev.filter((m) => m.peerPubB64 !== target.peerPubB64));
                showSuccess(`${target.displayName ?? argName} исключён`);
              // v4.32.514: без .catch отказ базы оставлял экран немым —
              // участник на месте, ни строки, ни тоста, ни ошибки. Смена роли
              // об этом говорила с v4.32.257, исключение и бан — нет.
              }).catch(() => showError('Не удалось исключить участника'));
            },
          },
        ]);
        return;
      }
      /**
       * v4.32.230: /ban раньше был просто синонимом /kick — вызывал
       * removeGroupMember, т.е. удалял строку участника. Из-за этого весь
       * механизм банов в groupMessaging.ts (не рассылать забаненным — :91,
       * дропать их входящие — :266) был недостижим: role='banned' не выставлял
       * никто, а «забаненный» возвращался по любой ссылке-приглашению.
       * Теперь бан сохраняет строку участника с role='banned' — она и есть
       * чёрный список группы.
       */
      if (cmd === '/ban' && argName) {
        setText('');
        const target = pickTarget(allMembers, `Участник «${argName}» не найден`, 'Нельзя заблокировать себя');
        if (!target) return;
        Alert.alert(`Заблокировать ${target.displayName ?? argName}?`, 'Не сможет читать и писать в группу, вернуть — /unban.', [
          { text: 'Отмена', style: 'cancel' },
          {
            text: 'Заблокировать',
            style: 'destructive',
            onPress: () => {
              void updateGroupMemberRole(group.id, target.peerPubB64, 'banned', pid).then(async () => {
                await recountGroupMembers(group.id, pid);
                await insertGroupSysMessage(group.id, pid, myPubB64, `${target.displayName ?? argName} заблокирован(а) в группе`);
                announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'ban', target: target.peerPubB64, targetName: target.displayName ?? argName }, myDisplayName));
                setAllMembers((prev) => prev.filter((m) => m.peerPubB64 !== target.peerPubB64));
                showSuccess(`${target.displayName ?? argName} заблокирован`);
              }).catch(() => showError('Не удалось заблокировать участника'));
            },
          },
        ]);
        return;
      }
      if (cmd === '/unban' && argName) {
        setText('');
        // Забаненных нет в allMembers (они отфильтрованы), поэтому ищем в БД.
        void (async () => {
          const all = await listGroupMembers(group.id, pid);
          const target = pickTarget(
            all.filter((m) => m.role === 'banned'),
            `Заблокированный участник «${argName}» не найден`
          );
          if (!target) return;
          const name = target.displayName ?? argName;
          Alert.alert(`Разблокировать ${name}?`, '', [
            { text: 'Отмена', style: 'cancel' },
            {
              text: 'Разблокировать',
              onPress: () => {
                void updateGroupMemberRole(group.id, target.peerPubB64, 'member', pid).then(async () => {
                  await recountGroupMembers(group.id, pid);
                  await insertGroupSysMessage(group.id, pid, myPubB64, `${name} разблокирован(а)`);
                  announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'unban', target: target.peerPubB64, targetName: name }, myDisplayName));
                  setAllMembers((prev) => prev.some((m) => m.peerPubB64 === target.peerPubB64) ? prev : sortMembersByRole([...prev, { ...target, role: 'member' }]));
                  showSuccess(`${name} разблокирован`);
                }).catch(() => showError('Не удалось разблокировать участника'));
              },
            },
          ]);
        })();
        return;
      }
      if (cmd === '/promote' && argName) {
        setText('');
        const target = pickTarget(allMembers, `Участник «${argName}» не найден`);
        if (!target) return;
        // v4.32.514: раньше вопрос «а есть ли что менять» задавал только
        // /mute. Повторное назначение писало системную строку и слало
        // конверт, который каждый получатель отбрасывал как повтор, — и
        // строка оставалась только в одной истории из всех.
        const already = roleChangeNoopText('admin', target.role, target.displayName ?? argName);
        if (already) { Alert.alert('AirChat', already); return; }
        // /kick и /ban спрашивают подтверждение, а выдача админки — нет,
        // хотя из всех команд она самая необратимая: новый админ и сам может
        // раздавать роли. В заголовке — memberLabel, то есть имя вместе с
        // хвостом ключа: имя не уникально, ключ уникален.
        Alert.alert(`Назначить администратором?`, `${memberLabel(target)}\n\nСможет исключать участников и назначать других администраторов.`, [
          { text: 'Отмена', style: 'cancel' },
          {
            text: 'Назначить',
            onPress: () => applyRoleChange(target, 'admin'),
          },
        ]);
        return;
      }
      if (cmd === '/demote' && argName) {
        setText('');
        const target = pickTarget(allMembers, `Участник «${argName}» не найден`);
        if (!target) return;
        // v4.32.514: /demote на обычном участнике объявлял снятие должности,
        // которую тот не занимал, — и объявлял это в одной истории из всех.
        const already = roleChangeNoopText('member', target.role, target.displayName ?? argName);
        if (already) { Alert.alert('AirChat', already); return; }
        applyRoleChange(target, 'member');
        return;
      }
      if (cmd === '/mute' && argName) {
        setText('');
        const target = pickTarget(allMembers, `Участник «${argName}» не найден`, 'Нельзя ограничить себя');
        if (!target) return;
        // v4.32.514: та же проверка, что у /promote и /demote. Здесь она
        // стояла с самого начала, но написанная на месте — второй такой
        // формулировке разойтись с первой ничего не мешало.
        const already = roleChangeNoopText('restricted', target.role, target.displayName ?? argName);
        if (already) { Alert.alert('AirChat', already); return; }
        applyRoleChange(target, 'restricted');
        return;
      }
      if (cmd === '/unmute' && argName) {
        setText('');
        const target = pickTarget(allMembers.filter((m) => m.role === 'restricted'), `Ограниченный участник «${argName}» не найден`);
        if (!target) return;
        applyRoleChange(target, 'member');
        return;
      }
      if (cmd === '/slowmode') {
        setText('');
        const secs = parseInt(parts[1] ?? '0', 10);
        if (isNaN(secs) || secs < 0) { Alert.alert('AirChat', 'Укажите количество секунд: /slowmode 30'); return; }
        if (secs > MAX_SLOWMODE_SECONDS) { Alert.alert('AirChat', 'Максимальная задержка — 86400 секунд (сутки).'); return; }
        // v4.32.265: команда повторяла applySlowMode, но без системной строки —
        // в истории не оставалось следа, что режим включили, хотя тот же пункт
        // меню строку писал, а получатели её получали в любом случае.
        runGuardedOp(async () => { showSuccess(await applySlowMode(secs)); }, 'Не удалось изменить медленный режим');
        return;
      }
      if (cmd === '/pin') {
        setText('');
        const lastMsg = messages[0];
        if (!lastMsg) return;
        void pinMsg(lastMsg)
          .then((ok) => { if (ok) showSuccess('Сообщение закреплено'); })
          .catch(() => showError('Не удалось закрепить сообщение'));
        return;
      }
      if (cmd === '/unpin') {
        setText('');
        // Открепляем верхнее: /unpin без аргумента снимает то, что показано в баннере.
        const top = grpPinnedList[0];
        if (!top) { setPinnedMsgId(null); setPinnedMsgText(null); return; }
        void pinMsg({ id: top.id })
          .then((ok) => { if (ok) showSuccess('Сообщение откреплено'); })
          .catch(() => showError('Не удалось открепить сообщение'));
        return;
      }
      if (cmd === '/readonly' || cmd === '/open') {
        setText('');
        const onlyAdmins = cmd === '/readonly';
        // v4.32.257: обе команды не записывали системную строку, хотя тот же
        // переключатель в меню группы её пишет, а получатели её получают. У
        // включившего в истории не оставалось следа, когда режим сменился.
        // v4.32.531: команда была пятой копией того же переключателя — со
        // своими словами («Чат открыт для всех участников» против «Писать
        // могут все»), так что два способа сделать одно и то же оставляли в
        // истории разные строки. Команда задаёт значение, а не переключает,
        // поэтому совпадение с текущим состоянием — просто подтверждение.
        if (adminOnlyPosting === onlyAdmins) {
          showSuccess(groupFlagCopy('adminOnlyPosting', !onlyAdmins).success);
          return;
        }
        toggleGroupFlag('adminOnlyPosting', adminOnlyPosting, setAdminOnlyPosting);
        return;
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // Право на отправку. Композер уже скрыт, когда писать нельзя, но состояние
    // могло разъехаться с БД (бан или «только для админов» приехали, пока экран
    // открыт) — а fanout всё равно откажет, и сообщение осталось бы висеть
    // только у отправителя.
    if (!sendVerdict.allowed) {
      Alert.alert('AirChat', sendVerdict.reason);
      return;
    }
    // Slow mode check — администрация медленным режимом не ограничена
    // (раньше ограничивалась: проверка не смотрела на роль).
    if (!editingMsg) {
      const remaining = slowModeRemaining({
        role: myRole,
        slowModeSeconds,
        lastSentAt: lastSentRef.current,
        now: Date.now(),
      });
      if (remaining > 0) {
        Alert.alert('Медленный режим', `Подождите ещё ${remaining} сек перед следующим сообщением.`);
        return;
      }
    }
    // Edit existing message
    if (editingMsg) {
      const orig = editingMsg;
      setText('');
      textRef.current = '';
      setEditingMsg(null);
      // v4.32.530: черновик снимался только на обычной отправке. Правка
      // оставляла отложенную запись висеть, и через 600 мс уже отправленный
      // текст ложился в черновик группы — при следующем входе поле ввода было
      // заполнено тем, что человек только что сохранил.
      clearGroupDraft();
      setSending(true);
      void (async () => {
        try {
          // v4.32.530: рассылка идёт только за успешной локальной записью.
          // Прежде здесь стоял .then().finally() без .catch, а сама запись
          // глотала свою ошибку — правка уходила всей группе даже тогда,
          // когда в собственной базе ничего не изменилось.
          const applied = await updateGroupMessageText(orig.id, t, pid);
          if (!applied) {
            showError('Не удалось сохранить правку');
            setText(t);
            textRef.current = t;
            setEditingMsg(orig);
            return;
          }
          // v4.32.232: правка жила только в локальной БД — у остальных
          // участников оставался исходный текст.
          announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'edit', msgId: orig.id, text: t }, myDisplayName));
          await loadMessages();
        } catch (e) {
          showError(userErrorText(e, 'Не удалось сохранить правку'));
        } finally {
          setSending(false);
        }
      })();
      return;
    }
    Vibration.vibrate(8);
    const effectParticles = detectSendEffect(t);
    if (effectParticles) setSendEffectParticles(effectParticles);
    setText('');
    textRef.current = '';
    setCmdFilter(null);
    // Отложенный текст снимается вместе с таймером: иначе flushGroupDraft
    // вернул бы уже отправленное сообщение обратно в поле ввода.
    clearGroupDraft();
    if (grpComposeLinkTimerRef.current) clearTimeout(grpComposeLinkTimerRef.current);
    setGrpComposeLinkUrl(null);
    setGrpComposeLinkDismissed(null);
    const replyRef = replyTo;
    setReplyTo(null);
    setSending(true);
    void (async () => {
      try {
        const newMsgId = uuidv4();
        lastSentMsgIdRef.current = newMsgId;
        const row: GroupMessageRow = {
          id: newMsgId,
          groupId: group.id,
          senderPubB64: myPubB64,
          senderName: myDisplayName,
          text: t,
          mediaCids: null,
          replyToId: replyRef?.id ?? null,
          replyToPreview: truncateReplyPreview(replyRef?.text),
          reactions: null,
          createdAt: Date.now(),
          ownerProfileId: pid,
        };
        await insertGroupMessage(row);
        await touchGroupConversation(group.id, pid, t.slice(0, 120), false, myDisplayName, false, myPubB64);
        // Рассылка участникам. Ответа не ждём, но и не выбрасываем: строка
        // уже в переписке, и отказ обязан быть назван (v4.32.450).
        announceGroupSend(
          fanoutGroupMessage(group.id, t, myDisplayName, myPubB64, row.id, undefined, {
            id: row.replyToId,
            preview: row.replyToPreview,
          })
        );
        await loadMessages();
        // Отсчёт медленного режима. Отметка пишется в kv, а не только в ref:
        // иначе задержка снималась выходом из чата и повторным входом.
        if (slowModeSeconds > 0) {
          const sentAt = Date.now();
          await scopedKvSet(slowKey, String(sentAt));
          startSlowCooldown(sentAt);
        }
      } catch (e) {
        showError(userErrorText(e, 'Не удалось отправить сообщение'));
        setText(t);
        setReplyTo(replyRef);
      } finally {
        setSending(false);
      }
    })();
  }, [sending, editingMsg, replyTo, group.id, myPubB64, pid, loadMessages, myDisplayName, slowModeSeconds, amAdmin, allMembers, messages, pinMsg, grpPinnedList, myRole, sendVerdict, applySlowMode, slowKey, startSlowCooldown, clearGroupDraft, adminOnlyPosting, toggleGroupFlag, setPinnedMsgText]);

  const displayGroupMessages = useMemo((): GrpListItem[] => {
    if (searchResults) return searchResults;
    return injectGrpDateSeparators(messages, grpOpenUnread);
  }, [messages, searchResults, grpOpenUnread]);

  /**
   * Тексты сообщений группы по id — чтобы цитата показывала свою копию
   * оригинала. Карта строится один раз на список: поиск перебором внутри
   * отрисовки строки означал бы полный проход по ленте на каждое сообщение.
   */
  const grpMessageTextById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) map.set(m.id, m.text);
    return map;
  }, [messages]);

  // Wrap each message bubble with swipe gestures:
  //   right-swipe (dx > 50) → reply
  //   left-swipe (dx < -50) → star/unstar
  const GrpSwipeRow = useCallback(
    ({ item, children }: { item: GroupMessageRow; children: React.ReactNode }) => {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const swipeAnim = useRef(new RNAnimated.Value(0)).current;
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const panResponder = useRef(
        PanResponder.create({
          onMoveShouldSetPanResponder: (_, g) =>
            Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
          onPanResponderMove: (_, g) => {
            if (g.dx > 0 && g.dx < 80) swipeAnim.setValue(g.dx);
            else if (g.dx < 0 && g.dx > -80) swipeAnim.setValue(g.dx);
          },
          onPanResponderRelease: (_, g) => {
            if (g.dx > 50) {
              Vibration.vibrate(20);
              setReplyTo(item);
            } else if (g.dx < -50) {
              Vibration.vibrate(20);
              const next = !item.starred;
              runGuardedOp(async () => {
                await setGroupMessageStarred(item.id, next);
                await loadMessages();
              }, next ? 'Не удалось добавить в избранное' : 'Не удалось убрать из избранного');
            }
            RNAnimated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
          },
          onPanResponderTerminate: () => {
            RNAnimated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
          },
        })
      ).current;
      return (
        <RNAnimated.View style={{ transform: [{ translateX: swipeAnim }] }} {...panResponder.panHandlers}>
          {children}
        </RNAnimated.View>
      );
    },
    [setReplyTo, loadMessages]
  );

  const scrollToReply = useCallback((replyToId: string) => {
    const list = displayGroupMessages;
    const idx = list.findIndex((it) => {
      const t = (it as GrpDateSepItem).type;
      if (t === 'date_sep' || t === 'unread_sep') return false;
      return (it as GroupMessageRow).id === replyToId;
    });
    if (idx < 0) return;
    try {
      groupFlashRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
      setJumpHighlightId(replyToId);
      jumpHighlightAnim.setValue(1);
      RNAnimated.timing(jumpHighlightAnim, {
        toValue: 0,
        duration: 1400,
        delay: 300,
        useNativeDriver: false,
      }).start(() => setJumpHighlightId(null));
    } catch { /* ignore */ }
  }, [displayGroupMessages, jumpHighlightAnim]);

  const closePinnedList = useCallback(() => setGrpPinnedListVisible(false), []);
  const handlePinnedJumpTo = useCallback((id: string, idx: number) => {
    scrollToReply(id);
    setGrpPinnedIdx(idx);
    setGrpPinnedListVisible(false);
  }, [scrollToReply]);
  const handlePinnedUnpin = useCallback((pinId: string) => {
    void (async () => {
      // v4.32.233: открепление тоже уходит остальным, а не только в свой kv.
      const res = await togglePinAndSync({ groupId: group.id, msgId: pinId, on: false, actorName: myDisplayName });
      if (!res.ok) { Alert.alert('AirChat', groupPinRefusalText(res.reason)); return; }
      announceCtl(res.sync);
      const newList = res.entries;
      setGrpPinnedList(newList);
      if (newList.length === 0) {
        setPinnedMsgId(null); setPinnedMsgText(null);
        setGrpPinnedListVisible(false);
      } else {
        setPinnedMsgId(newList[0].id); setPinnedMsgText(newList[0].text);
        setGrpPinnedIdx(0);
      }
    })();
  }, [group.id, myDisplayName, setPinnedMsgText]);

  const renderMsgImpl = ({ item: rawItem, index }: { item: GrpListItem; index: number }) => {
    // Consecutive grouping: hide sender name/avatar if same sender within 5 minutes
    // (List is inverted, so index+1 is visually above = earlier/older message)
    const prevRaw = displayGroupMessages[index + 1];
    const prevMsg = prevRaw && !('type' in prevRaw) ? prevRaw as GroupMessageRow : null;
    const msgRow = !('type' in rawItem) ? rawItem as GroupMessageRow : null;
    const isConsecutive = !!(msgRow && prevMsg &&
      prevMsg.senderPubB64 === msgRow.senderPubB64 &&
      msgRow.createdAt - prevMsg.createdAt < 5 * 60_000 &&
      !isGroupSysMessage(msgRow.text) &&
      !isGroupSysMessage(prevMsg.text));

    if ((rawItem as GrpUnreadSepItem).type === 'unread_sep') {
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 16, gap: 10 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.accent }} />
          <View style={{ backgroundColor: activeTint.fill, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.accent }}>
            <Text style={{ color: activeTint.ink, fontSize: 12, fontWeight: '600' }}>
              {grpOpenUnread} непрочитанных
            </Text>
          </View>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.accent }} />
        </View>
      );
    }
    if ((rawItem as GrpDateSepItem).type === 'date_sep') {
      const sep = rawItem as GrpDateSepItem;
      return (
        <AppPressable
          style={{ alignItems: 'center', paddingVertical: 6 }}
          onLongPress={() => {
            const now = Date.now();
            const periods = [
              { label: 'Начало разговора', ts: 0 },
              { label: 'Год назад', ts: now - 365 * 86_400_000 },
              { label: '6 месяцев назад', ts: now - 180 * 86_400_000 },
              { label: '3 месяца назад', ts: now - 90 * 86_400_000 },
              { label: 'Месяц назад', ts: now - 30 * 86_400_000 },
              { label: 'Неделю назад', ts: now - 7 * 86_400_000 },
            ];
            Alert.alert(
              'Перейти к дате',
              'Выберите период:',
              [
                ...periods.map(({ label, ts }) => ({
                  text: label,
                  onPress: () => {
                    // Find the message with timestamp closest to ts (but not older than messages[0])
                    const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
                    if (sorted.length === 0) return;
                    const target = ts === 0
                      ? sorted[0]
                      : sorted.reduce((prev, curr) =>
                          Math.abs(curr.createdAt - ts) < Math.abs(prev.createdAt - ts) ? curr : prev
                        );
                    void scrollToReply(target.id);
                  },
                })),
                { text: 'Отмена', style: 'cancel' },
              ]
            );
          }}
        >
          {/* v4.32.410: та же плашка, что у системного события ниже, — серый
              25% поверх обоев с надписью из палитры остался только здесь. */}
          <View style={{ backgroundColor: feed.quiet.fill, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4 }}>
            <Text style={{ color: feed.quiet.ink.secondary, fontSize: 12, fontWeight: '500' }}>{sep.label}</Text>
          </View>
        </AppPressable>
      );
    }
    const item = rawItem as GroupMessageRow;

    // Блок цитаты в группах лежит НЕ в пузыре, а на фоне ленты — и фон этот
    // выбирает пользователь (обои). Отсчёт от него, а не от палитры
    // (v4.32.387; с 410-го правило общее с личной перепиской, см. feedGround).
    const quoteFill = feed.quiet.fill;
    const quoteInk = feed.quiet.ink;

    // System event message (join/leave/etc.) — render as centered label
    if (isGroupSysMessage(item.text)) {
      // v4.32.398: плашка была залита 'rgba(128,128,128,0.18)' — серым поверх
      // чего угодно, включая выбранные пользователем обои, — а надпись бралась
      // из палитры. Это тот же вложенный блок, что и цитата: заливка от фона
      // ленты, чернила от заливки.
      return (
        <View style={{ alignItems: 'center', paddingVertical: 4, paddingHorizontal: 16 }}>
          <View style={{ backgroundColor: quoteFill, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4 }}>
            <Text style={{ color: quoteInk.secondary, fontSize: 12, textAlign: 'center' }}>{parseGroupSysText(item.text)}</Text>
          </View>
        </View>
      );
    }

    const isMe = item.senderPubB64 === myPubB64;
    // Исходящий пузырь в группе залит `primary` — цветом из настроек, а не
    // `bubbleOut`, — поэтому и чернила в нём считаются от `primary`
    // (v4.32.398, см. primaryInk).
    const meInk = primaryInk(colors);
    // Маркер найденного считается от ЗАЛИВКИ ПУЗЫРЯ, а не от палитры
    // (v4.32.420). Раньше здесь стояло `colors.star` как есть: в светлой теме
    // на своём пузыре (#0068D6) это 1.33:1 — найденное слово подсвечивалось
    // цветом, которого не видно. `searchMark` сохраняет тон и поднимает
    // светлоту до 3:1 — 3.04 на своём пузыре, 3.36 на чужом.
    const grpMark = searchMark(colors, isMe ? colors.primary : colors.surface);
    // Плитка, вложенная в пузырь: плёнка «один просмотр», ячейка фотосетки,
    // разделитель. Сначала заливка от пузыря, потом чернила от заливки
    // (v4.32.395) — иначе на светлом акценте плитка сливается с пузырём.
    const meTile = nestedFill(colors.primary);
    const meTileInk = inkOn(colors, meTile, contrastingInk(meTile));
    // v4.32.182 (Round-12 #1): guard JSON.parse — a single corrupted row
    // would otherwise crash the entire Groups tab render.
    // v4.32.184 (Round-14 #3): exclude null / array / primitive from parse.
    // v4.32.509: разбор переехал в core/social/reactionMapPolicy — он был
    // выписан шестью копиями, и половина из них верила, что значение по
    // эмодзи это массив строк.
    const reactEntries = Object.entries(parseReactionMap(item.reactions));
    // v4.32.299: текст цитаты берётся из своей же ленты, а присланное превью
    // остаётся запасным вариантом — ровно как в личных чатах. Своя копия
    // всегда вернее: она не расходится с оригиналом после правки и не зависит
    // от того, что написал в превью отправитель. Присланное нужно тогда, когда
    // цитируемого сообщения у нас нет: ответ обогнал ответ на него при
    // рассылке, или он пришёл до вступления в группу.
    // v4.32.598: см. ChatScreen — непрочитанная цитата не выдаётся за
    // сообщение, которое ни на что не отвечало.
    const replyQuote = quoteView(
      item.replyToId ? grpMessageTextById.get(item.replyToId) : null,
      item.replyToPreview,
      item.replyToPreviewUnreadable
    );
    const replyPreview = replyQuote.text;
    const isHighlighted = jumpHighlightId === item.id;
    const isMentioned = !isMe && isMentionOf(item.text ?? '', myDisplayName);
    const isSelectedMsg = selectedGrpIds.has(item.id);
    const highlightBgColor = isHighlighted
      // v4.32.414: янтарь вспышки был вписан руками — той самой копией
      // старого значения звезды, ради которой в 401-м и появился rowMark.
      // Личные чаты перешли на него тогда же, группы — остались на литерале.
      ? jumpHighlightAnim.interpolate({ inputRange: [0, 1], outputRange: [rowMark(colors, 'found', 0), rowMark(colors, 'found', 0.35)] })
      : null;
    return (
      <GrpSwipeRow item={item}>
      <AppPressable
        onLongPress={() => isGrpSelecting ? toggleGrpSelect(item) : (Platform.OS === 'ios' ? showMsgMenu(item) : setQuickReact(item))}
        onPress={() => {
          if (isGrpSelecting) { toggleGrpSelect(item); return; }
          const now = Date.now();
          const last = lastTapMapRef.current.get(item.id) ?? 0;
          if (now - last < 320) {
            lastTapMapRef.current.delete(item.id);
            void applyReaction(item, '❤️');
          } else {
            lastTapMapRef.current.set(item.id, now);
          }
        }}
        style={[gcStyles.msgWrap, isMe ? gcStyles.msgOut : gcStyles.msgIn, isConsecutive ? { paddingVertical: 1 } : null, isMentioned ? { borderLeftWidth: 3, borderLeftColor: colors.primary, paddingLeft: 6 } : null, isSelectedMsg ? { backgroundColor: activeTint.fill } : null]}
      >
        {isGrpSelecting ? (
          <View style={{ position: 'absolute', left: isMe ? undefined : -28, right: isMe ? -28 : undefined, top: '50%', marginTop: -11 }}>
            <View style={[gcStyles.selCircle, isSelectedMsg ? { backgroundColor: colors.primary, borderColor: colors.primary } : { borderColor: colors.textMuted }]}>
              {isSelectedMsg ? <Ionicons name="checkmark" size={13} color={contrastingInk(colors.primary)} /> : null}
            </View>
          </View>
        ) : null}
        {!isMe && !anonymousPosting && !isGroupSysMessage(item.text) && !isConsecutive ? (
          <AppPressable onPress={() => {
            const member = allMembers.find((m) => m.peerPubB64 === item.senderPubB64);
            if (member) {
              insertMention(member);
            }
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              {/* v4.32.399: и кружок, и имя выводятся из КЛЮЧА отправителя —
                  раньше кружок здесь считался от имени, а тот же кружок в
                  списке участников от ключа: один человек, два цвета. */}
              <GrpSenderAvatar name={item.senderName ?? shortIdentity(item.senderPubB64)} seed={item.senderPubB64} size={26} />
              {/* v4.32.593: непрочитанное имя больше не притворяется
                  безымянным отправителем. Знак вопроса стоял и там, где имени
                  нет вовсе, и там, где оно есть, но ключ его не открыл. */}
              <Text
                style={[
                  gcStyles.senderName,
                  { color: item.senderUnreadable ? colors.warning : identityInk(item.senderPubB64, colors.surface) },
                ]}
              >
                {shownName(item.senderName, item.senderUnreadable, shortIdentity(item.senderPubB64))}
              </Text>
              {(() => {
                const senderMember = allMembers.find((m) => m.peerPubB64 === item.senderPubB64);
                // v4.32.257: подписи ролей здесь были свои («создатель» вместо
                // «Владелец» в списке участников), а неизвестная роль печаталась
                // как есть — с появлением 'restricted' рядом с именем возникло
                // бы английское «restricted».
                const label = roleLabel(senderMember?.role);
                if (!label) return null;
                // v4.32.383: цвет роли — тоже из groupRolePolicy, рядом с
                // подписью. Здесь была своя таблица с '#f9a825' мимо палитры
                // (в светлой теме 1.9:1) и с `primary` — токеном заливки, а не
                // текста.
                const tone = roleTone(senderMember?.role);
                return (
                  <Text style={{ fontSize: 10, color: tone ? colors[tone] : colors.textMuted, fontWeight: '500' }}>
                    {label.toLowerCase()}
                  </Text>
                );
              })()}
            </View>
          </AppPressable>
        ) : null}
        {item.replyToId && (replyPreview !== null || replyQuote.unreadable) ? (
          <AppPressable
            style={[gcStyles.quotedBlock, { alignSelf: isMe ? 'flex-end' : 'flex-start', backgroundColor: quoteFill }]}
            onPress={() => item.replyToId && scrollToReply(item.replyToId)}
            hitSlop={4}
          >
            <View style={[gcStyles.quotedBar, { backgroundColor: quoteInk.accent }]} />
            <Text
              style={[
                gcStyles.quotedText,
                replyPreview === null
                  ? { color: colors.warning, fontStyle: 'italic' }
                  : { color: quoteInk.secondary },
              ]}
              numberOfLines={2}
            >
              {replyPreview === null ? UNREADABLE_QUOTE_TEXT
                : isVoiceMessage(replyPreview) ? '🎤 Голосовое сообщение'
                : isDocMessage(replyPreview) ? '📄 Документ'
                : isLocationMessage(replyPreview) ? '📍 Геолокация'
                : isGifMessage(replyPreview) ? '🎞 GIF'
                : replyPreview.startsWith(POLL_PREFIX) ? '📊 Опрос'
                : replyPreview.startsWith('\x09vo:') ? '🔥 Одноразовое сообщение'
                : replyPreview.startsWith('\x0cliveloc:') ? '📡 Живая геолокация'
                : isGroupSysMessage(replyPreview) ? parseGroupSysText(replyPreview)
                : replyPreview}
            </Text>
          </AppPressable>
        ) : null}
        <View style={[gcStyles.bubble, { backgroundColor: (!item.mediaCids && !item.text.startsWith(POLL_PREFIX) && !isVoiceMessage(item.text) && !isDocMessage(item.text) && !isLocationMessage(item.text) && !item.replyToId && isGrpBigEmoji(item.text)) ? 'transparent' : (isMe ? colors.primary : colors.surface), padding: item.mediaCids ? 0 : undefined, overflow: 'hidden' }]}>
          {/* v4.32.244: раньше здесь требовался ещё и адрес шлюза — без него
              пузырь с фотографией молча превращался в пустой текст. Снимок,
              приехавший зашифрованным вложением, шлюза не требует. */}
          {/* v4.32.597: см. ChatScreen — непрочитанный список вложений не
              выдаётся за сообщение без вложений. */}
          {item.mediaUnreadable ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 }}>
              <Ionicons name="image-outline" size={14} color={colors.warning} style={{ marginRight: 4 }} />
              <Text style={{ fontSize: 13, color: colors.warning, fontStyle: 'italic' }}>{UNREADABLE_MEDIA_TEXT}</Text>
            </View>
          ) : item.mediaCids ? (
            item.text && item.text.startsWith('\x09vo:') ? (
              <AppPressable
                style={{ alignItems: 'center', justifyContent: 'center', width: 220, height: 120, borderRadius: 12, backgroundColor: isMe ? meTile : colors.surfaceHigh, margin: 4 }}
                onPress={() => handleGrpViewOnceTap(item)}
              >
                <Ionicons name="eye-outline" size={30} color={isMe ? meTileInk.muted : colors.textMuted} />
                <Text style={{ color: isMe ? meTileInk.secondary : colors.textSecondary, fontSize: 13, marginTop: 6, fontWeight: '500' }}>
                  {isMe ? 'Один просмотр' : 'Нажмите, чтобы открыть'}
                </Text>
              </AppPressable>
            ) : (
              // v4.32.244: сетку рисует общий компонент — он понимает и адреса
              // шлюза, и зашифрованные вложения (`nb:`), которыми фотография
              // приходит, когда своего IPFS-сервера нет.
              // v4.32.243: CID приходит от участника группы, а картинка
              // грузится сама при отрисовке — '../' в «CID» уводил загрузку на
              // чужой сервер и выдавал IP-адрес получателя. Адрес собирает
              // core/media/gatewayUrl, негодные CID просто отпадают.
              <View>
                <GroupPhotoGrid
                  mediaCids={item.mediaCids}
                  gateway={gateway}
                  onOpen={(urls, index) => grpMediaViewer.open(urls, index)}
                  tileBackground={isMe ? meTile : colors.surfaceHigh}
                  mutedColor={isMe ? meTileInk.muted : colors.textMuted}
                />
                {isUnreadableMessage(item) ? (
                  // v4.32.559: подпись к снимку не прочиталась — молчать об
                  // этом значит выдать её за ненаписанную. См. unreadableText.
                  <Text style={{ fontSize: 13, color: isMe ? meInk.text : colors.textMuted, fontStyle: 'italic', paddingHorizontal: 12, paddingTop: 6 }}>{UNREADABLE_MESSAGE_TEXT}</Text>
                ) : item.text && item.text.trim() && item.text.trim() !== ' ' ? (
                  <GrpMessageBlock text={item.text} baseStyle={[gcStyles.bubbleText, { color: isMe ? meInk.text : colors.text, paddingHorizontal: 12, paddingTop: 6, fontSize: msgFontSize }]} isMe={isMe} />
                ) : null}
              </View>
            )
          ) : isUnreadableMessage(item) ? (
            // v4.32.559: см. ChatScreen — то же различие нужно и группам.
            <Text style={{ fontSize: 13, color: isMe ? meInk.text : colors.textMuted, fontStyle: 'italic' }}>{UNREADABLE_MESSAGE_TEXT}</Text>
          ) : item.text.startsWith(POLL_PREFIX) ? (
            <PollBubble messageId={item.id} pollText={item.text} isMe={isMe} myPubB64={myPubB64} groupId={item.groupId} pid={pid} members={allMembers} />
          ) : isVoiceMessage(item.text) ? (() => {
            const meta = parseVoiceMeta(item.text);
            if (!meta) return null;
            // v4.32.242: раньше сюда уходил meta.uri как есть — участник группы
            // мог направить плеер соседа на свой сервер (IP-адрес и время
            // прослушивания) или на file:// самого получателя. Адрес выбирает
            // общая политика, та же, что в личных чатах (voiceUriPolicy).
            const voiceUri = voicePlaybackUri({ metaUri: meta.uri, isOutgoing: isMe, gateway });
            if (!voiceUri && !meta.blob) {
              return (
                <Text style={[gcStyles.bubbleText, { color: isMe ? meInk.secondary : colors.textMuted, fontSize: msgFontSize }]}>
                  🎤 Голосовое сообщение недоступно
                </Text>
              );
            }
            return <VoicePlayer uri={voiceUri} durationMs={meta.durationMs} isOutgoing={isMe} blob={meta.blob} />;
          })() : isDocMessage(item.text) ? (
            // v4.32.245: тот же пузырь, что в личных чатах. Свой рендер знал
            // только адрес шлюза, поэтому документ и видео, приехавшие
            // зашифрованным вложением, не открывались вовсе — а без IPFS это
            // единственный способ их прислать.
            <DocBubble text={item.text} isOutgoing={isMe} gateway={gateway} />
          ) : isGifMessage(item.text) ? (
            <GifBubble url={parseGifUrl(item.text)} isMe={isMe} />
          ) : isLiveLocMessage(item.text) ? (
            // v4.32.563: был свой рендер, отставший от пузыря переписки. Он не
            // заводил таймера перерисовки — зелёная плашка LIVE не гасла сама
            // никогда, а «Геолокация завершена» появлялась только если экран
            // перерисовало что-то постороннее. Не было и строки «ещё N мин».
            // А неразобранный конверт он выкладывал на экран как есть — со
            // служебным символом и JSON. Пузырь теперь общий, чернила берёт
            // от BubbleKindProvider группы.
            <LiveLocationBubble text={item.text} isOutgoing={isMe} />
          ) : isLocationMessage(item.text) ? (() => {
            const meta = parseLocationMeta(item.text);
            if (!meta) return <Text style={[gcStyles.bubbleText, { color: isMe ? meInk.text : colors.text, fontSize: msgFontSize }]}>{item.text}</Text>;
            return (
              <AppPressable
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 180, paddingVertical: 4 }}
                onPress={() => openMapAt(meta.lat, meta.lon)}
              >
                <Ionicons name="location" size={28} color={isMe ? meInk.accent : colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: isMe ? meInk.text : colors.text, fontWeight: '600', fontSize: 13 }}>Геолокация</Text>
                  <Text style={{ color: isMe ? meInk.secondary : colors.textMuted, fontSize: 11 }}>{meta.label || `${meta.lat.toFixed(5)}, ${meta.lon.toFixed(5)}`}</Text>
                </View>
                <Ionicons name="open-outline" size={16} color={isMe ? meInk.muted : colors.textMuted} />
              </AppPressable>
            );
          })() : isContactCard(item.text) ? (() => {
            // v4.32.254: раньше здесь лежала своя копия карточки контакта, и
            // она не проверяла ключ. Для лички такую проверку добавили в
            // v4.32.183 (подделанная карточка с ключом не в 32 байта портит
            // хранилище контактов и роняет крипто-операции потом), а копия в
            // группах — где карточку может прислать любой участник — так и
            // передавала Buffer.from(card.pub) в addContact как есть.
            if (!parseContactCard(item.text)) {
              return <Text style={[gcStyles.bubbleText, { color: isMe ? meInk.text : colors.text, fontSize: msgFontSize }]}>{item.text}</Text>;
            }
            return <ContactCardBubble text={item.text} isOutgoing={isMe} pair={pair} />;
          })() : (() => {
            const fwdInfo = isForwardedMessage(item.text) ? parseForwardedMessage(item.text) : null;
            const displayText = fwdInfo ? fwdInfo.originalText : item.text;
            const fwdLabel = fwdInfo ? (fwdInfo.senderName ? `Переслано от ${fwdInfo.senderName}` : 'Переслано') : null;
            return (
              <>
                {fwdLabel ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isMe ? meTile : colors.border }}>
                    <Ionicons name="arrow-redo-outline" size={12} color={isMe ? meInk.accent : colors.accent} />
                    <Text style={{ fontSize: 11, color: isMe ? meInk.accent : colors.primary, marginLeft: 3, fontStyle: 'italic' }}>{fwdLabel}</Text>
                  </View>
                ) : null}
                {searchVisible && searchQuery.trim() ? (
                  <Text style={[gcStyles.bubbleText, { color: isMe ? meInk.text : colors.text, fontSize: msgFontSize, flexWrap: 'wrap' }]}>
                    {highlightSegments(displayText, searchQuery).map((seg, si) => (
                      <Text key={si} style={seg.match ? { backgroundColor: grpMark.fill, color: grpMark.ink, borderRadius: 2 } : undefined}>{seg.text}</Text>
                    ))}
                  </Text>
                ) : (
                  <GrpCollapsibleBlock text={displayText} baseStyle={[gcStyles.bubbleText, { color: isMe ? meInk.text : colors.text, fontSize: msgFontSize }]} isMe={isMe} onMentionPress={handleMentionPress} />
                )}
                {(autoTranslate || grpManualTranslatedIds.has(item.id)) && !isMe && translationCache[item.id] ? (
                  <>
                    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 5 }} />
                    <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 2 }}>🌐 переведено</Text>
                    {/* v4.32.352: перевод в СВОЁМ пузыре лежит на заливке, а
                        colors.textSecondary подобран под фон страницы — на
                        синем он читался как грязное пятно. Приведено к тому же
                        приглушённому белому, что и в личных чатах. */}
                    <GrpMessageBlock text={translationCache[item.id]!} baseStyle={[gcStyles.bubbleText, { color: isMe ? meInk.secondary : colors.textSecondary, fontSize: msgFontSize - 1 }]} isMe={isMe} />
                  </>
                ) : null}
                {(() => {
                  const u = extractFirstUrl(displayText);
                  return u ? <LinkPreview url={u} isOutgoing={isMe} fromPeer={!isMe} /> : null;
                })()}
              </>
            );
          })()}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: item.mediaCids ? 8 : 0, paddingBottom: item.mediaCids ? 6 : 0 }}>
            {item.starred ? <Ionicons name="star" size={10} color={isMe ? meInk.star : colors.star} style={{ marginRight: 3 }} /> : null}
            {disappearMs ? <Ionicons name="timer-outline" size={11} color={isMe ? meInk.muted : colors.textMuted} style={{ marginRight: 3 }} /> : null}
            {item.seenUnreadable && (isMe || group.type === 'channel') ? (
              // v4.32.591: столбец с прочитавшими не открылся ключом данных.
              // «0» здесь было бы неправдой, а исправить её нельзя: писать в
              // непрочитанный столбец запрещено с v4.32.544.
              <AppPressable
                onPress={() => setSeenByMsg(item)}
                hitSlop={6}
                style={{ flexDirection: 'row', alignItems: 'center', marginRight: 4 }}
              >
                <Ionicons name="eye-off-outline" size={11} color={colors.warning} style={{ marginRight: 2 }} />
                <Text style={{ fontSize: 11, color: colors.warning }}>?</Text>
              </AppPressable>
            ) : isMe && (item.seenBy?.length ?? 0) > 0 ? (
              <AppPressable
                onPress={() => setSeenByMsg(item)}
                hitSlop={6}
                style={{ flexDirection: 'row', alignItems: 'center', marginRight: 4 }}
              >
                <Ionicons name="checkmark-done" size={13} color={meInk.muted} style={{ marginRight: 2 }} />
                <Text style={{ fontSize: 11, color: meInk.secondary }}>{item.seenBy!.length}</Text>
              </AppPressable>
            ) : (item.seenBy?.length ?? 0) > 0 && (isMe || group.type === 'channel') ? (
              // v4.32.226: REAL views — distinct readers from seen_by (read-receipt
              // backed), not the old blind per-open view_count counter (which inflated
              // to thousands on a 1-subscriber channel from the owner's own re-opens).
              <>
                <Ionicons name="eye-outline" size={11} color={isMe ? meInk.muted : colors.textMuted} style={{ marginRight: 2 }} />
                <Text style={{ fontSize: 11, color: isMe ? meInk.secondary : colors.textMuted, marginRight: 4 }}>
                  {(item.seenBy?.length ?? 0) >= 1000 ? `${((item.seenBy!.length) / 1000).toFixed(1)}K` : item.seenBy!.length}
                </Text>
              </>
            ) : null}
            <AppPressable onLongPress={() => Alert.alert('', fullDateTime(item.createdAt))} hitSlop={6}>
              <Text style={[gcStyles.timeText, { color: isMe ? meInk.secondary : colors.textMuted }]}>
                {item.editedAt ? 'изм. ' : ''}{formatTime(item.createdAt)}
              </Text>
            </AppPressable>
            {isMe ? (
              <Ionicons
                name={item.id === lastSentMsgIdRef.current ? 'checkmark-outline' : 'checkmark-done-outline'}
                size={13}
                color={meInk.muted}
                style={{ marginLeft: 2 }}
              />
            ) : null}
          </View>
        </View>
        {/* v4.32.600: непрочитанный столбец с реакциями прежде был неотличим
            от «на это никто не реагировал» — а нажатие на эмодзи получало
            отказ (писать в него запрещено с v4.32.544) будто бы из ниоткуда. */}
        {reactEntries.length > 0 || item.reactionsUnreadable ? (
          <View style={gcStyles.reactionsRow}>
            {item.reactionsUnreadable ? (
              <View style={[gcStyles.reactionChip, { backgroundColor: colors.surfaceHigh, borderColor: colors.warning }]}>
                <Ionicons name="alert-circle-outline" size={14} color={colors.warning} />
                <Text style={[gcStyles.reactionCount, { color: colors.warning }]}>{UNREADABLE_REACTIONS_TEXT}</Text>
              </View>
            ) : null}
            {reactEntries.map(([emoji, users]) => (
              <AppPressable
                key={emoji}
                style={[gcStyles.reactionChip, { backgroundColor: users.includes(myPubB64) ? activeTint.fill : colors.surfaceHigh, borderColor: users.includes(myPubB64) ? colors.accent : colors.border }]}
                onPress={() => void applyReaction(item, emoji)}
                onLongPress={() => {
                  setReactionDetailGrp({ activeEmoji: emoji, map: parseReactionMap(item.reactions) });
                }}
              >
                <Text style={{ fontSize: 14 }}>{emoji}</Text>
                {/* Счётчик лежит на двух разных подложках — у каждой свои чернила. */}
                <Text style={[gcStyles.reactionCount, { color: users.includes(myPubB64) ? activeInk.text : colors.text }]}>{users.length}</Text>
              </AppPressable>
            ))}
            <AppPressable
              style={[gcStyles.reactionChip, { backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
              onPress={() => Platform.OS === 'ios' ? showMsgMenu(item) : setQuickReact(item)}
            >
              <Ionicons name="add" size={16} color={colors.textMuted} />
            </AppPressable>
          </View>
        ) : null}
        {isHighlighted && highlightBgColor ? (
          <RNAnimated.View style={[StyleSheet.absoluteFill, { backgroundColor: highlightBgColor, borderRadius: 12 }]} pointerEvents="none" />
        ) : null}
      </AppPressable>
      </GrpSwipeRow>
    );
  };

  // Stage D (partial): keep renderMsg identity stable across parent renders via ref-to-latest-fn pattern.
  // Body remains verbatim (renderMsgImpl above) to avoid a 449-line surgical rewrite. Closures stay fresh
  // because the ref is reassigned every render; FlashList sees a stable renderItem prop.
  const renderMsgImplRef = useRef(renderMsgImpl);
  renderMsgImplRef.current = renderMsgImpl;
  const renderMsg = useCallback(
    (args: { item: GrpListItem; index: number }) => renderMsgImplRef.current(args),
    [],
  );

  // Android reaction picker modal
  const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '👏'];

  return (
    <View style={{ flex: 1, backgroundColor: feed.ground }}>
      {/* v4.32.410: обои-снимок раньше подставлялись в backgroundColor путём к
          файлу и просто не работали. Шапка и поле ввода залиты непрозрачно,
          поэтому картинка видна ровно под лентой. */}
      {grpWallpaper?.type === 'image' ? (
        <Image
          source={{ uri: grpWallpaper.value }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      ) : null}
      {/* Header */}
      {searchVisible ? (
        <View style={[gcStyles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
          <AppPressable onPress={closeSearch} style={gcStyles.iconBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </AppPressable>
          <TextInput
            ref={searchInputRef}
            style={[gcStyles.searchInput, { color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Поиск сообщений…"
            placeholderTextColor={colors.textMuted}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {/* v4.32.581: пометка стоит до счётчика и живёт в обеих его ветках —
              «0» без неё выдавал непрочитанную историю за пустой поиск. */}
          {searchScan && searchSkippedBadge(searchScan) ? (
            <Text
              style={{ fontSize: 12, color: colors.warning, marginHorizontal: 2 }}
              accessibilityLabel={searchSkippedNotice(searchScan) ?? undefined}
            >
              {searchSkippedBadge(searchScan)}
            </Text>
          ) : null}
          {searchResults && searchResults.length > 0 ? (
            <>
              <Text style={{ fontSize: 12, color: colors.textMuted, marginHorizontal: 4, minWidth: 36, textAlign: 'center' }}>
                {hitLabel(searchIdx, searchResults.length)}
              </Text>
              <AppPressable
                style={gcStyles.iconBtn}
                onPress={() => {
                  const next = stepHitIndex(searchIdx, searchResults.length, 1);
                  setSearchIdx(next);
                  void scrollToReply(searchResults[next].id);
                }}
              >
                <Ionicons name="chevron-down" size={22} color={colors.text} />
              </AppPressable>
              <AppPressable
                style={gcStyles.iconBtn}
                onPress={() => {
                  const prev = stepHitIndex(searchIdx, searchResults.length, -1);
                  setSearchIdx(prev);
                  void scrollToReply(searchResults[prev].id);
                }}
              >
                <Ionicons name="chevron-up" size={22} color={colors.text} />
              </AppPressable>
            </>
          ) : searchResults !== null && searchQuery.trim() ? (
            <Text style={{ fontSize: 12, color: colors.textMuted, marginHorizontal: 8 }}>0</Text>
          ) : null}
        </View>
      ) : (
        <View style={[gcStyles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
          <AppPressable onPress={onBack} style={gcStyles.iconBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </AppPressable>
          <AppPressable style={[gcStyles.headerInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]} onPress={onOpenMembers}>
            {headerAvatarUri ? (
              <Image source={{ uri: headerAvatarUri }} style={{ width: 36, height: 36, borderRadius: 18 }} />
            ) : (
              <GroupAvatar name={group.name} size={36} type={group.type} />
            )}
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={[gcStyles.headerName, { color: colors.text }]} numberOfLines={1}>{group.name}</Text>
                {group.muted ? <Ionicons name="notifications-off-outline" size={13} color={colors.textMuted} /> : null}
              </View>
              {typingMembers.size > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} >
                  <AnimatedDots dotColor={colors.primary} dotSize={4} dotSpacing={5} stepDurationMs={200} />
                  <Text style={[gcStyles.headerSub, { color: colors.accent, fontStyle: 'italic' }]} numberOfLines={1}>
                    {typingMembers.size === 1 ? `${[...typingMembers.values()][0]} печатает` : typingMembers.size === 2 ? `${[...typingMembers.values()].join(' и ')} печатают` : 'Несколько человек печатают'}
                  </Text>
                </View>
              ) : (
                <Text style={[gcStyles.headerSub, { color: colors.textMuted }]}>
                  {slowModeSeconds > 0
                    ? `🐢 ${group.type === 'channel' ? 'Канал' : `${headerMemberCount} уч.`}`
                    : group.type === 'channel'
                    ? 'Канал'
                    : onlineMemberCount > 0
                    ? `${membersLabel(headerMemberCount)}, ${onlineMemberCount} онлайн`
                    : membersLabel(headerMemberCount)}
                </Text>
              )}
            </View>
          </AppPressable>
          <AppPressable style={gcStyles.iconBtn} onPress={openSearch}>
            <Ionicons name="search-outline" size={22} color={colors.text} />
          </AppPressable>
          <AppPressable style={gcStyles.iconBtn} onPress={() => setMediaGalleryVisible(true)}>
            <Ionicons name="images-outline" size={22} color={colors.text} />
          </AppPressable>
          <AppPressable style={[gcStyles.iconBtn, { position: 'relative' }]} onPress={onOpenMembers}>
            <Ionicons name="people-outline" size={22} color={colors.text} />
            {amAdmin && pendingJoinCount > 0 ? (
              <View style={{ position: 'absolute', top: 4, right: 4, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.errorFill, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: contrastingInk(colors.errorFill), fontSize: 9, fontWeight: '700' }}>{pendingJoinCount > 9 ? '9+' : String(pendingJoinCount)}</Text>
              </View>
            ) : null}
          </AppPressable>
          {/* Non-admin member options (visible to everyone) */}
          {!amAdmin ? (
            <AppPressable
              style={gcStyles.iconBtn}
              onPress={() => {
                const disappearLabel = `Исчезающие сообщения: ${formatDisappearLabel(disappearMs).toLowerCase()}`;
                // v4.32.227 (BUG-09): меню участника тоже через ActionSheet.
                openSheet('Параметры чата', '', [
                  {
                    text: isGrpMuted ? 'Включить уведомления' : 'Отключить уведомления…',
                    onPress: () => {
                      const kind: MuteKind = group.type === 'channel' ? 'channel' : 'group';
                      if (isGrpMuted) {
                        // v4.32.531: без .catch отказ базы оставлял чат беззвучным и
                        // не говорил об этом ни строчкой.
                        runGuardedOp(async () => {
                          await setGroupMuted(group.id, pid, false);
                          await muteUnset(kind, group.id);
                          setIsGrpMuted(false);
                          showSuccess('Уведомления включены');
                        }, 'Не удалось включить уведомления');
                      } else {
                        const snooze = (ms: number | null, label: string) => () => runGuardedOp(async () => {
                          const u = ms === null ? null : Date.now() + ms;
                          await setGroupMutedUntil(group.id, pid, u);
                          await muteSet(kind, group.id, u !== null ? { untilMs: u } : undefined);
                          setIsGrpMuted(true);
                          showSuccess(label);
                        }, 'Не удалось отключить уведомления');
                        // v4.32.227 (BUG-09): 6 опций → ActionSheet.
                        openSheet('Отключить уведомления', '', [
                          { text: '1 час', onPress: snooze(3_600_000, 'Без звука на 1 час') },
                          { text: '8 часов', onPress: snooze(8 * 3_600_000, 'Без звука на 8 часов') },
                          { text: '1 день', onPress: snooze(86_400_000, 'Без звука на 1 день') },
                          { text: '1 неделя', onPress: snooze(7 * 86_400_000, 'Без звука на 1 неделю') },
                          { text: 'Навсегда', onPress: snooze(null, 'Уведомления отключены') },
                          { text: 'Отмена', style: 'cancel' },
                        ]);
                      }
                    },
                  },
                  {
                    text: autoTranslate ? '🌐 Автоперевод: вкл' : '🌐 Автоперевод: выкл',
                    onPress: () => {
                      const newVal = !autoTranslate;
                      void scopedKvSet(chatAutoTranslateKey(groupConvId(group.id)), newVal ? '1' : '0').then(() => {
                        setAutoTranslate(newVal);
                        if (!newVal) setTranslationCache({});
                      });
                    },
                  },
                  {
                    text: 'Фон чата',
                    onPress: () => setWallpaperPickerVisible(true),
                  },
                  {
                    text: `Размер шрифта${grpChatFontSize ? ` (${grpChatFontSize}пт)` : ''}`,
                    onPress: () => {
                      openSheet('Размер шрифта', 'Выберите размер:', [
                        { text: 'Маленький (13)', onPress: () => { setGrpChatFontSize(13); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), '13'); } },
                        { text: 'Обычный (15)', onPress: () => { setGrpChatFontSize(15); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), '15'); } },
                        { text: 'Крупный (17)', onPress: () => { setGrpChatFontSize(17); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), '17'); } },
                        { text: 'Очень крупный (20)', onPress: () => { setGrpChatFontSize(20); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), '20'); } },
                        { text: 'По умолчанию', onPress: () => { setGrpChatFontSize(null); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), ''); } },
                        { text: 'Отмена', style: 'cancel' },
                      ]);
                    },
                  },
                  {
                    text: disappearLabel,
                    onPress: () => openSheet(
                      'Исчезающие сообщения',
                      'Выбор действует только на вашем устройстве: общий таймер группы включает администратор.',
                      [
                        ...DISAPPEAR_OPTIONS.map(({ text: t, ms }) => ({
                          text: t,
                          onPress: () => { requestAnimationFrame(() => { runGuardedOp(() => applyDisappear(ms), 'Не удалось изменить таймер исчезновения'); }); },
                        })),
                        { text: 'Отмена', style: 'cancel' as const },
                      ]
                    ),
                  },
                  {
                    text: 'Избранные сообщения',
                    onPress: () => void listStarredMessages(pid).then((entries) => { setStarredEntries(entries.filter((e) => e.kind === 'group' && e.contextId === group.id)); setStarredVisible(true); }),
                  },
                  {
                    text: 'Медиафайлы',
                    onPress: () => setMediaGalleryVisible(true),
                  },
                  {
                    text: 'Недавно удалённые',
                    onPress: openGrpRecentlyDeleted,
                  },
                  { text: 'Отмена', style: 'cancel' },
                ]);
              }}
            >
              <Ionicons name="ellipsis-vertical" size={22} color={colors.text} />
            </AppPressable>
          ) : null}
          {amAdmin ? (
            <AppPressable
              style={gcStyles.iconBtn}
              onPress={() => {
                const currentSlowLabel = slowModeSeconds > 0 ? `Медленный режим: ${formatSlowMode(slowModeSeconds)}` : 'Медленный режим: выкл';
                const disappearLabel = `Исчезающие сообщения: ${formatDisappearLabel(disappearMs).toLowerCase()}`;
                // v4.32.227 (BUG-09): ~15 пунктов через ActionSheet (Android-safe);
                // (BUG-09 #3) заголовок зависит от типа: канал → «Настройки канала».
                openSheet(group.type === 'channel' ? 'Настройки канала' : 'Настройки группы', '', [
                  {
                    text: isGrpMuted ? 'Включить уведомления' : 'Отключить уведомления…',
                    onPress: () => {
                      const kind: MuteKind = group.type === 'channel' ? 'channel' : 'group';
                      if (isGrpMuted) {
                        // v4.32.531: без .catch отказ базы оставлял чат беззвучным и
                        // не говорил об этом ни строчкой.
                        runGuardedOp(async () => {
                          await setGroupMuted(group.id, pid, false);
                          await muteUnset(kind, group.id);
                          setIsGrpMuted(false);
                          showSuccess('Уведомления включены');
                        }, 'Не удалось включить уведомления');
                      } else {
                        const snooze = (ms: number | null, label: string) => () => runGuardedOp(async () => {
                          const u = ms === null ? null : Date.now() + ms;
                          await setGroupMutedUntil(group.id, pid, u);
                          await muteSet(kind, group.id, u !== null ? { untilMs: u } : undefined);
                          setIsGrpMuted(true);
                          showSuccess(label);
                        }, 'Не удалось отключить уведомления');
                        // v4.32.227 (BUG-09): 6 опций → ActionSheet.
                        openSheet('Отключить уведомления', '', [
                          { text: '1 час', onPress: snooze(3_600_000, 'Без звука на 1 час') },
                          { text: '8 часов', onPress: snooze(8 * 3_600_000, 'Без звука на 8 часов') },
                          { text: '1 день', onPress: snooze(86_400_000, 'Без звука на 1 день') },
                          { text: '1 неделя', onPress: snooze(7 * 86_400_000, 'Без звука на 1 неделю') },
                          { text: 'Навсегда', onPress: snooze(null, 'Уведомления отключены') },
                          { text: 'Отмена', style: 'cancel' },
                        ]);
                      }
                    },
                  },
                  {
                    text: currentSlowLabel,
                    onPress: () => openSheet('Медленный режим', 'Задержка между сообщениями:', [
                      ...[
                        { text: 'Выкл', secs: 0 },
                        { text: '10 сек', secs: 10 },
                        { text: '30 сек', secs: 30 },
                        { text: '1 мин', secs: 60 },
                        { text: '5 мин', secs: 300 },
                      ].map(({ text: t, secs }) => ({
                        text: t,
                        onPress: () => { requestAnimationFrame(() => { runGuardedOp(() => applySlowMode(secs), 'Не удалось изменить медленный режим'); }); },
                      })),
                      { text: 'Отмена', style: 'cancel' as const },
                    ]),
                  },
                  {
                    text: disappearLabel,
                    onPress: () => openSheet(
                      'Исчезающие сообщения',
                      'Таймер применяется у всех участников и действует на сообщения, отправленные после включения.',
                      [
                        ...DISAPPEAR_OPTIONS.map(({ text: t, ms }) => ({
                          text: t,
                          onPress: () => { requestAnimationFrame(() => { runGuardedOp(() => applyDisappear(ms), 'Не удалось изменить таймер исчезновения'); }); },
                        })),
                        { text: 'Отмена', style: 'cancel' as const },
                      ]
                    ),
                  },
                  {
                    text: autoTranslate ? '🌐 Автоперевод: вкл' : '🌐 Автоперевод: выкл',
                    onPress: () => {
                      const newVal = !autoTranslate;
                      void scopedKvSet(chatAutoTranslateKey(groupConvId(group.id)), newVal ? '1' : '0').then(() => {
                        setAutoTranslate(newVal);
                        if (!newVal) setTranslationCache({});
                      });
                    },
                  },
                  {
                    text: 'Фон чата',
                    onPress: () => setWallpaperPickerVisible(true),
                  },
                  {
                    text: `Размер шрифта${grpChatFontSize ? ` (${grpChatFontSize}пт)` : ''}`,
                    onPress: () => {
                      openSheet('Размер шрифта', 'Выберите размер:', [
                        { text: 'Маленький (13)', onPress: () => { setGrpChatFontSize(13); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), '13'); } },
                        { text: 'Обычный (15)', onPress: () => { setGrpChatFontSize(15); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), '15'); } },
                        { text: 'Крупный (17)', onPress: () => { setGrpChatFontSize(17); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), '17'); } },
                        { text: 'Очень крупный (20)', onPress: () => { setGrpChatFontSize(20); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), '20'); } },
                        { text: 'По умолчанию', onPress: () => { setGrpChatFontSize(null); void scopedKvSet(chatFontSizeKey(groupConvId(group.id)), ''); } },
                        { text: 'Отмена', style: 'cancel' },
                      ]);
                    },
                  },
                  {
                    text: 'Медиафайлы',
                    onPress: () => setMediaGalleryVisible(true),
                  },
                  {
                    text: 'Избранные сообщения',
                    onPress: () => void listStarredMessages(pid).then((entries) => {
                      setStarredEntries(entries.filter((e) => e.kind === 'group' && e.contextId === group.id));
                      setStarredVisible(true);
                    }),
                  },
                  // Приглашает администратор: ссылка объявляет своего автора
                  // админом группы — у обычного участника это ложное заявление.
                  ...(amAdmin ? [{
                    text: 'Пригласительная ссылка',
                    onPress: () => { requestAnimationFrame(() => { void (async () => {
                      // v4.32.260: ссылку собирает groupInviteLink — один
                      // сборщик на все четыре кнопки приглашения. Здесь список
                      // участников не клали вовсе (4.32.173, ради приватности),
                      // а разбор его требовал — основная кнопка приглашения
                      // выдавала ссылку, которую приложение же и отвергало.
                      //
                      // v4.32.303: и токен — то, чем ссылку потом отзывают. У
                      // групп, созданных до этой версии, его нет: заводим здесь.
                      // v4.32.303: готовую ссылку в БД больше не пишем — она
                      // несёт токен, а колонка invite_link не шифруется и никем
                      // не читается (см. схему groups).
                      const showInviteSheet = async (token: string): Promise<void> => {
                        const link = buildGroupInviteLink({
                          id: group.id,
                          name: group.name,
                          type: group.type,
                          adminPub: myPubB64,
                          requireApproval,
                          members: await listGroupMembers(group.id, pid),
                          token,
                        });
                        openSheet('Пригласительная ссылка', link, [
                          {
                            text: COPY_ACTION,
                            onPress: () => {
                              Clipboard.setString(link);
                              showSuccess(COPIED_LINK);
                            },
                          },
                          {
                            text: 'Поделиться',
                            onPress: () => void Share.share({ message: `Присоединяйтесь к "${group.name}" в AirChat:\n${link}` }),
                          },
                          /*
                           * v4.32.303: «Сбросить» вернулась — теперь она
                           * действительно отзывает ссылку.
                           *
                           * До v4.32.260 кнопка обнуляла локальную колонку
                           * invite_link и рапортовала «Ссылка сброшена», но
                           * ссылка была чистой функцией от {id, name, adminPub,
                           * requireApproval}: следующее нажатие выдавало ровно
                           * ту же строку, а все ранее разосланные продолжали
                           * пускать в группу. Кнопку убрали и записали, что
                           * настоящий отзыв требует токена. Вот он.
                           */
                          {
                            text: 'Сбросить ссылку',
                            style: 'destructive',
                            onPress: () => {
                              Alert.alert(
                                'Сбросить ссылку?',
                                'Все ранее разосланные ссылки перестанут пускать в группу. Тех, кто уже вступил, это не затронет.',
                                [
                                  { text: 'Отмена', style: 'cancel' },
                                  {
                                    text: 'Сбросить',
                                    style: 'destructive',
                                    onPress: () => { void (async () => {
                                      try {
                                        const next = await rotateGroupInviteToken(group.id, pid, myPubB64, myDisplayName);
                                        await insertGroupSysMessage(group.id, pid, myPubB64, 'Пригласительная ссылка сброшена: прежние больше не действуют');
                                        // v4.32.452: «сброшена» — только если о новом
                                        // токене узнали другие администраторы. Иначе
                                        // их кнопка продолжит выдавать ссылки, которые
                                        // группа уже не пускает, а отзыв выглядел бы
                                        // состоявшимся.
                                        if (!announceInviteToken(next.announced)) {
                                          showSuccess('Ссылка сброшена — прежние больше не действуют');
                                        }
                                        // Показываем новую сразу: иначе «сбросил
                                        // и не понял, где взять действующую».
                                        await showInviteSheet(next.token);
                                      } catch (e) {
                                        showError(userErrorText(e, 'Не удалось сбросить ссылку'));
                                      }
                                    })(); },
                                  },
                                ]
                              );
                            },
                          },
                          { text: 'Закрыть', style: 'cancel' },
                        ]);
                      };
                      const invite = await ensureGroupInviteToken(group.id, pid, myPubB64, myDisplayName);
                      // null — группу не прочитать ЛИБО столбец с токеном не
                      // открылся ключом (v4.32.601). Показать ссылку было бы
                      // хуже, чем не показать: она ни с чем не сверяется.
                      if (invite === null) { showError('Не удалось получить пригласительную ссылку'); return; }
                      announceInviteToken(invite.announced);
                      await showInviteSheet(invite.token);
                    })(); }); },
                  }] : []),
                  {
                    text: 'Статистика',
                    // v4.32.531: раньше без .catch — при занятой базе пункт «Статистика»
                    // просто ничего не открывал, и это выглядело как неработающая кнопка.
                    onPress: () => void getGroupStats(group.id, pid)
                      .then((s) => { setGrpStats(s); setGrpStatsVisible(true); })
                      .catch((e) => showError(userErrorText(e, 'Не удалось собрать статистику'))),
                  },
                  {
                    text: 'Недавно удалённые',
                    onPress: openGrpRecentlyDeleted,
                  },
                  // v4.32.256: рассылка обязательна. Без неё настройку знал только
                  // нажавший: второй администратор выдавал ссылку без одобрения, а
                  // «Имена отправителей скрыты» было правдой ровно на одном
                  // устройстве. v4.32.531: и подписи, и патч, и порядок «сначала
                  // запись — потом слова» теперь общие для всех четырёх.
                  ...(group.type !== 'channel' ? [{
                    text: groupFlagCopy('adminOnlyPosting', adminOnlyPosting).menu,
                    onPress: () => toggleGroupFlag('adminOnlyPosting', adminOnlyPosting, setAdminOnlyPosting),
                  }] : []),
                  ...(group.type !== 'channel' ? [{
                    text: groupFlagCopy('adminOnlyPinning', adminOnlyPinning).menu,
                    onPress: () => toggleGroupFlag('adminOnlyPinning', adminOnlyPinning, setAdminOnlyPinning),
                  }] : []),
                  {
                    text: groupFlagCopy('requireApproval', requireApproval).menu,
                    onPress: () => toggleGroupFlag('requireApproval', requireApproval, setRequireApproval),
                  },
                  {
                    text: groupFlagCopy('anonymousPosting', anonymousPosting).menu,
                    onPress: () => toggleGroupFlag('anonymousPosting', anonymousPosting, setAnonymousPosting),
                  },
                  {
                    text: 'Экспорт чата',
                    onPress: () => { requestAnimationFrame(() => { void (async () => {
                      try {
                        const allMsgs = await listAllGroupMessages({ groupId: group.id, ownerProfileId: pid });
                        // v4.32.532: файл сохранят и на него сошлются, поэтому
                        // выгружаем либо всё, либо ничего.
                        if (!shouldApplyRows(allMsgs)) { showError('Не удалось прочитать переписку для экспорта'); return; }
                        const sorted = [...allMsgs].sort((a, b) => a.createdAt - b.createdAt);
                        const txt = sorted.map((m) => {
                          const d = fullDateTime(m.createdAt);
                          // v4.32.256: экспорт выписывал имена отправителей даже
                          // при включённых анонимных постах — то есть настройка
                          // скрывала имена на экране и тут же выкладывала их в
                          // файл, которым делятся наружу.
                          const who = anonymousPosting
                            ? (m.senderPubB64 === myPubB64 ? 'Вы' : 'Участник')
                            // v4.32.593: в файл идёт имя либо короткий ключ, но
                            // никогда пометка о непрочитанном столбце.
                            : outwardName(m.senderName, m.senderUnreadable, shortIdentity(m.senderPubB64));
                          // v4.32.604: у непрочитанной реплики текста нет, и
                          // пустая строка в файле выдавала её за отправленную пустоту.
                          return `[${d}] ${who}: ${exportBody(m)}`;
                        }).join('\n');
                        // v4.32.310: см. cacheFiles — имя общее для всех
                        // экспортов, иначе за файлом никто не убирает.
                        // v4.32.313: и отдача общая — три копии расходились.
                        const shared = await shareTextExport('group', txt, 'Экспорт группы', Date.now());
                        if (!shared) Alert.alert('Экспорт', 'Системное «Поделиться» недоступно на этом устройстве');
                      } catch (e) {
                        Alert.alert('Ошибка', userErrorText(e, 'Не удалось выгрузить переписку'));
                      }
                    })(); }); },
                  },
                  {
                    text: 'Очистить историю',
                    style: 'destructive',
                    onPress: () => {
                      Alert.alert('Очистить историю?', 'Все сообщения этой группы будут удалены локально. Это действие нельзя отменить.', [
                        { text: 'Отмена', style: 'cancel' },
                        {
                          text: 'Очистить', style: 'destructive',
                          // v4.32.531: успех объявлялся без оглядки на исход, а
                          // перечитывание ленты висело отдельным необработанным
                          // обещанием. Теперь «История очищена» говорится только
                          // после удаления.
                          onPress: () => { requestAnimationFrame(() => { void (async () => {
                            try {
                              await clearGroupMessages(group.id, pid);
                            } catch (e) {
                              showError(userErrorText(e, 'Не удалось очистить историю'));
                              return;
                            }
                            showSuccess('История очищена');
                            await loadMessages();
                          })(); }); },
                        },
                      ]);
                    },
                  },
                  { text: 'Отмена', style: 'cancel' },
                ]);
              }}
            >
              <Ionicons name="settings-outline" size={22} color={colors.text} />
            </AppPressable>
          ) : null}
        </View>
      )}

      {/* Pinned message banner */}
      {(pinnedMsgText || pinnedMsgUnreadable || grpPinnedList.length > 0) ? (() => {
        const total = Math.max(grpPinnedList.length, pinnedMsgText || pinnedMsgUnreadable ? 1 : 0);
        const currentPin = grpPinnedList.length > 0 ? grpPinnedList[grpPinnedIdx % grpPinnedList.length] : null;
        // v4.32.576: закрепление, которое не открылось ключом данных, раньше
        // приходило сюда пустой строкой и рисовалось пустой полоской — как
        // объявление без текста. Пометка ставится ВМЕСТО показа, сам text в
        // сущности остаётся пустым и никуда дальше не уходит.
        // v4.32.603: у наследного текста своя пометка — она приходит из
        // колонки групп, а не из строки списка.
        const currentPinUnreadable = currentPin ? isUnreadableMessage(currentPin) : pinnedMsgUnreadable;
        const currentPinText = currentPin
          ? (currentPinUnreadable ? UNREADABLE_MESSAGE_TEXT : currentPin.text)
          : (currentPinUnreadable ? UNREADABLE_MESSAGE_TEXT : pinnedMsgText);
        const currentPinId = currentPin?.id ?? pinnedMsgId;
        return (
          <AppPressable
            style={[gcStyles.pinnedBanner, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}
            onPress={() => {
              if (total > 1) {
                const nextIdx = (grpPinnedIdx + 1) % total;
                setGrpPinnedIdx(nextIdx);
                const nextPin = grpPinnedList[nextIdx];
                if (nextPin) scrollToReply(nextPin.id);
              } else if (currentPinId) {
                scrollToReply(currentPinId);
              }
            }}
            onLongPress={() => total > 1 ? setGrpPinnedListVisible(true) : undefined}
          >
            <Ionicons name="pin" size={14} color={colors.accent} style={{ marginRight: 6 }} />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text
                  style={[gcStyles.pinnedText, { color: currentPinUnreadable ? colors.textMuted : colors.textSecondary, fontStyle: currentPinUnreadable ? 'italic' : 'normal' }]}
                  numberOfLines={1}
                >{currentPinText}</Text>
                {total > 1 ? (
                  <Text style={{ fontSize: 11, color: colors.textMuted, flexShrink: 0 }}>{grpPinnedIdx + 1}/{total}</Text>
                ) : null}
              </View>
            </View>
            {canPin ? (
              <AppPressable onPress={() => {
                if (total > 1) { setGrpPinnedListVisible(true); return; }
                requestAnimationFrame(() => { void (async () => {
                  // Единственное закреплённое — обычное открепление с рассылкой.
                  // Пустой currentPinId бывает только у групп с наследием, где
                  // текст баннера лежал в groups без id: там чистим локально.
                  if (currentPinId) {
                    const res = await togglePinAndSync({ groupId: group.id, msgId: currentPinId, on: false, actorName: myDisplayName });
                    if (!res.ok) { Alert.alert('AirChat', groupPinRefusalText(res.reason)); return; }
                    announceCtl(res.sync);
                    const left = res.entries;
                    setGrpPinnedList(left);
                    setPinnedMsgId(left[0]?.id ?? null);
                    setPinnedMsgText(left[0]?.text ?? null);
                    return;
                  }
                  await clearPinned(group.id, pid);
                  setGrpPinnedList([]);
                  setPinnedMsgId(null);
                  setPinnedMsgText(null);
                })(); });
              }} style={{ padding: 4 }}>
                <Ionicons name={total > 1 ? 'list' : 'close'} size={14} color={colors.textMuted} />
              </AppPressable>
            ) : null}
          </AppPressable>
        );
      })() : null}

      {/* Disappear timer banner */}
      {disappearMs ? (
        <View style={[gcStyles.pinnedBanner, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <Ionicons name="timer-outline" size={14} color={colors.textMuted} style={{ marginRight: 6 }} />
          <Text style={[gcStyles.pinnedText, { color: colors.textMuted }]}>
            {'Исчезают через '}
            {disappearMs >= 86400000 ? `${disappearMs / 86400000} д` : disappearMs >= 3600000 ? `${disappearMs / 3600000} ч` : `${disappearMs / 60000} мин`}
          </Text>
        </View>
      ) : null}

      {/* Jump to first unread banner */}
      {grpOpenUnread > 0 && !searchVisible ? (
        <AppPressable
          style={[gcStyles.pinnedBanner, { backgroundColor: activeTint.fill, borderBottomColor: colors.accent }]}
          onPress={() => {
            const idx = displayGroupMessages.findIndex((it) => (it as GrpUnreadSepItem).type === 'unread_sep');
            if (idx >= 0) {
              try { groupFlashRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 }); } catch { /* */ }
            }
          }}
        >
          <Ionicons name="arrow-up-outline" size={14} color={activeTint.ink} style={{ marginRight: 6 }} />
          <Text style={[gcStyles.pinnedText, { color: activeTint.ink, flex: 1 }]}>
            {grpOpenUnread} непрочитанных — нажмите, чтобы перейти
          </Text>
          <AppPressable onPress={() => setGrpOpenUnread(0)} hitSlop={8}>
            <Ionicons name="close" size={14} color={activeTint.ink} />
          </AppPressable>
        </AppPressable>
      ) : null}

      {/* Messages */}
      <FlashList
        ref={groupFlashRef}
        data={displayGroupMessages}
        inverted={!searchVisible}
        getItemType={(item) => {
          const t = (item as GrpDateSepItem).type;
          if (t === 'date_sep' || t === 'unread_sep') return 'sep';
          return 'msg';
        }}
        keyboardDismissMode="interactive"
        keyExtractor={(item) => {
          const t = (item as GrpDateSepItem).type;
          if (t === 'date_sep') return (item as GrpDateSepItem).key;
          if (t === 'unread_sep') return 'unread_sep';
          return (item as GroupMessageRow).id;
        }}
        renderItem={renderMsg}
        contentContainerStyle={{ paddingVertical: 8 }}
        onEndReached={searchVisible ? undefined : () => void loadMore()}
        onEndReachedThreshold={0.3}
        onScroll={(e) => { if (!searchVisible) { const atBottom = e.nativeEvent.contentOffset.y > 120; setShowScrollBottom(atBottom); showScrollBottomRef.current = atBottom; } }}
        scrollEventThrottle={100}
        ListEmptyComponent={
          <View style={gcStyles.empty}>
            <Ionicons name={searchVisible ? 'search-outline' : 'chatbubbles-outline'} size={48} color={colors.textMuted} />
            <Text style={[gcStyles.emptyText, { color: colors.textMuted }]}>
              {searchVisible
                ? (searchQuery.trim() ? 'Ничего не найдено' : 'Введите запрос для поиска')
                : msgReadFailed
                  ? 'Не удалось открыть переписку'
                  : (group.type === 'channel' ? 'Нет постов' : 'Нет сообщений')}
            </Text>
            {/* v4.32.532: сбой базы — не пустая группа, и сказать об этом надо
                прямо, иначе потеря выглядит как «здесь ничего и не было». */}
            {!searchVisible && msgReadFailed ? (
              <Text style={[gcStyles.emptyText, { color: colors.textMuted, fontSize: 13, marginTop: 6 }]}>
                База данных была занята. Выйдите в список групп и откройте эту снова.
              </Text>
            ) : null}
            {/* v4.32.579: описание, которое не открылось ключом данных, — не
                «описания нет». Показываем пометку курсивом, иначе потеря
                выглядит как пустое поле, которое никто не заполнял. */}
            {!searchVisible && !group.description && group.descriptionUnreadable ? (
              <View style={{ marginTop: 16, paddingHorizontal: 24, maxWidth: 320, backgroundColor: colors.surfaceHigh, borderRadius: 12, padding: 14 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600', marginBottom: 4, letterSpacing: 0.5 }}>ОПИСАНИЕ</Text>
                <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 18, textAlign: 'center', fontStyle: 'italic' }}>{UNREADABLE_DESCRIPTION_TEXT}</Text>
              </View>
            ) : null}
            {!searchVisible && group.description ? (
              <View style={{ marginTop: 16, paddingHorizontal: 24, maxWidth: 320, backgroundColor: colors.surfaceHigh, borderRadius: 12, padding: 14 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11, fontWeight: '600', marginBottom: 4, letterSpacing: 0.5 }}>ОПИСАНИЕ</Text>
                {/* v4.32.374: предел по строкам. Пустые строки подряд схлопывает
                    sanitizeParagraphText, а чередование «а\nб\nв» — нет: 512
                    символов дают 256 строк и карточку во весь экран. */}
                <Text numberOfLines={8} style={{ color: colors.text, fontSize: 13, lineHeight: 18, textAlign: 'center' }}>{group.description}</Text>
              </View>
            ) : null}
          </View>
        }
      />

      {showScrollBottom && !searchVisible ? (
        <>
          {(() => {
            // v4.32.255: подсветка сообщения, эта кнопка «перейти к упоминанию»
            // и счётчик mention_count считали упоминание тремя своими копиями
            // одного `.includes('@' + имя)` — расходились на границах слова.
            // Теперь у всех троих один isMentionOf.
            const mentionMsgs = messages.filter(
              (m) => m.senderPubB64 !== myPubB64 && isMentionOf(m.text ?? '', myDisplayName)
            );
            if (mentionMsgs.length === 0) return null;
            const count = mentionMsgs.length;
            const safeIdx = mentionJumpIdx % count;
            return (
              <AppPressable
                // v4.32.398: было '#7b1fa2'. Фиолетовым эту кнопку сделать не
                // выходит: чтобы отличаться от соседней (`primary`) и при этом
                // держать 3:1 к фону чата, нужен цвет, которого в палитре нет —
                // '#7b1fa2' даёт на тёмном фоне 2.14:1, а тот, что даёт 3.24:1,
                // отличается от синего на 1.05:1. Срочность несёт красная
                // плашка со счётчиком, сама кнопка — второстепенная.
                style={[gcStyles.scrollBottomBtn, { backgroundColor: colors.mutedFill, bottom: 86 }]}
                onPress={() => {
                  const target = mentionMsgs[safeIdx];
                  if (target) { scrollToReply(target.id); setMentionJumpIdx((i) => (i + 1) % count); }
                }}
              >
                <Text style={{ color: contrastingInk(colors.mutedFill), fontSize: 14, fontWeight: '800' }}>@</Text>
                {count > 1 ? (
                  <View style={{ position: 'absolute', top: -5, right: -5, backgroundColor: colors.errorFill, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 }}>
                    <Text style={{ color: contrastingInk(colors.errorFill), fontSize: 9, fontWeight: '700' }}>{count > 9 ? '9+' : count}</Text>
                  </View>
                ) : null}
              </AppPressable>
            );
          })()}
          <AppPressable
            style={[gcStyles.scrollBottomBtn, { backgroundColor: colors.primary }]}
            onPress={() => { groupFlashRef.current?.scrollToOffset({ offset: 0, animated: true }); }}
          >
            {group.unreadCount > 0 ? (
              <View style={{ position: 'absolute', top: -6, right: -6, backgroundColor: colors.errorFill, borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 }}>
                <Text style={{ color: contrastingInk(colors.errorFill), fontSize: 10, fontWeight: '700' }}>{group.unreadCount > 99 ? '99+' : group.unreadCount}</Text>
              </View>
            ) : null}
            <Ionicons name="chevron-down" size={22} color={contrastingInk(colors.primary)} />
          </AppPressable>
        </>
      ) : null}

      {/* Reaction picker (Android) */}
      <GroupQuickReactModal
        msg={quickReact}
        onClose={() => setQuickReact(null)}
        onReact={(e) => { if (quickReact) void applyReaction(quickReact, e); }}
        recentReactions={grpRecentReactions}
        reactionEmojis={REACTION_EMOJIS}
        onOpenMore={() => { setGrpReactMoreVisible(true); }}
        onReply={() => { if (quickReact) { setReplyTo(quickReact); setQuickReact(null); } }}
        onCopy={() => { if (quickReact) { Clipboard.setString(quickReact.text); showSuccess(COPIED_TEXT); setQuickReact(null); } }}
        onForward={() => { if (quickReact) { setForwardText(makeForwardText(outwardName(quickReact.senderName, quickReact.senderUnreadable, shortIdentity(quickReact.senderPubB64)), quickReact.text)); setQuickReact(null); } }}
        onPin={() => { if (quickReact) { void pinMsg(quickReact); setQuickReact(null); } }}
        onEdit={() => { if (quickReact) { startEdit(quickReact); setQuickReact(null); } }}
        onDelete={() => { if (quickReact) { deleteMsg(quickReact); setQuickReact(null); } }}
        onCopyLink={() => {
          if (!quickReact) return;
          const link = `airchat://group/${encodeURIComponent(group.id)}/msg/${encodeURIComponent(quickReact.id)}`;
          Clipboard.setString(link);
          showSuccess(COPIED_LINK);
          setQuickReact(null);
        }}
        isSys={!!quickReact && isGroupSysMessage(quickReact.text)}
        isTextLike={!!quickReact && !quickReact.text.startsWith(POLL_PREFIX) && !isVoiceMessage(quickReact.text) && !isGroupSysMessage(quickReact.text)}
        canPin={canPin}
        isPinned={!!quickReact && grpPinnedList.some((p) => p.id === quickReact.id)}
        canEdit={!!quickReact && quickReact.senderPubB64 === myPubB64 && !quickReact.text.startsWith(POLL_PREFIX) && !isVoiceMessage(quickReact.text)}
        canDelete={!!quickReact && (quickReact.senderPubB64 === myPubB64 || amAdmin)}
      />

      {/* Composer — channels and admin-only groups restrict posting */}
      {sendVerdict.allowed ? (
        // v4.32.102 K.8: корневой KAV — на Android adjustResize уже работает, behavior=undefined чтобы избежать двойной компенсации
        <View>
          {amAdmin && text.startsWith('/') && text.length >= 1 ? (() => {
            const CMDS = [
              { cmd: '/kick', hint: '@имя — исключить участника' },
              { cmd: '/ban', hint: '@имя — заблокировать участника' },
              { cmd: '/promote', hint: '@имя — назначить администратором' },
              { cmd: '/demote', hint: '@имя — снять администратора' },
              { cmd: '/mute', hint: '@имя — запретить писать' },
              { cmd: '/unmute', hint: '@имя — снять ограничение' },
              { cmd: '/slowmode', hint: '<сек> — медленный режим' },
              { cmd: '/pin', hint: '— закрепить сообщение' },
              { cmd: '/unpin', hint: '— открепить сообщение' },
              { cmd: '/readonly', hint: '— режим только чтение' },
              { cmd: '/open', hint: '— открыть чат' },
              { cmd: '/help', hint: '— список команд' },
            ];
            const q = text.toLowerCase();
            const matches = CMDS.filter((c) => c.cmd.startsWith(q));
            if (matches.length === 0) return null;
            return (
              <View style={[gcStyles.mentionList, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
                {matches.map((c) => (
                  <AppPressable
                    key={c.cmd}
                    style={gcStyles.mentionItem}
                    onPress={() => { setText(c.cmd + ' '); }}
                  >
                    <Text style={[gcStyles.mentionName, { color: colors.accent }]}>{c.cmd}</Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted, marginLeft: 8 }}>{c.hint}</Text>
                  </AppPressable>
                ))}
              </View>
            );
          })() : null}
          {cmdSuggestions.length > 0 ? (
            <View style={[gcStyles.mentionList, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
              {cmdSuggestions.map((c) => (
                <AppPressable
                  key={c.cmd}
                  style={[gcStyles.mentionItem, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}
                  onPress={() => { setText(c.cmd + ' '); setCmdFilter(null); }}
                >
                  <Text style={[gcStyles.mentionName, { color: colors.accent }]}>{c.cmd}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12, flex: 1, marginLeft: 8 }} numberOfLines={1}>{c.desc}</Text>
                </AppPressable>
              ))}
            </View>
          ) : null}
          {mentionSuggestions.length > 0 || mentionSkipped !== null ? (
            <View style={[gcStyles.mentionList, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
              {mentionSkipped !== null ? (
                <Text style={[gcStyles.mentionSkipped, { color: colors.warning }]}>{mentionSkipped}</Text>
              ) : null}
              {mentionSuggestions.map((m) => (
                <AppPressable key={m.peerPubB64} style={gcStyles.mentionItem} onPress={() => insertMention(m)}>
                  <Text style={[gcStyles.mentionName, { color: m.peerPubB64 === '__everyone__' ? colors.error : colors.text }]}>
                    @{m.displayName ?? shortIdentity(m.peerPubB64)}
                    {m.peerPubB64 === '__everyone__' ? <Text style={{ fontSize: 11, fontWeight: '400', color: colors.textMuted }}> — уведомить всех</Text> : null}
                  </Text>
                </AppPressable>
              ))}
            </View>
          ) : null}
          {grpHashtagSuggestions.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always"
              style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, maxHeight: 44 }}
              contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8, gap: 6, alignItems: 'center' }}
            >
              {grpHashtagSuggestions.map((tag) => (
                <AppPressable key={tag} onPress={() => insertHashtag(tag)}
                  style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, backgroundColor: inputTint.fill }}
                >
                  <Text style={{ fontSize: 13, color: inputTint.ink }}>{tag}</Text>
                </AppPressable>
              ))}
            </ScrollView>
          ) : null}
          {typingMembers.size > 0 ? (
            <View style={[gcStyles.replyBar, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
              <AnimatedDots dotColor={colors.primary} dotSize={4} dotSpacing={5} stepDurationMs={200} />
              <Text style={[gcStyles.replyBarText, { color: colors.textMuted, fontStyle: 'italic', marginLeft: 6 }]}>
                {[...typingMembers.values()].join(', ')} {typingMembers.size === 1 ? 'печатает' : 'печатают'}
              </Text>
            </View>
          ) : null}
          {editingMsg ? (
            <View style={[gcStyles.replyBar, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
              <Ionicons name="create-outline" size={14} color={colors.accent} style={{ marginRight: 4 }} />
              <Text style={[gcStyles.replyBarText, { color: colors.textMuted }]} numberOfLines={1}>Редактирование: {editingMsg.text}</Text>
              <AppPressable onPress={cancelEdit} style={{ padding: 4 }}>
                <Ionicons name="close" size={16} color={colors.textMuted} />
              </AppPressable>
            </View>
          ) : replyTo ? (
            <View style={[gcStyles.replyBar, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
              <View style={{ width: 2.5, alignSelf: 'stretch', backgroundColor: colors.primary, borderRadius: 2, marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: colors.accent, marginBottom: 1 }} numberOfLines={1}>
                  {replyTo.senderPubB64 === myPubB64 ? 'Вы' : (replyTo.senderName ?? shortIdentity(replyTo.senderPubB64))}
                </Text>
                <Text style={[gcStyles.replyBarText, { color: colors.textMuted }]} numberOfLines={1}>
                  {isVoiceMessage(replyTo.text) ? '🎤 Голосовое сообщение'
                    : isDocMessage(replyTo.text) ? '📄 Документ'
                    : isLocationMessage(replyTo.text) ? '📍 Геолокация'
                    : isGifMessage(replyTo.text) ? '🎞 GIF'
                    : replyTo.text.startsWith(POLL_PREFIX) ? '📊 Опрос'
                    : replyTo.text.startsWith('\x05contact:') ? '👤 Контакт'
                    : replyTo.text.startsWith('\x09vo:') ? '🔥 Одноразовое сообщение'
                    : replyTo.text.startsWith('\x0cliveloc:') ? '📡 Живая геолокация'
                    : isForwardedMessage(replyTo.text) ? `↪ ${parseForwardedMessage(replyTo.text)?.originalText?.slice(0, 50) ?? 'Пересланное сообщение'}`
                    : isGroupSysMessage(replyTo.text) ? parseGroupSysText(replyTo.text)
                    : replyTo.text}
                </Text>
              </View>
              <AppPressable onPress={() => setReplyTo(null)} style={{ padding: 4 }}>
                <Ionicons name="close" size={16} color={colors.textMuted} />
              </AppPressable>
            </View>
          ) : null}
          {grpComposeLinkUrl && !grpComposeLinkDismissed ? (
            <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4 }}>
                <View style={{ flex: 1 }}>
                  {/* Ссылку набрал сам пользователь — предпросмотр грузим всегда. */}
                  <LinkPreview url={grpComposeLinkUrl} isOutgoing={false} fromPeer={false} />
                </View>
                <AppPressable
                  onPress={() => { setGrpComposeLinkDismissed(grpComposeLinkUrl); setGrpComposeLinkUrl(null); }}
                  style={{ padding: 8 }}
                  hitSlop={8}
                >
                  <Ionicons name="close" size={18} color={colors.textMuted} />
                </AppPressable>
              </View>
            </View>
          ) : null}
          {isGrpSelecting ? (
            <View style={[gcStyles.selToolbar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
              <AppPressable style={gcStyles.selToolbarBtn} onPress={() => setSelectedGrpIds(new Set())}>
                <Ionicons name="close" size={22} color={colors.text} />
                <Text style={[gcStyles.selToolbarLabel, { color: colors.text }]}>{selectedGrpIds.size}</Text>
              </AppPressable>
              <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 4 }}>
                <AppPressable
                  style={gcStyles.selToolbarBtn}
                  onPress={() => {
                    const ids = [...selectedGrpIds];
                    Alert.alert('Удалить выбранные?', `${ids.length} сообщ.`, [
                      { text: 'Отмена', style: 'cancel' },
                      { text: 'Удалить', style: 'destructive', onPress: () => {
                        runGuardedOp(async () => {
                          await Promise.all(ids.map((id) => deleteGroupMessage(id, pid)));
                          // v4.32.232: массовое удаление, как и одиночное,
                          // чистило только свою БД.
                          for (const id of ids) {
                            announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'del', msgId: id }, myDisplayName));
                          }
                          setSelectedGrpIds(new Set());
                          void loadMessages();
                        }, 'Не удалось удалить сообщения', 'ui_group_delete_selected_failed');
                      }},
                    ]);
                  }}
                >
                  <Ionicons name="trash-outline" size={22} color={colors.error} />
                  <Text style={[gcStyles.selToolbarLabel, { color: colors.error }]}>Удалить</Text>
                </AppPressable>
                <AppPressable
                  style={gcStyles.selToolbarBtn}
                  onPress={() => {
                    // v4.32.240: пересылалось только первое из выделенных
                    // сообщений, остальные молча пропадали. Теперь все едут
                    // одним конвертом (см. makeForwardBundleText).
                    const ids = [...selectedGrpIds];
                    const picked = messages.filter((m) => ids.includes(m.id)).sort((a, b) => a.createdAt - b.createdAt);
                    if (picked.length > 0) {
                      setForwardText(makeForwardBundleText(picked.map((m) => ({
                        // v4.32.593: наружу уходит короткий ключ, а не «?» и не
                        // пометка о непрочитанном — чужому устройству знать о
                        // состоянии наших ключей незачем.
                        senderName: outwardName(m.senderName, m.senderUnreadable, shortIdentity(m.senderPubB64)),
                        text: m.text,
                      }))));
                      setSelectedGrpIds(new Set());
                    }
                  }}
                >
                  <Ionicons name="arrow-redo-outline" size={22} color={colors.accent} />
                  <Text style={[gcStyles.selToolbarLabel, { color: colors.accent }]}>Переслать</Text>
                </AppPressable>
                <AppPressable
                  style={gcStyles.selToolbarBtn}
                  onPress={() => {
                    const ids = [...selectedGrpIds];
                    runGuardedOp(async () => {
                      await Promise.all(ids.map((id) => setGroupMessageStarred(id, true)));
                      setSelectedGrpIds(new Set());
                      showSuccess('Добавлено в избранное');
                      await loadMessages();
                    }, 'Не удалось добавить в избранное');
                  }}
                >
                  <Ionicons name="star-outline" size={22} color={colors.accent} />
                  <Text style={[gcStyles.selToolbarLabel, { color: colors.accent }]}>Звезда</Text>
                </AppPressable>
                <AppPressable
                  style={gcStyles.selToolbarBtn}
                  onPress={() => {
                    const ids = [...selectedGrpIds];
                    const txt = messages.filter((m) => ids.includes(m.id)).map((m) => m.text).join('\n\n');
                    Clipboard.setString(txt);
                    showSuccess(COPIED_TEXT);
                    setSelectedGrpIds(new Set());
                  }}
                >
                  <Ionicons name="copy-outline" size={22} color={colors.accent} />
                  <Text style={[gcStyles.selToolbarLabel, { color: colors.accent }]}>{COPY_ACTION}</Text>
                </AppPressable>
              </View>
            </View>
          ) : null}
          {slowCooldownLeft > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surfaceHigh, gap: 6 }}>
              <Ionicons name="time-outline" size={15} color={colors.textMuted} />
              <Text style={{ fontSize: 13, color: colors.textMuted }}>Медленный режим: следующее через {slowCooldownLeft} с</Text>
            </View>
          ) : null}
          {grpEmojiSuggestions.length > 0 ? (
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="always"
              showsHorizontalScrollIndicator={false}
              style={{ maxHeight: 52, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface }}
              contentContainerStyle={{ paddingHorizontal: 6, alignItems: 'center', gap: 2 }}
            >
              {grpEmojiSuggestions.map(({ key, emoji }) => (
                <AppPressable
                  key={key}
                  style={{ alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginHorizontal: 2 }}
                  onPress={() => {
                    const replaced = text.replace(/:([a-z0-9_]{2,})$/, emoji);
                    setText(replaced);
                  }}
                >
                  <Text style={{ fontSize: 20 }}>{emoji}</Text>
                  <Text style={{ fontSize: 9, color: colors.textMuted, marginTop: 1 }}>{key}</Text>
                </AppPressable>
              ))}
            </ScrollView>
          ) : null}
          {showGrpFormatBar ? (
            <View style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, gap: 4 }}>
              {([
                { marker: '**', label: 'B', style: { fontWeight: '700' as const } },
                { marker: '_', label: 'I', style: { fontStyle: 'italic' as const } },
                { marker: '`', label: '<>', style: { fontFamily: 'monospace' as const } },
                { marker: '~~', label: 'S', style: { textDecorationLine: 'line-through' as const } },
                { marker: '||', label: '||', style: {} },
              ] as const).map(({ marker, label, style: btnStyle }) => (
                <AppPressable
                  key={label}
                  style={{ width: 36, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: colors.border }}
                  onPress={() => {
                    const sel = grpSelRef.current;
                    if (sel.start !== sel.end) {
                      const before = text.slice(0, sel.start);
                      const selected = text.slice(sel.start, sel.end);
                      const after = text.slice(sel.end);
                      setText(`${before}${marker}${selected}${marker}${after}`);
                    } else {
                      const before = text.slice(0, sel.start);
                      const after = text.slice(sel.start);
                      setText(`${before}${marker}${marker}${after}`);
                    }
                  }}
                >
                  <Text style={[{ fontSize: 14, color: colors.text }, btnStyle]}>{label}</Text>
                </AppPressable>
              ))}
            </View>
          ) : null}
          {grpScheduledMsgs.length > 0 ? (
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surfaceHigh, gap: 8 }}
              onPress={() => setGrpScheduledListVisible(true)}
            >
              <Ionicons name="time-outline" size={16} color={colors.accent} />
              <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '600' }}>
                {grpScheduledMsgs.length} запланированных
              </Text>
            </AppPressable>
          ) : null}
          <View style={[gcStyles.composer, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
            {/* v4.32.60: Attach (📎) — Telegram-style. Тап открывает AttachSheet-hub
                с 8 вкладками (Галерея / Камера / Файл / Геопозиция / GIF / Опрос / Ответ / Контакт).
                Группы не поддерживают live-location, onShareLiveLocation опускается. */}
            <AppPressable
              style={gcStyles.roundIconBtn}
              accessibilityRole="button"
              accessibilityLabel="Прикрепить файл"
              accessibilityHint="Удерживайте для быстрого выбора фото"
              android_ripple={{ color: colors.ripple, borderless: true, radius: 22 }}
              onLongPress={() => { requestAnimationFrame(() => { void pickGroupImage(); }); }}
              onPress={() => setGrpAttachSheetOpen(true)}
              delayLongPress={400}
              disabled={sending}
            >
              <Ionicons name="attach" size={26} color={colors.accent} />
            </AppPressable>
            {/* v4.32.58: pill-shaped capsule — TextInput + inline emoji + flash */}
            <View style={[gcStyles.inputPill, { backgroundColor: colors.surfaceHigh, borderColor: text.length > 4000 ? colors.error : colors.border }]}>
              <TextInput
                ref={grpInputRef}
                style={[gcStyles.pillText, { color: colors.text }]}
                value={text}
                onChangeText={handleTextChange}
                onSelectionChange={(e) => { grpSelRef.current = e.nativeEvent.selection; }}
                onFocus={() => setShowGrpFormatBar(true)}
                onBlur={() => setShowGrpFormatBar(false)}
                placeholder={slowCooldownLeft > 0 ? `Подождите ${slowCooldownLeft} с…` : group.type === 'channel' ? 'Новый пост…' : 'Сообщение'}
                placeholderTextColor={colors.textMuted}
                multiline
                maxLength={MAX_MESSAGE_TEXT}
              />
              {text.length > 3500 ? (
                <Text style={{ alignSelf: 'flex-end', marginBottom: 14, marginRight: 4, fontSize: 10, color: text.length > 4000 ? colors.error : colors.textMuted }}>
                  {MAX_MESSAGE_TEXT - text.length}
                </Text>
              ) : null}
              <AppPressable
                style={gcStyles.pillInlineBtn}
                accessibilityRole="button"
                accessibilityLabel={grpEmojiPanelVisible ? 'Показать клавиатуру' : 'Открыть эмодзи'}
                accessibilityState={{ expanded: grpEmojiPanelVisible }}
                android_ripple={{ color: colors.ripple, borderless: true, radius: 20 }}
                onPress={() => { setGrpEmojiPanelVisible((v) => !v); }}
              >
                <Text style={{ fontSize: 20 }}>{grpEmojiPanelVisible ? '⌨️' : '😊'}</Text>
              </AppPressable>
              <AppPressable
                style={gcStyles.pillInlineBtn}
                accessibilityRole="button"
                accessibilityLabel="Быстрые ответы"
                android_ripple={{ color: colors.ripple, borderless: true, radius: 20 }}
                onPress={() => {
                  setGrpQuickRepliesVisible(true);
                }}
              >
                <Ionicons name="flash-outline" size={20} color={colors.accent} />
              </AppPressable>
            </View>
            {/* Send / Voice OUTSIDE pill, RIGHT */}
            {text.trim() ? (
              <AppPressable
                style={[gcStyles.roundIconBtn, { backgroundColor: colors.primary }]}
                accessibilityRole="button"
                accessibilityLabel="Отправить сообщение"
                android_ripple={{ color: rippleOn(colors.primary), borderless: true, radius: 22 }}
                onPress={send}
                onLongPress={() => { if (text.trim()) setGrpScheduleVisible(true); }}
                disabled={sending}
              >
                {sending ? <ActivityIndicator color={contrastingInk(colors.primary)} size="small" /> : <Ionicons name="send" size={18} color={contrastingInk(colors.primary)} />}
              </AppPressable>
            ) : (
              <VoiceRecorderButton
                disabled={sending}
                onRecorded={(r: VoiceRecordingResult) => {
                  void (async () => {
                    setSending(true);
                    try {
                      // v4.32.242: раньше в группу уходил только локальный путь
                      // записи — на других устройствах такого файла нет, поэтому
                      // групповое голосовое не проигрывалось ни у кого, кроме
                      // отправителя. Кладём запись в зашифрованное вложение
                      // (тот же путь, что в личных чатах): ключ едет внутри уже
                      // зашифрованного конверта группы, на relay лежит только шифртекст.
                      // v4.32.562: см. ChatScreen — отказ по размеру называется
                      // своим именем, а не «проверьте соединение».
                      const tooBig = voiceUploadRefusal(await fileSizeBytes(r.uri), MAX_BLOB_BYTES);
                      if (tooBig) throw new Error(tooBig);
                      const blob = await uploadEncryptedBlob(r.uri, 'audio/m4a');
                      if (!blob) throw new Error('Голосовое не загрузилось. Проверьте соединение и повторите.');
                      const voiceText = makeVoiceText(r.uri, r.durationMs, blob);
                      const row: GroupMessageRow = {
                        id: uuidv4(),
                        groupId: group.id,
                        senderPubB64: myPubB64,
                        senderName: myDisplayName,
                        text: voiceText,
                        mediaCids: null,
                        replyToId: null,
                        replyToPreview: null,
                        reactions: null,
                        createdAt: Date.now(),
                        ownerProfileId: pid,
                      };
                      await insertGroupMessage(row);
                      await touchGroupConversation(group.id, pid, '🎤 Голосовое сообщение', false, myDisplayName, false, myPubB64);
                      announceGroupSend(fanoutGroupMessage(group.id, voiceText, myDisplayName, myPubB64, row.id));
                      await loadMessages();
                    } catch (e) {
                      await deleteCachedFileUris([r.uri]).catch(() => {});
                      showError(userErrorText(e, 'Не удалось отправить голосовое'));
                    } finally {
                      setSending(false);
                    }
                  })();
                }}
              />
            )}
          </View>
          {grpEmojiPanelVisible ? (
            <EmojiPanel
              onEmoji={(emoji) => { setText((t) => t + emoji); }}
              colors={colors}
            />
          ) : null}
        </View>
      ) : (
        <View style={[gcStyles.channelReadOnly, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
          <Ionicons
            name={sendVerdict.code === 'channel_admin_only' ? 'megaphone-outline' : 'lock-closed-outline'}
            size={16}
            color={colors.textMuted}
            style={{ marginRight: 6 }}
          />
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            {sendVerdict.code === 'channel_admin_only' ? 'Канал — только подписка' : sendVerdict.reason}
          </Text>
        </View>
      )}

      {/* Pinned messages list modal */}
      <GroupPinnedListModal
        visible={grpPinnedListVisible}
        onClose={closePinnedList}
        pinnedList={grpPinnedList}
        canPin={canPin}
        onJumpTo={handlePinnedJumpTo}
        onUnpin={handlePinnedUnpin}
      />

      {/* Forward message */}
      {/* Reaction detail modal — tabbed */}
      {reactionDetailGrp ? (
        <GroupReactionDetailModal
          target={reactionDetailGrp}
          myPubB64={myPubB64}
          allMembers={allMembers}
          onClose={() => setReactionDetailGrp(null)}
        />
      ) : null}

      {/* Message info modal */}
      {grpMsgInfoTarget ? (
        <GrpMessageInfoModal msg={grpMsgInfoTarget} onClose={() => setGrpMsgInfoTarget(null)} />
      ) : null}

      {/* Seen by modal */}
      <GroupSeenByModal msg={seenByMsg} allMembers={allMembers} onClose={() => setSeenByMsg(null)} />

      {/* Full emoji picker for any-emoji group reactions */}
      <GroupReactionsMoreModal
        visible={grpReactMoreVisible && !!quickReact}
        onClose={() => { setGrpReactMoreVisible(false); setQuickReact(null); }}
        onReact={(e) => { if (quickReact) void applyReaction(quickReact, e); }}
      />

      <ForwardModal
        visible={forwardText !== null}
        text={forwardText ?? ''}
        pair={pair}
        onClose={() => setForwardText(null)}
        onForwarded={() => setForwardText(null)}
      />

      <GroupSharedMediaModal
        visible={mediaGalleryVisible}
        groupId={group.id}
        ownerProfileId={pid}
        gateway={gateway}
        onClose={() => setMediaGalleryVisible(false)}
      />

      <WallpaperPickerModal
        visible={wallpaperPickerVisible}
        peerB64={`grp_${group.id}`}
        current={grpWallpaper}
        onClose={() => setWallpaperPickerVisible(false)}
        onApply={(wp) => setGrpWallpaper(wp)}
      />

      {/* Quick replies modal */}
      <GroupQuickRepliesModal
        visible={grpQuickRepliesVisible}
        onClose={() => setGrpQuickRepliesVisible(false)}
        onPick={(qr) => setText((prev) => prev + (prev ? ' ' : '') + qr)}
        groupId={group.id}
      />

      {/* Group statistics panel */}
      <GroupStatsModal
        visible={grpStatsVisible}
        onClose={closeGrpStats}
        grpStats={grpStats}
        memberCount={group.memberCount}
      />

      {/* Recently deleted group messages panel */}
      <GroupRecentlyDeletedModal
        visible={grpRecentlyDeletedVisible}
        onClose={closeGrpRecentlyDeleted}
        items={grpRecentlyDeletedList}
        onRestore={handleGrpRestoreDeleted}
      />

      {/* Starred messages panel */}
      <GroupStarredModal
        visible={starredVisible}
        onClose={closeStarred}
        starredEntries={starredEntries}
        setStarredEntries={setStarredEntries}
        onReload={reloadStarred}
      />

      {/* Scheduled messages */}
      <ScheduleModal
        visible={grpScheduleVisible}
        onClose={() => setGrpScheduleVisible(false)}
        onSchedule={(sendAt) => void (async () => {
          const txt = text.trim();
          if (!txt) return;
          // v4.32.428: см. doSchedule в ChatScreen — здесь была ровно та же
          // дыра. scheduleGroupMessage бросает на времени и на длине текста, а
          // ловить отказ было некому: окно закрывалось молча.
          try {
            await scheduleGroupMessage(group.id, txt, sendAt, myDisplayName, myPubB64);
          } catch (e) {
            log.warn('schedule_group_failed', { err: rawErrorText(e) });
            showError(userErrorText(e, 'Не удалось запланировать отправку'));
            return;
          }
          setText('');
          // v4.32.324: раньше отложенная запись оставалась жить — черновик
          // возвращался в поле через 600 мс после того, как сообщение уже
          // запланировано.
          clearGroupDraft();
          await reloadGrpScheduled();
          showSuccess('Сообщение запланировано');
        })()}
      />
      <ScheduledListModal
        visible={grpScheduledListVisible}
        onClose={closeGrpScheduledList}
        scheduled={grpScheduledMsgs}
        onDelete={handleDeleteGrpScheduled}
      />

      {/* Poll creator */}
      <PollCreatorModal
        visible={pollVisible}
        onClose={() => setPollVisible(false)}
        onCreate={(question, options, correctAnswer, anonymous, allowMultiple) => {
          // v4.32.48: ловим PollValidationError до создания group-message/envelope.
          let pollText: string;
          try {
            pollText = makePollText(question, options, correctAnswer, anonymous, allowMultiple);
          } catch (err) {
            Alert.alert('Ошибка опроса', userErrorText(err, 'Проверьте вопрос и варианты ответа'));
            return;
          }
          const isQuizPoll = correctAnswer !== undefined;
          void (async () => {
            setSending(true);
            try {
              const row: GroupMessageRow = {
                id: uuidv4(),
                groupId: group.id,
                senderPubB64: myPubB64,
                senderName: myDisplayName,
                text: pollText,
                mediaCids: null,
                replyToId: null,
                replyToPreview: null,
                reactions: null,
                createdAt: Date.now(),
                ownerProfileId: pid,
              };
              await insertGroupMessage(row);
              await touchGroupConversation(group.id, pid, isQuizPoll ? '🧠 Викторина' : allowMultiple ? '☑️ Опрос' : '📊 Опрос', false, myDisplayName, false, myPubB64);
              announceGroupSend(fanoutGroupMessage(group.id, pollText, myDisplayName, myPubB64, row.id));
              await loadMessages();
            } catch (e) {
              showError(userErrorText(e, 'Не удалось отправить опрос'));
            } finally {
              setSending(false);
            }
          })();
        }}
      />

      {/* v4.32.57: Telegram-style preview — бейджи 1..N, "+Добавить", счётчик. */}
      <MediaPreviewModal
        visible={pendingGrpImageUris.length > 0}
        uris={pendingGrpImageUris}
        caption={grpImageCaption}
        viewOnce={grpImageViewOnce}
        maxImages={CHAT_MAX_IMAGES}
        onCaptionChange={setGrpImageCaption}
        onViewOnceChange={(v) => setGrpImageViewOnce(v)}
        onRemoveAt={(i) => setPendingGrpImageUris((u) => u.filter((_, j) => j !== i))}
        onClearAll={() => setPendingGrpImageUris([])}
        onAddMore={() => { void pickGroupImage(); }}
        onCancel={() => { setPendingGrpImageUris([]); setGrpImageCaption(''); setGrpImageViewOnce(false); }}
        onSend={() => {
          const uris = pendingGrpImageUris;
          const caption = grpImageCaption;
          const vo = grpImageViewOnce;
          setPendingGrpImageUris([]);
          setGrpImageCaption('');
          setGrpImageViewOnce(false);
          if (caption) setText('');
          void sendGroupImages(uris, caption, vo);
        }}
      />
      <GifPickerModal
        visible={grpGifPickerVisible}
        onClose={() => setGrpGifPickerVisible(false)}
        onSelect={(gifText) => void sendGroupGif(gifText)}
      />
      {/* v4.32.60: Telegram-style attach hub — 8 tabs (live-location скрыт для групп) */}
      <AttachSheet
        visible={grpAttachSheetOpen}
        onClose={() => setGrpAttachSheetOpen(false)}
        onPickGalleryAssets={handleGroupAcceptGalleryAssets}
        onOpenCamera={handleGroupCameraCapture}
        onOpenImagePicker={() => { void pickGroupImage(); }}
        onOpenDocumentPicker={() => { void pickGroupDoc(); }}
        onSendLocation={() => { void sendGroupLocation(); }}
        onOpenGifPicker={() => setGrpGifPickerVisible(true)}
        onOpenPollComposer={() => setPollVisible(true)}
        onPickQuickReply={handleGroupPickQuickReply}
        onShareContact={handleGroupShareContact}
        profileId={pid}
        allowPoll={true}
        // Без ключа Tenor поиск GIF физически не работает — кнопку не показываем.
        allowGif={isGifSearchAvailable()}
        allowContact={true}
      />
      {sendEffectParticles ? (
        <SendEffectOverlay
          particles={sendEffectParticles}
          onDone={() => setSendEffectParticles(null)}
        />
      ) : null}

      {/* Full-screen media viewer */}
      {grpMediaViewer.element}

      {/* Send effect overlay (confetti, fireworks, etc.) */}
      {sendEffectParticles ? (
        <SendEffectOverlay
          particles={sendEffectParticles}
          onDone={() => setSendEffectParticles(null)}
        />
      ) : null}

      {/* v4.32.227 (BUG-09): тёмный прокручиваемый action-sheet (настройки группы/
          канала, действия с сообщением, вложенные подменю). BACK/тап по подложке
          закрывают (onRequestClose + backdrop в ActionSheet). */}
      <ActionSheet state={actionSheet} onClose={() => setActionSheet(null)} />
    </View>
  );
}

const gcStyles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  iconBtn: { padding: 8 },
  headerInfo: { flex: 1 },
  headerName: { fontSize: 17, fontWeight: '600' },
  headerSub: { fontSize: 12, marginTop: 1 },
  msgWrap: { paddingHorizontal: 12, paddingVertical: 2 },
  msgIn: { alignItems: 'flex-start' },
  msgOut: { alignItems: 'flex-end' },
  senderName: { fontSize: 12, fontWeight: '600', marginBottom: 2, marginLeft: 4 },
  bubble: { maxWidth: '80%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleText: { fontSize: 15 },
  timeText: { fontSize: 10, marginTop: 3, textAlign: 'right' },
  empty: { alignItems: 'center', paddingTop: 60, gap: 12 },
  emptyText: { fontSize: 15 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 6, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, gap: 4 },
  // v4.32.58: Telegram-style pill-shaped composer
  inputPill: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: 22, paddingLeft: 14, paddingRight: 2, minHeight: 42 },
  pillText: { flex: 1, paddingVertical: 10, paddingRight: 6, maxHeight: 120, fontSize: 15 },
  pillInlineBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  roundIconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  // legacy (на случай если где-то ещё используется)
  input: { flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 15, maxHeight: 120 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  channelReadOnly: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  quotedBlock: { flexDirection: 'row', alignItems: 'stretch', borderRadius: 6, marginBottom: 4, overflow: 'hidden', maxWidth: '80%' },
  quotedBar: { width: 3 },
  quotedText: { flex: 1, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4, fontStyle: 'italic' },
  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4, marginHorizontal: 12 },
  reactionChip: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, gap: 3 },
  reactionCount: { fontSize: 12, fontWeight: '600' },
  reactionOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: scrim.modal },
  reactionPicker: { borderRadius: 16, paddingTop: 12, paddingHorizontal: 8, minWidth: 300 },
  reactionPickerRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4, paddingBottom: 8 },
  reactionPickerBtn: { padding: 10 },
  replyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  replyBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  replyBarText: { flex: 1, fontSize: 13 },
  mentionList: { borderTopWidth: StyleSheet.hairlineWidth, maxHeight: 160 },
  mentionItem: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  mentionName: { fontSize: 14, fontWeight: '600' },
  mentionSkipped: { fontSize: 12, fontStyle: 'italic', paddingHorizontal: 16, paddingVertical: 8 },
  searchInput: { flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, fontSize: 15 },
  scrollBottomBtn: {
    position: 'absolute',
    bottom: 70,
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  pinnedBanner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth },
  pinnedText: { flex: 1, fontSize: 12, fontStyle: 'italic' },
  selCircle: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  selToolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  selToolbarBtn: { alignItems: 'center', gap: 3, paddingHorizontal: 8 },
  selToolbarLabel: { fontSize: 11, fontWeight: '600' },
});

// ─────────────────────────────────────────────────────────────────────────────
// GroupMembersScreen
// ─────────────────────────────────────────────────────────────────────────────

function GroupMembersScreen({
  group,
  pair,
  onBack,
  onOpenDm,
}: {
  group: GroupRow;
  pair: KeyPairBytes;
  onBack: () => void;
  onOpenDm?: (peerPubB64: string, displayName: string) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [members, setMembers] = useState<GroupMemberRow[]>([]);
  const [bannedMembers, setBannedMembers] = useState<GroupMemberRow[]>([]);
  const myPubB64 = useMemo(() => Buffer.from(pair.publicKey).toString('base64'), [pair]);
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  const myName = profileManager.getActiveProfile()?.name ?? 'Администратор';
  /**
   * Своя роль — нужна, чтобы спросить canModerate до отправки конверта.
   *
   * v4.32.512: см. тот же разбор на экране переписки. Строка в group_members
   * идёт первой, `groups.is_admin` — только пока список не прочитан.
   */
  const myMemberRole = useMemo<GroupMemberRow['role']>(
    () => ownGroupRole(members, myPubB64, !!group.isAdmin) as GroupMemberRow['role'],
    [members, myPubB64, group.isAdmin]
  );
  const amAdmin = isAdminRole(myMemberRole);
  const [avatarCid, setAvatarCid] = useState<string | null>(group.avatarCid ?? null);
  const [gateway, setGateway] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(group.name);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descInput, setDescInput] = useState(group.description ?? '');
  /**
   * v4.32.515: «сохранено ли уже это значение» спрашиваем у себя, а не у
   * пропа. `group` приезжает из навигационного состояния и после записи в базу
   * не обновляется — то есть заморожен на том, что было при входе на карточку.
   * Подробный разбор обеих бед, которые из этого следовали, — в editCommitGate.
   */
  const nameGate = useRef(createEditCommitGate(group.name)).current;
  const descGate = useRef(createEditCommitGate(group.description ?? '')).current;
  // Join requests
  const [joinRequests, setJoinRequests] = useState<GroupJoinRequest[]>([]);
  const [joinReqVisible, setJoinReqVisible] = useState(false);
  const pendingCount = joinRequests.length;
  // Admin log
  const [adminLogVisible, setAdminLogVisible] = useState(false);
  const [adminLogEntries, setAdminLogEntries] = useState<GroupMessageRow[]>([]);

  const loadJoinRequests = useCallback(async () => {
    if (!amAdmin) return;
    const reqs = await listGroupJoinRequests(group.id, pid, 'pending');
    setJoinRequests(reqs);
  }, [amAdmin, group.id, pid]);

  const loadAdminLog = useCallback(async () => {
    if (!amAdmin) return;
    const all = await listGroupMessages({ groupId: group.id, limit: 500, offset: 0, ownerProfileId: pid });
    // v4.32.532: пустой журнал у группы с историей — заметная ложь: по нему
    // судят, кого исключили и кто менял настройки.
    if (!shouldApplyRows(all)) { showError('Не удалось прочитать журнал группы'); return; }
    setAdminLogEntries(all.filter((m) => isGroupSysMessage(m.text)).reverse());
  }, [amAdmin, group.id, pid]);

  useEffect(() => {
    void import('../../core/config').then((m) => m.loadConfig()).then((c) => setGateway(c.ipfs.gatewayUrl.replace(/\/$/, '')));
    void loadJoinRequests();
  }, [loadJoinRequests]);

  const uploadAvatar = useCallback(async () => {
    if (!amAdmin) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { showPermissionDeniedAlert('Фото', 'Для прикрепления изображения нужен доступ к галерее.'); return; }
    // v4.32.54: quality:1 + exif:false — avoid expo-image-picker 16.1.4 CompressionImageExporter crash.
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1, exif: false, allowsEditing: true, aspect: [1, 1] });
    if (res.canceled || !res.assets[0]) return;
    try {
      // v4.32.246: на телефоне IPFS выключен, addToIpfs всегда возвращал null —
      // то есть аватар группы поставить было нельзя в принципе. Запасной путь
      // тот же, что у фотографий: зашифрованное вложение.
      const { uploadMediaToCid } = await import('../../core/media/mediaUpload');
      const { formatLimit } = await import('../../core/media/uploadRoute');
      const up = await uploadMediaToCid(res.assets[0].uri, { mime: guessImageMime(res.assets[0].uri) });
      if (!up.ok) {
        showError(
          up.reason === 'oversize'
            ? `Снимок слишком большой: предел — ${formatLimit(up.limitBytes)}`
            : 'Не удалось загрузить аватар'
        );
        return;
      }
      const cid = up.cid;
      await updateGroupMeta(group.id, pid, { avatarCid: cid });
      setAvatarCid(cid);
      // Раньше аватар оставался локальным: остальные участники видели кружок с
      // буквой, даже когда админ его менял.
      announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'meta', avatarCid: cid }, myName));
      // v4.32.265: системную строку об аватаре писали только получатели
      // конверта. У сменившего аватар в истории следа не оставалось — как и с
      // переименованием группы, которое строку пишет с обеих сторон.
      await insertGroupSysMessage(group.id, pid, myPubB64, 'Аватар группы обновлён');
      showSuccess('Аватар обновлён');
    } catch (e) {
      showError(userErrorText(e, 'Не удалось сменить аватар группы'));
    }
  }, [amAdmin, group.id, pid, myPubB64, myName]);

  const saveName = useCallback(async () => {
    // Потолок тот же, что в разборе конверта (sanitizeName, 128): иначе своё
    // название сохранится длиннее, чем доедет до остальных.
    //
    // v4.32.379: и правило то же, а не только число. Одного потолка мало:
    // название уходит в системную строку подстановкой («Группа переименована в
    // «X»»), то есть перевод строки внутри него дописывает к системному
    // сообщению вторую строку — ровно та подделка, ради которой написан
    // sysLineGuard. У получателей она не появлялась (там чистка была), у автора
    // появлялась.
    const n = normalizeOwnGroupName(nameInput);
    // v4.32.515: калитка вместо сравнения с пропом. Она же отсекает второй
    // заход: клавиша «готово» снимает фокус, поэтому onSubmitEditing и onBlur
    // приходят оба и оба успевают войти сюда до первого await.
    if (!n || !nameGate.begin(n)) { setEditingName(false); return; }
    try {
      await updateGroupMeta(group.id, pid, { name: n });
      nameGate.commit(n);
      showSuccess('Название обновлено');
      await insertGroupSysMessage(group.id, pid, myPubB64, `Группа переименована в «${n}»`);
      announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'meta', name: n }, myName));
    } catch {
      // Раньше отказ базы улетал необработанным отклонением обещания: поле
      // закрывалось, название на экране менялось, в базе оставалось прежнее.
      nameGate.rollback();
      showError('Не удалось переименовать группу');
    } finally {
      setEditingName(false);
    }
  }, [nameInput, nameGate, group.id, pid, myPubB64, myName]);

  const saveDesc = useCallback(async () => {
    /**
     * v4.32.261: `description: d || undefined` расходилось с рассылкой.
     * updateGroupMeta пропускает undefined (`if (patch.description !== undefined)`),
     * поэтому очистка описания у себя не применялась — а в конверте уходило
     * `description: ''`, и у всех остальных описание исчезало. Поле стиралось
     * у всех, кроме того, кто его стёр, и при следующем открытии карточки
     * возвращалось на экран.
     *
     * Пустая строка — законное значение «описания нет», ровно её и пишем.
     * Потолок тот же, что в разборе конверта (512), иначе своё описание
     * сохранится длиннее, чем доедет до остальных.
     *
     * v4.32.379: и правило то же, а не только число. Описание рисуется обычным
     * <Text> в карточке группы — ради него и написана sanitizeParagraphText
     * (v4.32.373). Чужое ею чистилось, своё — нет, поэтому у автора его
     * собственная карточка растягивалась пятьюстами переводами строки и
     * разворачивалась меткой U+202E. Считается и длина: пустые строки подряд
     * схлопываются ДО обрезки, так что свои 512 символов и чужие 512 — разные.
     */
    const d = normalizeOwnGroupDescription(descInput);
    /**
     * v4.32.579: поле правки заполняется из `group.description`, а он у
     * непрочитанного столбца null. Выход из фокуса записал бы пустую строку
     * поверх целого шифртекста и разослал бы её всем участникам — потеря,
     * которую уже нечем откатить. См. decideOwnDescriptionWrite.
     */
    if (!decideOwnDescriptionWrite(d, group.descriptionUnreadable).write) {
      setEditingDesc(false);
      showError('Описание не удалось прочитать — напишите новое, чтобы его заменить');
      return;
    }
    // Пустая строка — законное значение «описания нет», поэтому проверяется
    // только «менять есть что» (см. v4.32.261 выше), но у той же калитки, что
    // и название: проп с описанием заморожен ровно так же.
    if (!descGate.begin(d)) { setEditingDesc(false); return; }
    try {
      await updateGroupMeta(group.id, pid, { description: d });
      descGate.commit(d);
      showSuccess(d ? 'Описание обновлено' : 'Описание удалено');
      announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'meta', description: d }, myName));
    } catch {
      descGate.rollback();
      showError('Не удалось сохранить описание');
    } finally {
      setEditingDesc(false);
    }
  }, [descInput, descGate, group.id, group.descriptionUnreadable, pid, myPubB64, myName]);

  // v4.32.230: забаненные хранятся как строки с role='banned' — в списке
  // участников их показывать нельзя (иначе бан выглядит как обычный участник).
  const loadMembers = useCallback(async (): Promise<void> => {
    const ms = await listGroupMembers(group.id, pid);
    setMembers(ms.filter((m) => m.role !== 'banned'));
    setBannedMembers(ms.filter((m) => m.role === 'banned'));
  }, [group.id, pid]);

  /** Снятие бана из карточки группы — то же, что команда /unban. */
  const unbanMember = useCallback((m: GroupMemberRow): void => {
    const name = m.displayName ?? shortIdentity(m.peerPubB64);
    Alert.alert(`Разблокировать ${name}?`, 'Участник снова сможет читать и писать в группу.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Разблокировать',
        onPress: () => {
          void updateGroupMemberRole(group.id, m.peerPubB64, 'member', pid).then(async () => {
            await recountGroupMembers(group.id, pid);
            await insertGroupSysMessage(group.id, pid, myPubB64, `${name} разблокирован(а)`);
            announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'unban', target: m.peerPubB64, targetName: name }, myName));
            await loadMembers();
            showSuccess(`${name} разблокирован`);
          }).catch(() => showError('Не удалось разблокировать участника'));
        },
      },
    ]);
  }, [group.id, pid, myPubB64, myName, loadMembers]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);


  const kickMember = (m: GroupMemberRow) => {
    if (!amAdmin || m.peerPubB64 === myPubB64) return;
    // v4.32.255: раньше проверялось только «я админ и это не я». Владельца и
    // другого админа экран исключал локально, а конверт у всех остальных
    // отбрасывался — участник пропадал из списка только у того, кто нажал.
    const verdict = canModerate(myMemberRole, m.role);
    if (!verdict.allowed) { Alert.alert('Недостаточно прав', verdict.reason); return; }
    Alert.alert(`Исключить ${m.displayName ?? '?'}?`, '', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Исключить', style: 'destructive',
        onPress: () => {
          void removeGroupMember(group.id, m.peerPubB64, pid).then(async () => {
            await recountGroupMembers(group.id, pid);
            await insertGroupSysMessage(group.id, pid, myPubB64, `${m.displayName ?? 'Участник'} исключён(а) из группы`);
            announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'kick', target: m.peerPubB64, targetName: m.displayName ?? undefined }, myName));
            await loadMembers();
          }).catch(() => showError('Не удалось исключить участника'));
        },
      },
    ]);
  };

  const avatarUri = useResolvedMediaUrl(avatarCid, gateway);
  const [selectedMember, setSelectedMember] = useState<GroupMemberRow | null>(null);

  /**
   * Смена роли из карточки участника: проверка прав, подтверждение, запись в
   * свою базу, системная строка, рассылка конверта и тост.
   *
   * v4.32.255: здесь не хватало обеих проверок сразу. Во-первых, прав: снять
   * админа мог другой админ, и снималось это только у него — конверт остальные
   * отбрасывали (решает владелец). Во-вторых, и это важнее: fanoutGroupControl
   * не вызывался ВООБЩЕ. Роль менялась в своей базе, писалась своя системная
   * строка — и на этом всё. Команда /promote рассылала, а карточка участника
   * (то есть основной способ выдать права) — нет.
   *
   * v4.32.258: вынесено из обработчика, потому что действий стало два —
   * админка и ограничение отправки, — и второе повторило бы первое целиком.
   */
  const changeMemberRole = (m: GroupMemberRow, newRole: AssignableRole, question: string) => {
    const verdict = canModerate(myMemberRole, m.role);
    if (!verdict.allowed) { Alert.alert('Недостаточно прав', verdict.reason); return; }
    const memberName = m.displayName ?? shortIdentity(m.peerPubB64);
    /**
     * v4.32.514: обе кнопки карточки — переключатели, поэтому роль в них
     * заведомо другая… пока список в состоянии React свежий. Конверт,
     * пришедший между отрисовкой и нажатием, делает его несвежим — и
     * переключатель считает «следующую» роль от устаревшей, то есть ту же
     * самую. Дальше всё как у /promote: строка в своей истории, тост об
     * успехе и конверт, который получатели отбрасывают.
     */
    const already = roleChangeNoopText(newRole, m.role, memberName);
    if (already) { Alert.alert('AirChat', already); return; }
    Alert.alert('Изменить роль', `${memberName} — ${question}?`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Подтвердить',
        onPress: () => {
          const sysText = roleChangeSysText(newRole, m.role, memberName, false);
          void updateGroupMemberRole(group.id, m.peerPubB64, newRole, pid).then(async () => {
            setSelectedMember(null);
            void loadMembers();
            await insertGroupSysMessage(group.id, pid, myPubB64, sysText);
            announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'role', target: m.peerPubB64, role: newRole, targetName: memberName }, myName));
            showSuccess(sysText);
          }).catch(() => showError('Не удалось изменить роль'));
        },
      },
    ]);
  };
  const [memberSearch, setMemberSearch] = useState('');
  /**
   * v4.32.606: имя, которое не открыл ключ, приходит как null — сравнение с
   * запросом его никогда не находило, и участник исчезал из состава именно
   * там, откуда его снимают или банят. Теперь он не совпадает, но и не
   * молчит: под строкой поиска сказано, скольких имён мы не прочитали.
   */
  const memberHits = searchMembersByName(members, memberSearch);
  const filteredMembers = memberHits.matched;
  const memberSkipped = memberSkippedNotice(memberHits.unreadable);
  const [qrVisible, setQrVisible] = useState(false);
  const [qrLink, setQrLink] = useState('');
  /**
   * v4.32.303: ссылка собирается по нажатию, а не при каждой отрисовке.
   *
   * Раньше её строили прямо в теле компонента — тогда она состояла из одних
   * открытых данных группы. Теперь в неё входит токен, а он лежит в БД и у
   * старых групп может отсутствовать; завести его — запись, которой в отрисовке
   * не место. Заодно ушла и лишняя работа: ссылку пересобирало каждое
   * перерисовывание экрана, хотя нужна она в двух кнопках из десятка.
   */
  const buildInviteLink = useCallback(async (): Promise<string> => {
    const invite = await ensureGroupInviteToken(group.id, pid, myPubB64, myName);
    // Оба вызывающих уже показывают «Не удалось собрать ссылку» по отказу.
    if (invite === null) throw new Error('group_invite_token_unavailable');
    announceInviteToken(invite.announced);
    return buildGroupInviteLink({
      id: group.id,
      name: group.name,
      type: group.type,
      adminPub: myPubB64,
      requireApproval: group.requireApproval ?? false,
      members,
      token: invite.token,
    });
  }, [group.id, group.name, group.type, group.requireApproval, myPubB64, myName, members, pid]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[gcStyles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <AppPressable onPress={onBack} style={gcStyles.iconBtn} accessibilityRole="button" accessibilityLabel="Назад к группе">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </AppPressable>
        <Text style={[gcStyles.headerName, { color: colors.text, flex: 1 }]}>Информация о группе</Text>
        {/*
          * v4.32.260: приглашение — действие администратора. Ссылка объявляет
          * своего автора администратором группы (adminPub), и по нему
          * вступивший шлёт заявку и принимает ответное приглашение. У обычного
          * участника такая ссылка — ложное заявление: заявку разбирать некому,
          * а вступивший запишет его админом у себя. Раньше обе кнопки, QR и
          * «поделиться», показывались всем.
          */}
        {amAdmin ? (
          <>
            <AppPressable
              style={gcStyles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Показать QR-код приглашения"
              onPress={() => { void buildInviteLink().then((link) => { setQrLink(link); setQrVisible(true); }).catch(() => showError('Не удалось собрать ссылку')); }}
            >
              <Ionicons name="qr-code-outline" size={22} color={colors.accent} />
            </AppPressable>
            <AppPressable
              style={gcStyles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel="Пригласить участников"
              onPress={() => {
                // Тот же сборщик, что и в остальных трёх местах: раньше здесь
                // уходил ВЕСЬ список участников без ограничения и без
                // requireApproval — то есть ссылка из шапки вела мимо гейта.
                void buildInviteLink()
                  .then((link) => Share.share({ message: `Присоединяйся к группе "${group.name}" в AirChat:\n${link}` }))
                  .catch(() => showError('Не удалось собрать ссылку'));
              }}
            >
              <Ionicons name="person-add-outline" size={22} color={colors.accent} />
            </AppPressable>
          </>
        ) : null}
        {amAdmin && pendingCount > 0 ? (
          <AppPressable style={[gcStyles.iconBtn, { position: 'relative' }]} onPress={() => setJoinReqVisible(true)} accessibilityRole="button" accessibilityLabel={`Заявки на вступление: ${pendingCount}`}>
            <Ionicons name="person-circle-outline" size={22} color={colors.accent} />
            <View style={{ position: 'absolute', top: 4, right: 4, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.errorFill, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: contrastingInk(colors.errorFill), fontSize: 9, fontWeight: '700' }}>{pendingCount > 9 ? '9+' : String(pendingCount)}</Text>
            </View>
          </AppPressable>
        ) : null}
        {amAdmin ? (
          <AppPressable style={gcStyles.iconBtn} onPress={() => { void loadAdminLog().then(() => setAdminLogVisible(true)); }} accessibilityRole="button" accessibilityLabel="Журнал действий администраторов">
            <Ionicons name="shield-checkmark-outline" size={22} color={colors.accent} />
          </AppPressable>
        ) : null}
      </View>

      {/* QR code invite modal */}
      <GroupQrModal
        visible={qrVisible}
        onClose={() => setQrVisible(false)}
        groupName={group.name}
        inviteLinkQr={qrLink}
      />

      {/* Group info header */}
      <View style={[gmStyles.infoHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <AppPressable onPress={() => void uploadAvatar()} disabled={!amAdmin} accessibilityRole="button" accessibilityLabel="Изменить фото группы" accessibilityState={{ disabled: !amAdmin }}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={gmStyles.avatarLarge} />
          ) : (
            <GroupAvatar name={group.name} size={80} type={group.type} />
          )}
          {amAdmin ? (
            <View style={[gmStyles.avatarEditBadge, { backgroundColor: colors.primary }]}>
              <Ionicons name="camera" size={14} color={contrastingInk(colors.primary)} />
            </View>
          ) : null}
        </AppPressable>
        <View style={{ flex: 1, gap: 4 }}>
          {editingName ? (
            <TextInput
              style={[gmStyles.nameInput, { color: colors.text, borderColor: colors.primary }]}
              value={nameInput}
              onChangeText={setNameInput}
              onSubmitEditing={() => void saveName()}
              onBlur={() => void saveName()}
              maxLength={OWN_GROUP_NAME_MAX}
              autoFocus
              returnKeyType="done"
            />
          ) : (
            <AppPressable onPress={amAdmin ? () => setEditingName(true) : undefined}>
              <Text style={[gcStyles.headerName, { color: colors.text }]}>{nameInput}</Text>
            </AppPressable>
          )}
          {editingDesc ? (
            <TextInput
              style={[gmStyles.descInput, { color: colors.textSecondary, borderColor: colors.border }]}
              value={descInput}
              onChangeText={setDescInput}
              onBlur={() => void saveDesc()}
              placeholder="Описание группы…"
              placeholderTextColor={colors.textMuted}
              maxLength={OWN_GROUP_DESC_MAX}
              multiline
              autoFocus
            />
          ) : (
            <AppPressable onPress={amAdmin ? () => setEditingDesc(true) : undefined}>
              <Text style={[{ color: colors.textSecondary, fontSize: 13 }]} numberOfLines={2}>
                {descInput || (amAdmin ? '+ Добавить описание' : '')}
              </Text>
            </AppPressable>
          )}
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>{membersLabel(members.length)}</Text>
        </View>
      </View>

      <View style={{ paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceHigh, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, gap: 6 }}>
          <Ionicons name="search" size={15} color={colors.textMuted} />
          <TextInput
            style={{ flex: 1, color: colors.text, fontSize: 14 }}
            value={memberSearch}
            onChangeText={setMemberSearch}
            placeholder="Поиск участников…"
            placeholderTextColor={colors.textMuted}
          />
          {memberSearch ? (
            <AppPressable onPress={() => setMemberSearch('')}><Ionicons name="close-circle" size={16} color={colors.textMuted} /></AppPressable>
          ) : null}
        </View>
        {memberSkipped !== null ? (
          <Text style={{ color: colors.warning, fontSize: 12, fontStyle: 'italic', marginTop: 6 }}>{memberSkipped}</Text>
        ) : null}
      </View>
      <FlatList
        data={filteredMembers}
        keyExtractor={(m) => m.peerPubB64}
        renderItem={({ item }) => {
          const isMe = item.peerPubB64 === myPubB64;
          return (
            <AppPressable
              style={[gmStyles.row, { borderBottomColor: colors.border }]}
              onPress={() => !isMe && setSelectedMember(item)}
              onLongPress={() => kickMember(item)}
              delayLongPress={500}
            >
              {/* Кружок участника окрашен по хешу ключа — это различитель, а
                  не роль палитры (v4.32.398); правило вывода общее на все
                  экраны (v4.32.399). */}
              {(() => {
                const avatar = identityAvatar(item.peerPubB64);
                return (
                  <View style={[gmStyles.avatar, { backgroundColor: avatar.fill }]}>
                    <Text style={[gmStyles.avatarLetter, { color: avatar.ink }]}>{nameInitial(item.displayName)}</Text>
                  </View>
                );
              })()}
              <View style={{ flex: 1 }}>
                {/* v4.32.595: непрочитанное имя не притворяется коротким ключом —
                    иначе строка состава неотличима от «человек не назвался», а
                    решения об исключении и правах принимают именно здесь. */}
                <Text style={[gmStyles.name, { color: item.displayNameUnreadable ? colors.warning : colors.text }]}>
                  {shownName(item.displayName, item.displayNameUnreadable, shortIdentity(item.peerPubB64))}{isMe ? ' (вы)' : ''}
                </Text>
                {/* v4.32.383: было `colors.accent` на любую роль, кроме 'member', —
                    то есть подпись «Заблокирован» шла фирменным акцентом. */}
                {roleLabel(item.role) ? (
                  <Text style={[gmStyles.role, { color: colors[roleTone(item.role) ?? 'textMuted'] }]}>{roleLabel(item.role)}</Text>
                ) : null}
              </View>
              {!isMe ? <Ionicons name="chevron-forward" size={16} color={colors.textMuted} /> : null}
            </AppPressable>
          );
        }}
        ListEmptyComponent={<View style={{ alignItems: 'center', paddingTop: 40 }}><Text style={{ color: colors.textMuted }}>Нет участников</Text></View>}
        ListFooterComponent={amAdmin && bannedMembers.length > 0 && !memberSearch.trim() ? (
          <View style={{ paddingTop: 20, paddingBottom: 32 }}>
            <Text style={{ color: colors.textMuted, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 }}>
              ЗАБЛОКИРОВАННЫЕ · {bannedMembers.length}
            </Text>
            {bannedMembers.map((m) => (
              <AppPressable
                key={m.peerPubB64}
                style={[gmStyles.row, { borderBottomColor: colors.border }]}
                onPress={() => unbanMember(m)}
              >
                <View style={[gmStyles.avatar, { backgroundColor: colors.textMuted }]}>
                  <Ionicons name="ban-outline" size={18} color={contrastingInk(colors.textMuted)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[gmStyles.name, { color: m.displayNameUnreadable ? colors.warning : colors.textSecondary }]}>
                    {shownName(m.displayName, m.displayNameUnreadable, shortIdentity(m.peerPubB64))}
                  </Text>
                  <Text style={[gmStyles.role, { color: colors.textMuted }]}>Нажмите, чтобы разблокировать</Text>
                </View>
              </AppPressable>
            ))}
          </View>
        ) : null}
      />

      {/* Join requests modal */}
      <GroupJoinRequestsModal
        visible={joinReqVisible}
        onClose={() => setJoinReqVisible(false)}
        groupId={group.id}
        joinRequests={joinRequests}
        onApprove={(item) => {
          // v4.32.531: раньше вся ветка висела на `void (async () => ...)()` без
          // try/catch. updateGroupJoinRequestStatus и upsertGroupMember бросают:
          // при отказе базы заявка оставалась в списке, участник не добавлялся,
          // и администратор не получал ни ошибки, ни повода нажать ещё раз.
          runGuardedOp(async () => {
            // v4.32.230: upsertGroupMember — это INSERT OR REPLACE, поэтому
            // одобрение заявки бесшумно затёрло бы role='banned' и вернуло
            // забаненного в группу в обход бана.
            const existing = await listGroupMembers(group.id, pid);
            if (existing.some((m) => m.peerPubB64 === item.requesterPubB64 && m.role === 'banned')) {
              Alert.alert('AirChat', `${item.requesterName ?? 'Участник'} заблокирован(а) в этой группе.\nСначала снимите блокировку командой /unban @имя`);
              return;
            }
            const changes = await updateGroupJoinRequestStatus(item.id, 'approved');
            // v4.32.175: если другой админ уже approve'нул — changes===0, выходим
            // чтобы не задвоить memberCount и системное сообщение.
            if (!changes) { void loadJoinRequests(); return; }
            await upsertGroupMember({
              groupId: group.id,
              ownerProfileId: pid,
              peerPubB64: item.requesterPubB64,
              displayName: item.requesterName,
              role: 'member',
              joinedAt: Date.now(),
            });
            await recountGroupMembers(group.id, pid);
            await insertGroupSysMessage(group.id, pid, myPubB64, `${item.requesterName ?? 'Участник'} вступил(а) в группу`);
            announceCtl(fanoutGroupControl(group.id, pid, myPubB64, { op: 'add', target: item.requesterPubB64, targetName: item.requesterName ?? undefined }, myName));
            // v4.32.231: «Одобрить» не отправляло заявителю ВООБЩЕ ничего —
            // группа у него так и не появлялась, вся настройка «Одобрение
            // входа» была тупиком. Шлём снимок группы.
            // v4.32.451: «принят» говорится только если снимок группы ушёл.
            // Раньше приглашение отправлялось через `void`, и одобренный мог
            // не получить ничего — а надпись обещала обратное и администратору,
            // и (его словами) заявителю.
            const invite = groupControlProblem(
              await sendGroupInvite(
                group.id,
                group.name,
                group.type,
                existing
                  .filter((m) => m.role !== 'banned' && m.peerPubB64 !== item.requesterPubB64)
                  .map((m) => ({ pub: m.peerPubB64, name: m.displayName }))
                  .concat(existing.some((m) => m.peerPubB64 === myPubB64) ? [] : [{ pub: myPubB64, name: myName }]),
                [item.requesterPubB64],
                myName
              )
            );
            if (invite) showError(invite);
            else showSuccess(`${item.requesterName ?? 'Участник'} принят`);
            void loadJoinRequests();
            void loadMembers();
          }, 'Не удалось одобрить заявку');
        }}
        onReject={(item) => {
          runGuardedOp(async () => {
            const changes = await updateGroupJoinRequestStatus(item.id, 'rejected');
            // v4.32.266: отказ доходит до заявителя. Раньше «Отклонить» меняло
            // строку только в своей БД: человек, вошедший по устаревшей ссылке,
            // так и оставался с группой, в которой его сообщений никто не видит.
            // Адресно, а не рассылкой: кому отказали — не дело всей группы.
            const answer = changes
              ? groupControlProblem(
                  await sendGroupControlTo(
                    [item.requesterPubB64],
                    group.id,
                    { op: 'joinres', target: item.requesterPubB64, status: 'rejected', targetName: item.requesterName ?? undefined },
                    myName
                  )
                )
              : null;
            if (answer) showError(answer);
            else showSuccess(`${item.requesterName ?? 'Запрос'} отклонён`);
            void loadJoinRequests();
          }, 'Не удалось отклонить заявку');
        }}
      />

      {/* Member profile bottom sheet */}
      <GroupMemberSheetModal
        member={selectedMember}
        onClose={() => setSelectedMember(null)}
        amAdmin={amAdmin}
        myPubB64={myPubB64}
        onOpenDm={onOpenDm}
        canModerateMember={(m) => canModerate(myMemberRole, m.role).allowed}
        onKick={kickMember}
        onToggleAdmin={(m) => changeMemberRole(
          m,
          m.role === 'admin' ? 'member' : 'admin',
          m.role === 'admin' ? 'снять с должности администратора' : 'назначить администратором'
        )}
        onToggleMute={(m) => changeMemberRole(
          m,
          m.role === 'restricted' ? 'member' : 'restricted',
          m.role === 'restricted' ? 'разрешить писать' : 'запретить писать'
        )}
      />

      {/* Admin Log modal */}
      <GroupAdminLogModal
        visible={adminLogVisible}
        onClose={() => setAdminLogVisible(false)}
        entries={adminLogEntries}
      />
    </View>
  );
}

const gmStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontSize: 18, fontWeight: '600' },
  name: { fontSize: 15, fontWeight: '500' },
  role: { fontSize: 12, marginTop: 1 },
  infoHeader: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  avatarLarge: { width: 80, height: 80, borderRadius: 40 },
  avatarEditBadge: { position: 'absolute', bottom: 0, right: 0, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  nameInput: { fontSize: 17, fontWeight: '600', borderBottomWidth: 1, paddingVertical: 2, paddingHorizontal: 0 },
  descInput: { fontSize: 13, borderBottomWidth: 1, paddingVertical: 2, paddingHorizontal: 0, minHeight: 40 },
  memberSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 12, paddingHorizontal: 16 },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  sheetBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 12, paddingVertical: 12 },
});

// ─────────────────────────────────────────────────────────────────────────────
// GroupsScreen — main export
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  pair?: KeyPairBytes;
  /** Jump directly to a specific group by ID (triggered from in-app notification banner). */
  groupJump?: { groupId: string; token: number };
  /** Navigate to DM with a peer (crosses tab boundary — handled by App). */
  onOpenDm?: (peerPubB64: string, displayName: string) => void;
};

type NavState =
  | { screen: 'list' }
  | { screen: 'chat'; group: GroupRow; initialSearchQuery?: string }
  | { screen: 'members'; group: GroupRow };

/**
 * v4.32.413: экран групп объявляет род своих пузырей один раз здесь.
 * `DocBubble`, `ContactCardBubble`, `VoicePlayer`, `GifBubble` и `LinkPreview`
 * общие с перепиской, а свой пузырь у групп залит `primary`, а не `bubbleOut`:
 * в тёмной теме на #3d5afe чернила, подобранные под #1a2e5e, давали 2.05:1 у
 * вторичного текста и 1.20:1 у приглушённого. Проп пришлось бы прокидывать в
 * пяти местах — ровно там о нём и забыли.
 */
function GroupsScreenImpl(props: Props): React.ReactElement {
  return (
    <BubbleKindProvider kind="group">
      <GroupsScreenBody {...props} />
    </BubbleKindProvider>
  );
}

function GroupsScreenBody({ pair, groupJump, onOpenDm }: Props): React.ReactElement {
  // v4.32.16: gate через tabRef из Context; prop isActive удалён — React.memo bail-out
  // на setTab → нет re-render'а тяжёлого JSX tree (5700 строк) → устраняет 2.2с блок.
  const tabRef = useTabRef();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [nav, setNav] = useState<NavState>({ screen: 'list' });
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [archivedGroups, setArchivedGroups] = useState<GroupRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [grpSearch, setGrpSearch] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'unread' | 'groups' | 'channels' | 'pinned'>('all');
  // v4.32.178 (Round-8): memoize filtered list so FlatList data ref is stable → React.memo on GroupListRow holds.
  const filteredGroups = useMemo(() => {
    let list = grpSearch
      ? groups.filter((g) => g.name.toLowerCase().includes(grpSearch.toLowerCase()))
      : groups;
    if (filterTab === 'unread') list = list.filter((g) => g.unreadCount > 0);
    else if (filterTab === 'groups') list = list.filter((g) => g.type !== 'channel');
    else if (filterTab === 'channels') list = list.filter((g) => g.type === 'channel');
    else if (filterTab === 'pinned') list = list.filter((g) => g.pinned);
    return list;
  }, [groups, grpSearch, filterTab]);
  const [grpMsgSearchResults, setGrpMsgSearchResults] = useState<GroupMessageSearchResult[]>([]);
  /** v4.32.581: непрочитанные реплики глобального поиска — см. searchScan. */
  const [grpMsgSearchScan, setGrpMsgSearchScan] = useState<SearchScan | null>(null);
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  const myPubB64 = useMemo(() => pair ? Buffer.from(pair.publicKey).toString('base64') : '', [pair]);
  const [listGateway, setListGateway] = useState('');
  useEffect(() => {
    void import('../../core/config').then((m) => m.loadConfig()).then((c) => setListGateway(c.ipfs.gatewayUrl.replace(/\/$/, '')));
  }, []);

  // Cross-group message search with debounce
  useEffect(() => {
    if (!grpSearch.trim() || grpSearch.length < 2) {
      setGrpMsgSearchResults([]);
      setGrpMsgSearchScan(null);
      return;
    }
    const t = setTimeout(() => {
      void searchAllGroupMessages(grpSearch.trim(), pid, 20).then((res) => {
        setGrpMsgSearchResults(res.items);
        setGrpMsgSearchScan(res.scan);
      });
    }, 400);
    return () => clearTimeout(t);
  }, [grpSearch, pid]);

  const loadGroups = useCallback(async () => {
    const [list, archived] = await Promise.all([listGroups(pid), listArchivedGroups(pid)]);
    setGroups(list);
    setArchivedGroups(archived);
  }, [pid]);

  /**
   * Действие над строкой списка: сначала запись, потом перечитать список.
   *
   * v4.32.531: закрепить, заглушить, архивировать и «отметить прочитанным»
   * запускались как обещание без перехвата, с перерисовкой списка в хвосте.
   * Все четыре функции хранилища бросают; при отказе список не
   * перечитывался, ошибка не
   * показывалась, и строка возвращалась в прежний вид — как будто нажатие
   * не засчиталось. Ошибку перечитывания отделяем от ошибки самой операции:
   * запись уже прошла, и говорить «не удалось закрепить» было бы неправдой.
   */
  const runRowOp = useCallback((op: () => Promise<unknown>, fallback: string): void => {
    void (async () => {
      try {
        await op();
      } catch (e) {
        showError(userErrorText(e, fallback));
        return;
      }
      try {
        await loadGroups();
      } catch (e) {
        log.warn('groups_reload_after_row_op_failed', { err: rawErrorText(e) });
      }
    })();
  }, [loadGroups]);

  useEffect(() => { void loadGroups(); }, [loadGroups]);

  /**
   * Выход из группы: сначала сказать группе, потом стереть у себя.
   *
   * v4.32.268: пункт назывался «Покинуть / удалить», но покидал ровно ноль
   * участников — deleteGroup чистит только свою БД. Вышедший навсегда
   * оставался в чужих списках и в числе «N участников», ему бесконечно слали
   * каждое сообщение группы, а его клиент так же бесконечно выбрасывал их как
   * «неизвестная группа». Порядок важен: fanout читает group_members, которую
   * deleteGroup удаляет.
   *
   * Владельцу говорим отдельно: роль передать некому, и выход означает, что
   * группа останется без владельца навсегда.
   */
  const confirmLeaveGroup = useCallback((g: GroupRow): void => {
    void (async () => {
      const iAmOwner = (await listGroupMembers(g.id, pid)).some(
        (m) => m.peerPubB64 === myPubB64 && m.role === 'owner'
      );
      Alert.alert(
        `Покинуть «${g.name}»?`,
        iAmOwner
          ? 'Вы владелец: группа останется без владельца, вернуть себе права будет нельзя. Участники увидят, что вы вышли. Переписка будет удалена с этого устройства.'
          : 'Участники увидят, что вы вышли, и перестанут вам писать. Переписка будет удалена с этого устройства.',
        [
          { text: 'Отмена', style: 'cancel' },
          {
            text: 'Покинуть',
            style: 'destructive',
            onPress: () => void (async () => {
              let problem: string | null = null;
              if (myPubB64) {
                const myName = (await getOwnDisplayName()) ?? undefined;
                problem = groupControlProblem(
                  await fanoutGroupControl(g.id, pid, myPubB64, { op: 'leave', target: myPubB64, targetName: myName }, myName)
                );
              }
              await deleteGroup(g.id, pid);
              await loadGroups();
              if (problem) showError(problem);
            })(),
          },
        ]
      );
    })();
  }, [myPubB64, pid, loadGroups]);

  useEffect(() => {
    const unsub = subscribeChatWrites(() => {
      if (tabRef.current !== 'groups') return;
      void loadGroups();
    });
    return unsub;
  }, [loadGroups, tabRef]);

  /**
   * Переход к группе по нажатию на баннер уведомления.
   *
   * v4.32.548. Раньше группа искалась ТОЛЬКО в списке, уже загруженном в
   * память, и при промахе не происходило ничего: приложение переключалось на
   * вкладку «Группы» и оставалось на списке. А промах был обычным делом —
   * `subscribeChatWrites` перечитывает список лишь пока вкладка активна, так
   * что сообщение в новую группу, пришедшее с другой вкладки, гарантированно
   * не попадало в память; при первом же открытии вкладки список ещё пуст.
   * Человек нажимал на уведомление и не получал ни группы, ни объяснения.
   *
   * Теперь список — только быстрый путь, а решает база. И «такой группы нет»
   * отделено от «не смогли прочитать»: на отказ базы врать про отсутствие
   * нельзя (см. `lookupResult`).
   */
  useEffect(() => {
    if (!groupJump) return;
    let alive = true;
    void (async () => {
      const cached = fromNullable(groups.find((x) => x.id === groupJump.groupId));
      const result =
        cached.state === 'found' ? cached : firstFound([cached, await getGroupRead(groupJump.groupId, pid)]);
      if (!alive) return;
      const target = lookupValue(result);
      if (target) {
        setNav({ screen: 'chat', group: target });
        return;
      }
      log.warn('ui_group_jump_unresolved', {
        group: groupJump.groupId.slice(0, 16),
        state: result.state,
      });
      showError(
        isTrulyMissing(result)
          ? 'Эта группа больше не открывается — возможно, вас из неё удалили'
          : 'Не удалось открыть группу из уведомления'
      );
    })();
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJump, pid]);

  /**
   * v4.32.560: какая группа открыта прямо сейчас — для показа уведомлений.
   *
   * У переписки такая отметка есть с v4.32.525, у групп её не было: системный
   * баннер приходил и тогда, когда человек читает ровно эту группу и видит
   * новое сообщение своими глазами. Снимаем при уходе из ветки — вкладки
   * остаются смонтированными, поэтому одного размонтирования экрана мало,
   * и вторую половину вопроса (какая вкладка активна, на переднем ли плане
   * приложение) решает activeChatSuppress.
   */
  const openGroupId = nav.screen === 'chat' ? nav.group.id : null;
  useEffect(() => {
    setActiveGroupId(openGroupId);
    return () => { setActiveGroupId(null); };
  }, [openGroupId]);

  const showMenu = useCallback((g: GroupRow) => {
    Alert.alert(g.name, '', [
      ...(g.unreadCount > 0 ? [{
        text: 'Отметить прочитанным',
        onPress: () => runRowOp(() => markGroupRead(g.id, pid), 'Не удалось отметить прочитанным'),
      }] : [{
        text: 'Отметить непрочитанным',
        onPress: () => runRowOp(() => markGroupUnread(g.id, pid), 'Не удалось отметить непрочитанным'),
      }]),
      {
        text: g.pinned ? 'Открепить' : 'Закрепить',
        onPress: () => runRowOp(
          () => setGroupPinned(g.id, pid, !g.pinned),
          g.pinned ? 'Не удалось открепить группу' : 'Не удалось закрепить группу',
        ),
      },
      {
        text: g.muted ? 'Включить звук' : 'Беззвучно…',
        onPress: () => {
          const kind: MuteKind = g.type === 'channel' ? 'channel' : 'group';
          if (g.muted) {
            runRowOp(async () => {
              await setGroupMuted(g.id, pid, false);
              await muteUnset(kind, g.id);
            }, 'Не удалось включить звук');
          } else {
            const snooze = (ms: number | null) => () => runRowOp(async () => {
              const u = ms === null ? null : Date.now() + ms;
              await setGroupMutedUntil(g.id, pid, u);
              await muteSet(kind, g.id, u !== null ? { untilMs: u } : undefined);
            }, 'Не удалось отключить уведомления');
            Alert.alert('Беззвучный режим', 'Выберите длительность:', [
              { text: '1 час', onPress: snooze(3_600_000) },
              { text: '8 часов', onPress: snooze(8 * 3_600_000) },
              { text: '1 день', onPress: snooze(86_400_000) },
              { text: '1 неделя', onPress: snooze(7 * 86_400_000) },
              { text: 'Навсегда', onPress: snooze(null) },
              { text: 'Отмена', style: 'cancel' },
            ]);
          }
        },
      },
      // Приглашает администратор: ссылка объявляет своего автора админом
      // группы, у обычного участника это ложное заявление (см. шапку карточки).
      // v4.32.512: в списке групп список участников не прочитан, и флаг здесь
      // — единственный доступный ответ. Раньше он застывал на значении,
      // записанном при создании группы: повышенный администратор кнопку так
      // и не получал, а понижённый продолжал раздавать ссылки, которые у
      // получателей ничего не открывали. Теперь флаг идёт за ролью.
      ...(g.isAdmin ? [{
        text: 'Пригласительная ссылка',
        onPress: () => void (async () => {
          // Забаненных и потолок списка держит сам сборщик.
          const myPub = Buffer.from(pair?.publicKey ?? new Uint8Array()).toString('base64');
          // v4.32.303: тот же токен, что и у двух других кнопок. Без него отсюда
          // уходила бы ссылка, которую нечем отозвать.
          const invite = await ensureGroupInviteToken(g.id, pid, myPub);
          if (invite === null) { showError('Не удалось получить пригласительную ссылку'); return; }
          announceInviteToken(invite.announced);
          const link = buildGroupInviteLink({
            id: g.id,
            name: g.name,
            type: g.type,
            adminPub: myPub,
            requireApproval: g.requireApproval ?? false,
            members: await listGroupMembers(g.id, pid),
            token: invite.token,
          });
          void Share.share({ message: link, title: `Присоединиться к ${g.name}` });
        })(),
      }] : []),
      {
        text: g.archived ? 'Разархивировать' : 'Архивировать',
        onPress: () => runRowOp(
          () => setGroupArchived(g.id, pid, !g.archived),
          g.archived ? 'Не удалось разархивировать группу' : 'Не удалось архивировать группу',
        ),
      },
      {
        text: 'Покинуть группу',
        style: 'destructive',
        onPress: () => confirmLeaveGroup(g),
      },
      { text: 'Отмена', style: 'cancel' },
    ]);
  }, [pid, runRowOp, pair, confirmLeaveGroup]);

  if (nav.screen === 'chat' && pair) {
    return (
      <SafeScreen edges={['left', 'right']} style={{ flex: 1 }}>
        {/* v4.32.494: ключ обязателен. Всплывающая плашка уведомления из другой
            группы ставит её поверх открытой, минуя список: без ремоунта React
            переиспользует тот же экземпляр, и всё его состояние остаётся от
            прошлой группы — набранный текст, цитата, обои, шрифт и снимки
            настроек («только админы», медленный режим, срок исчезновения).
            Недописанное сообщение для одной группы уходило бы другим людям.
            То же правило и по той же причине — у переписки: см.
            chatThreadIdentity.test.ts. */}
        <GroupChatScreen
          key={nav.group.id}
          group={nav.group}
          pair={pair}
          onBack={() => setNav({ screen: 'list' })}
          onOpenMembers={() => setNav({ screen: 'members', group: nav.group })}
          onOpenDm={onOpenDm}
          initialSearchQuery={nav.initialSearchQuery}
        />
      </SafeScreen>
    );
  }

  if (nav.screen === 'members' && pair) {
    return (
      <SafeScreen edges={['left', 'right']} style={{ flex: 1 }}>
        <GroupMembersScreen
          key={nav.group.id}
          group={nav.group}
          pair={pair}
          onBack={() => setNav({ screen: 'chat', group: nav.group })}
          onOpenDm={onOpenDm}
        />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen edges={['left', 'right']} style={{ flex: 1 }}>
      <KeyboardHost>
      <View style={[gsStyles.root, { paddingTop: insets.top, backgroundColor: colors.background }]}>
        <CreateGroupModal
          visible={createVisible}
          pair={pair}
          onClose={() => setCreateVisible(false)}
          onCreated={(g) => {
            void loadGroups();
            setNav({ screen: 'chat', group: g });
          }}
        />

        <View style={gsStyles.header}>
          <Text style={[gsStyles.title, { color: colors.text }]}>Группы</Text>
          {groups.some((g) => g.unreadCount > 0) ? (
            <AppPressable
              style={[gsStyles.createBtn, { marginRight: 4 }]}
              accessibilityRole="button"
              accessibilityLabel="Отметить все группы прочитанными"
              onPress={() => runRowOp(() => markAllGroupsRead(pid), 'Не удалось отметить всё прочитанным')}
            >
              <Ionicons name="checkmark-done-outline" size={22} color={colors.accent} />
            </AppPressable>
          ) : null}
          <AppPressable style={gsStyles.createBtn} onPress={() => setCreateVisible(true)} accessibilityRole="button" accessibilityLabel="Создать группу или канал">
            <Ionicons name="add-circle-outline" size={26} color={colors.accent} />
          </AppPressable>
        </View>

        <View style={[gsStyles.grpSearchWrap, { backgroundColor: gsStyles.grpSearchInput ? undefined : undefined }]}>
          <View style={[{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceHigh, borderRadius: 10, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8 }]}>
            <Ionicons name="search" size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
            <TextInput
              value={grpSearch}
              onChangeText={setGrpSearch}
              placeholder="Поиск групп…"
              placeholderTextColor={colors.textMuted}
              style={{ flex: 1, color: colors.text, fontSize: 15 }}
            />
            {grpSearch ? (
              <AppPressable onPress={() => setGrpSearch('')} accessibilityRole="button" accessibilityLabel="Очистить поиск групп">
                <Ionicons name="close-circle" size={16} color={colors.textMuted} />
              </AppPressable>
            ) : null}
          </View>
        </View>

        {/* Filter tabs */}
        <View style={[gsStyles.filterRow, { borderBottomColor: colors.border }]}>
          {([
            { id: 'all' as const, label: 'Все', badge: groups.reduce((s, g) => s + (g.unreadCount > 0 ? 1 : 0), 0) },
            { id: 'unread' as const, label: 'Непрочит.', badge: groups.filter((g) => g.unreadCount > 0).length },
            { id: 'groups' as const, label: 'Группы', badge: groups.filter((g) => g.type !== 'channel' && g.unreadCount > 0).length },
            { id: 'channels' as const, label: 'Каналы', badge: groups.filter((g) => g.type === 'channel' && g.unreadCount > 0).length },
            { id: 'pinned' as const, label: 'Закреп.', badge: groups.filter((g) => g.pinned && g.unreadCount > 0).length },
          ]).map((tab) => {
            const active = filterTab === tab.id;
            const showBadge = tab.badge > 0 && !active;
            return (
              <AppPressable
                key={tab.id}
                onPress={() => setFilterTab(tab.id)}
                style={[gsStyles.filterTab, active && [gsStyles.filterTabActive, { borderBottomColor: colors.primary }]]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={[gsStyles.filterTabText, { color: active ? colors.accent : colors.textMuted }]}>
                    {tab.label}
                  </Text>
                  {showBadge ? (
                    <View style={{ backgroundColor: colors.primary, borderRadius: 8, minWidth: 16, paddingHorizontal: 4, alignItems: 'center' }}>
                      <Text style={{ color: contrastingInk(colors.primary), fontSize: 10, fontWeight: '700' }}>{tab.badge > 99 ? '99+' : tab.badge}</Text>
                    </View>
                  ) : null}
                </View>
              </AppPressable>
            );
          })}
        </View>

        {/* Cross-group message search results */}
        {/* v4.32.581: строка о непрочитанном стоит ВЫШЕ выдачи и вне её условия —
            именно при нуле совпадений она и нужна. */}
        {grpSearch.length >= 2 && grpMsgSearchScan && searchSkippedNotice(grpMsgSearchScan) ? (
          <Text style={{ fontSize: 12, fontStyle: 'italic', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, color: colors.warning }}>
            {searchSkippedNotice(grpMsgSearchScan)}
          </Text>
        ) : null}
        {grpSearch.length >= 2 && grpMsgSearchResults.length > 0 ? (
          <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, marginBottom: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, textTransform: 'uppercase', color: colors.textMuted }}>
              Сообщения
            </Text>
            {grpMsgSearchResults.map((r) => {
              const myPub = pair ? Buffer.from(pair.publicKey).toString('base64') : '';
              const isOut = r.message.senderPubB64 === myPub;
              const preview = previewLabelForText(r.message.text).slice(0, 120);
              const qLower = grpSearch.toLowerCase();
              const matchIdx = preview.toLowerCase().indexOf(qLower);
              // v4.32.605: непрочитанный столбец больше не выдаёт себя за «реакций нет».
              const reactChip = searchReactionChip(r.message.reactions, r.message.reactionsUnreadable);
              // v4.32.421: год у чужого года — та же подпись, что и в поиске по
              // чатам. Раньше «12 мар» прошлого года было не отличить от этого.
              const timeStr = formatSearchTime(r.message.createdAt);
              return (
                <AppPressable
                  key={r.message.id}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}
                  onPress={() => {
                    const grp = groups.find((g) => g.id === r.groupId);
                    if (grp) void getGroup(r.groupId, pid).then((fresh) => setNav({ screen: 'chat', group: fresh ?? grp, initialSearchQuery: grpSearch }));
                  }}
                >
                  <Ionicons name="people-outline" size={20} color={colors.accent} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 }} numberOfLines={1}>{r.groupName}</Text>
                      {reactChip.kind === 'emoji' ? <Text style={{ fontSize: 11 }}>{reactChip.text}</Text> : null}
                      {reactChip.kind === 'unreadable' ? (
                        <Text
                          style={{ fontSize: 11, color: colors.warning }}
                          accessibilityLabel={UNREADABLE_REACTIONS_TEXT}
                        >{UNREADABLE_REACTION_MARK}</Text>
                      ) : null}
                      <Text style={{ fontSize: 11, color: colors.textMuted }}>{timeStr}</Text>
                    </View>
                    <Text style={{ fontSize: 13, color: colors.textSecondary }} numberOfLines={1}>
                      {r.message.senderName && !isOut ? <Text style={{ color: colors.textMuted }}>{r.message.senderName}{': '}</Text> : null}
                      {matchIdx >= 0 ? (
                        <>
                          <Text>{preview.slice(0, matchIdx)}</Text>
                          <Text style={{ color: colors.accent, fontWeight: '700' }}>{preview.slice(matchIdx, matchIdx + grpSearch.length)}</Text>
                          <Text>{preview.slice(matchIdx + grpSearch.length)}</Text>
                        </>
                      ) : preview}
                    </Text>
                  </View>
                </AppPressable>
              );
            })}
          </View>
        ) : null}

        <FlatList
          data={filteredGroups}
          keyExtractor={(g) => g.id}
          renderItem={({ item }) => (
            <GroupListRow
              item={item}
              gateway={listGateway}
              myPubB64={myPubB64}
              onPress={async () => {
                const fresh = await getGroup(item.id, pid);
                setNav({ screen: 'chat', group: fresh ?? item });
              }}
              onLongPress={() => showMenu(item)}
              onSwipeArchive={() => runRowOp(
                () => setGroupArchived(item.id, pid, !item.archived),
                item.archived ? 'Не удалось разархивировать группу' : 'Не удалось архивировать группу',
              )}
              onSwipeRead={item.unreadCount > 0
                ? () => runRowOp(() => markGroupRead(item.id, pid), 'Не удалось отметить прочитанным')
                : () => runRowOp(() => markGroupUnread(item.id, pid), 'Не удалось отметить непрочитанным')
              }
            />
          )}
          ItemSeparatorComponent={() => (
            <View style={[gsStyles.separator, { backgroundColor: colors.border, marginLeft: 74 }]} />
          )}
          ListEmptyComponent={
            <View style={gsStyles.empty}>
              <Ionicons
                name={filterTab === 'channels' ? 'megaphone-outline' : filterTab === 'pinned' ? 'pin-outline' : filterTab === 'groups' ? 'people-circle-outline' : 'people-outline'}
                size={52}
                color={colors.textMuted}
              />
              <Text style={[gsStyles.emptyTitle, { color: colors.text }]}>
                {filterTab === 'unread' ? 'Нет непрочитанных'
                  : filterTab === 'groups' ? 'Нет групп'
                  : filterTab === 'channels' ? 'Нет каналов'
                  : filterTab === 'pinned' ? 'Нет закреплённых'
                  : 'Нет групп'}
              </Text>
              <Text style={[gsStyles.emptyHint, { color: colors.textMuted }]}>
                {filterTab === 'all'
                  ? 'Создайте группу или канал, нажав «+»'
                  : filterTab === 'channels'
                  ? 'Создайте канал, нажав «+»'
                  : 'Ничего не найдено для этого фильтра'}
              </Text>
            </View>
          }
          ListFooterComponent={archivedGroups.length > 0 ? (
            <View>
              <AppPressable
                style={[gsStyles.archivedBtn, { borderTopColor: colors.border }]}
                onPress={() => setShowArchived((v) => !v)}
              >
                <Ionicons name="archive-outline" size={18} color={colors.textMuted} style={{ marginRight: 8 }} />
                <Text style={{ color: colors.textMuted, fontSize: 14 }}>Архивные ({archivedGroups.length})</Text>
                <Ionicons name={showArchived ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} style={{ marginLeft: 'auto' }} />
              </AppPressable>
              {showArchived ? archivedGroups.map((g) => (
                <GroupListRow
                  key={g.id}
                  item={g}
                  gateway={listGateway}
                  myPubB64={myPubB64}
                  onPress={async () => {
                    const fresh = await getGroup(g.id, pid);
                    setNav({ screen: 'chat', group: fresh ?? g });
                  }}
                  onLongPress={() => {
                    Alert.alert(g.name, '', [
                      { text: 'Разархивировать', onPress: () => runRowOp(() => setGroupArchived(g.id, pid, false), 'Не удалось разархивировать группу') },
                      { text: 'Покинуть группу', style: 'destructive', onPress: () => confirmLeaveGroup(g) },
                      { text: 'Отмена', style: 'cancel' },
                    ]);
                  }}
                  onSwipeArchive={() => runRowOp(() => setGroupArchived(g.id, pid, false), 'Не удалось разархивировать группу')}
                />
              )) : null}
            </View>
          ) : null}
        />
      </View>
      </KeyboardHost>
    </SafeScreen>
  );
}

const gsStyles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  title: { fontSize: 22, fontWeight: '700' },
  createBtn: { padding: 4 },
  separator: { height: StyleSheet.hairlineWidth },
  grpSearchWrap: {},
  grpSearchInput: {},
  filterRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
    marginBottom: 2,
  },
  filterTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  filterTabActive: {},
  filterTabText: { fontSize: 13, fontWeight: '600' },
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyHint: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32 },
  archivedBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
});

// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: React.memo — предотвращает re-render при каждом setTab в App.tsx (v4.32.5).
export const GroupsScreen = React.memo(GroupsScreenImpl);
