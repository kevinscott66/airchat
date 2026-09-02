/**
 * ChatScreen — контейнер: список диалогов (ChatListScreen) или открытый чат (ChatThreadView).
 * Навигация: список → тред → назад без дополнительного стека.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
  ActionSheetIOS,
  Platform,
  Vibration,
  ScrollView,
  Clipboard,
  Keyboard,
  PanResponder,
  Animated as RNAnimated,
  AppState,
} from 'react-native';
import notifee from '@notifee/react-native';
import { promptMessageReminder } from '../utils/messageReminder';
import { AppPressable } from '../components/AppPressable';
import { KeyboardHost } from '../components/KeyboardHost';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { showPermissionDeniedAlert } from '../permissionAlert';
// v4.32.27: AppModal = Modal + GestureHandlerRootView inside — чтобы RNGH
// Pressable (AppPressable) внутри модалок получал касания на Android.
import { AppModal as Modal } from '../components/AppModal';
import { AttachSheet } from '../components/AttachSheet';
import { resolveDmPinned, toggleDmPinAndSync, clearDmPinnedAndSync, type DmPinnedEntry } from '../../core/social/dmPinSync';
import { announceDmPin } from '../dmPinAnnounce';
import { setDisappearAndSync } from '../../core/social/disappearSync';
import { syncLastSeenPrefTo } from '../../core/social/presencePrefSync';
import { presenceSubtitle } from '../../core/social/peerStatus';
import { syncMyProfileTo } from '../../core/social/profileSync';
import { formatDisappearLabel } from '../../core/social/disappearEnvelope';
import { CHAT_MAX_IMAGES, mergePickedImages, remainingImageSlots } from '../../core/social/mediaAttachPolicy';
import { MediaPreviewModal } from '../components/MediaPreviewModal';
import { ChatQuickRepliesModal } from '../components/modals/chat/ChatQuickRepliesModal';
import { ChatPinnedListModal } from '../components/modals/chat/ChatPinnedListModal';
import { ScheduledListModal } from '../components/modals/shared/ScheduledListModal';
import { ChatStarredModal } from '../components/modals/chat/ChatStarredModal';
import { ChatRecentlyDeletedModal } from '../components/modals/chat/ChatRecentlyDeletedModal';
import { ChatReactionsPickerModal } from '../components/modals/chat/ChatReactionsPickerModal';
import { ChatQuickReactModal } from '../components/modals/chat/ChatQuickReactModal';
import { DmPollCreatorModal } from '../components/modals/chat/ChatPollCreatorModal';
import { SharedMediaModal } from '../components/modals/chat/ChatSharedMediaModal';
import { ContactInfoModal } from '../components/modals/chat/ChatContactInfoModal';
import { FlashList } from '@shopify/flash-list';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { listContacts, type Contact } from '../../core/social/contacts';
import { getMessagingService, previewLabelForText } from '../../core/social/messaging';
import { deleteCachedFileUris, uploadEncryptedBlob, MAX_BLOB_BYTES } from '../../core/media/mediaBlob';
import { resolveMediaCidsToUris } from '../../core/media/resolveMediaCids';
import { shareTextExport } from '../../core/media/cacheFiles';
import { parseMediaCidsColumn } from '../../core/media/mediaCidPolicy';
import { scheduleMessage } from '../../core/social/scheduledMessages';
import { loadConfig } from '../../core/config';
import type { ChatMessageRow } from '../../core/storage/local';
import {
  markConversationRead,
  setConversationDraft,
  upsertChatMessage,
  touchConversation,
  setConversationMuted,
  setConversationMutedUntil,
  listConversations,
  clearChatHistory,
  listAllChatMessages,
  listAllScheduledMessages,
  deleteScheduledMessage,
  setMessageStarred,
  listStarredMessages,
  makePollText,
  POLL_PREFIX,
  type ScheduledMessage,
  type StarredMessageEntry,
  listQuickReplies,
  type QuickReply,
  searchChatMessages,
  recentlyDeletedKey,
} from '../../core/storage/local';
import { v4 as uuidv4 } from 'uuid';
import { VoiceRecorderButton, type VoiceRecordingResult } from '../components/VoiceMessage';
import { voiceUploadRefusal } from '../components/voiceLimit';
import { fileSizeBytes } from '../../core/media/fileSize';
import { useMediaViewer } from '../components/MediaViewer';
import { log, measurePerformance } from '../../core/logger';
import { toggleAndSyncReaction } from '../../core/social/reactionSync';
import { closeAndSyncPoll } from '../../core/social/pollVoteSync';
import { profileManager } from '../../core/identity/profileManager';
import { rateLimiter } from '../../core/security/rateLimiter';
import { SafeScreen } from '../components/SafeScreen';
import { reportTwoSided, showError, showSuccess } from '../components/userFeedback';
import { exportBody } from '../../core/social/exportLine';
import { shouldApplyRows } from '../../core/storage/readResult';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../ThemeContext';
import { avatarShape, badgeDigit, badgeTint, bubbleInk, bubbleSurfaceOn, contrastingInk, font, elevation, inkOn, mono, motion, nestedFill, radius, rippleOn, rowMark, scrim, spacing, TOUCH_TARGET_MIN } from '../theme';
import { isReducedMotion } from '../motionPrefs';
import { GlassSurface } from '../components/GlassSurface';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatListScreen } from './ChatListScreen';
import { subscribeChatWrites } from '../../core/storage/local';
import { isUnreadableMessage, UNREADABLE_MEDIA_TEXT, UNREADABLE_MESSAGE_TEXT, UNREADABLE_QUOTE_TEXT } from '../../core/storage/unreadableText';
import { outwardQuote, quoteView } from '../../core/social/replyQuote';
import { decideDraftWrite, draftIsUnreadable, hasReadableDraft, unreadableAfterWrite } from '../../core/social/draftGuard';
import { searchSkippedBadge, searchSkippedNotice, type SearchScan } from '../../core/storage/searchScan';
import { mergeOlderPage, type ChatPageCursor } from '../../core/storage/chatPageCursor';
import { usePresence } from '../hooks/usePresence';
import { setActiveChatDid } from '../../notifications/pushNotifications';
import { NOTIFICATION_SMALL_ICON } from '../../notifications/notificationIcon';
import { publicKeyToDidKey, didFromPubB64 } from '../../core/identity/did';
import { initiateCall, getCurrentCall } from '../../core/social/callService';
import { GifPickerModal, isGifMessage, parseGifUrl, GifBubble, isGifSearchAvailable } from '../components/GifPicker';
import { getActiveLiveLoc, isLiveLocMessage, makeLiveLocText, startLiveLocSession, stopLiveLocSession } from '../../core/social/liveLocationService';
import { liveLocBannerFor } from '../../core/social/liveLocSelect';
import { readPlaceOnce } from '../../core/social/deviceLocation';
import { locationFailureText } from '../../core/social/locationFailure';
import { AnimatedDots } from '../components/AnimatedDots';
import {
  buildTranslateUrl,
  MAX_TRANSLATE_CHARS,
  parseTranslation,
  translateBlockMessage,
  translateBlockReason,
  translateFailureMessage,
} from '../../core/social/cloudTranslate';
import { CLOUD_TRANSLATE_OFF_MESSAGE, cloudTranslateAllowed } from '../../core/social/translateConsent';
import { chatAutoTranslateKey, chatBgKey, chatFontSizeKey, RECENT_REACTIONS_KEY, TRANSLATION_TARGET_LANG_KEY } from '../../core/storage/kvKeys';
import { scopedKvGet, scopedKvSet } from '../../core/storage/profileScopedKv';
import { insertSortedDesc } from '../../core/utils/insertSortedDesc';
import { createCoalescedTask } from '../../core/utils/coalescedTask';
import { MAX_MESSAGE_TEXT } from '../../core/social/messageTextLimit';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { useTabRef } from '../TabRefContext';
import { useBackHandler } from '../../core/hooks/useBackHandler';

type Props = {
  pair: KeyPairBytes;
  peerJump?: { peer: string; token: number } | null;
  // v4.32.228 (BUG-07): монотонный счётчик. App.tsx инкрементит его при повторном
  // тапе по уже активному табу «Чаты» — это сигнал «вернись из открытого диалога к
  // списку чатов» (поведение «tap active tab → pop to root»). 0 = нет сигнала.
  popToListToken?: number;
  // v4.32.228 (BUG-07): вызывается, когда открытый диалог закрывается (back в
  // шапке, hardware BACK, либо pop-to-list по повторному тапу таба). App.tsx
  // сбрасывает «отработавший» peerJump, чтобы не съедать лишний back на списке.
  onConversationClosed?: () => void;
};

import { PAGE, DM_SYS_PREFIX } from './chat-utils/constants';
import { matchesSearch } from '../../core/social/searchableText';
import { parseReactionMap } from '../../core/social/reactionMapPolicy';
import { anchorStillPresent, clampHitIndex, hitIndexForAnchor, hitLabel, hitSetKey, stepHitIndex } from '../../core/social/searchCursor';
import { truncateReplyPreview } from '../../core/social/messagePreview';
import { isContactCard, makeContactCardText } from '../../core/social/contactCardEnvelope';
import { isForwardedMessage, makeForwardBundleText, makeForwardText, parseForwardedMessage } from '../../core/social/forwardEnvelope';
import { isDocMessage, makeDocText } from '../../core/social/docEnvelope';
import { isLocationMessage, makeLocationText } from '../../core/social/locationEnvelope';
import { isViewOnceMessage, makeViewOnceText, stripViewOncePrefix } from './chat-utils/viewOnce';
import { isVoiceMessage, makeVoiceText } from '../../core/social/voiceEnvelope';
import { reverseGeocodeLabel } from '../../core/social/geocode';
import { EmojiPanel } from './chat-components/EmojiPanel';
import { LinkPreview, extractFirstUrl } from './chat-components/LinkPreview';
import { SendEffectOverlay, detectSendEffect } from './chat-components/SendEffectOverlay';
import { runViewOnceTap, VIEW_ONCE_DELETE_DELAY_MS } from './chat-utils/viewOnceTap';
import { getEmojiSuggestions, isBigEmoji } from './chat-utils/emoji';
import {
  injectDateSeparators,
  type DateSeparatorItem,
  type ChatListItem,
} from './chat-utils/dates';
import { muteRemainingLabel } from '../time/durationLabel';
// v4.32.167: зеркалим chat-mute в muteStore, чтобы FCM gate
// (pushNotifications.ts isMuted('chat', did)) глушил пуши.
import { setMuted as muteSet, unmute as muteUnset } from '../../core/notifications/muteStore';

/** Количество сообщений для инкрементального polling — меньше PAGE для экономии SQLite. */
// v4.32.227 (PERF #34): 20→12. The open-chat poll re-reads + re-decrypts this
// many rows every 15s; 12 still covers any realistic burst between polls while
// cutting the per-poll SQLite/decrypt cost ~40%.
const POLL_BATCH = 12;

/**
 * Сколько удалённое сообщение личной переписки лежит в корзине. Срок нужен и
 * тому, кто кладёт, и тому, кто показывает: разъехавшись, они дали бы
 * «недавно удалённые», которые ничего не показывают, но продолжают хранить.
 */
const DM_RECENTLY_DELETED_TTL_MS = 30 * 86_400_000;

// ─── Emoji reactions available ───────────────────────────────────────────────
const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '👏', '🎉', '💯'];

// Text rendering components extracted to chat-components/text/ (D.3.2)
import { MessageBlock } from './chat-components/text/MessageBlock';
import { CollapsibleMessageBlock } from './chat-components/text/CollapsibleMessageBlock';
// Bubble components extracted to chat-components/ (D.3.3)
import { MessageStatusIcon } from './chat-components/MessageStatusIcon';
import { ReactionBar } from './chat-components/ReactionBar';
import { DmPollBubble } from './chat-components/DmPollBubble';
import { ContactCardBubble } from './chat-components/ContactCardBubble';
import { DocBubble } from './chat-components/DocBubble';
import { LocationBubble } from './chat-components/LocationBubble';
import { LiveLocationBubble } from './chat-components/LiveLocationBubble';
import { MediaStrip } from './chat-components/MediaStrip';
import { contactLabel, nameInitial } from '../../core/social/contactLabel';
// ─── Forward Message Modal ────────────────────────────────────────────────────
// Extracted to src/ui/components/modals/chat/ChatForwardModal.tsx (B.3.f).
import { ForwardModal } from '../components/modals/chat/ChatForwardModal';
import { ReactionsModal } from '../components/modals/chat/ChatReactionsModal';
import { MessageInfoModal } from '../components/modals/chat/ChatMessageInfoModal';




// ─── Reaction detail modal (who reacted) ─────────────────────────────────────
function ReactionDetailModal({
  target,
  contacts,
  myDid,
  onClose,
}: {
  target: { activeEmoji: string; map: Record<string, string[]> } | null;
  contacts: Contact[];
  myDid: string;
  onClose: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.409: активная вкладка эмодзи. Лист лежит на поверхности.
  const tabTint = useMemo(() => badgeTint(colors, 'accent', colors.surface), [colors]);
  const { parseDidKey: parseDid } = require('../../core/identity/did') as typeof import('../../core/identity/did');
  const [activeTab, setActiveTab] = useState<string>('');

  // Update active tab when target changes
  useEffect(() => {
    if (target) setActiveTab(target.activeEmoji);
  }, [target]);

  function didToName(did: string): string {
    if (did === myDid) return 'Вы';
    try {
      const pk = parseDid(did);
      if (!pk) return shortIdentity(did);
      const b64 = Buffer.from(pk).toString('base64');
      const c = contacts.find((x) => x.peerPublicKey === b64);
      return contactLabel(c?.displayName, shortIdentity(did));
    } catch {
      return shortIdentity(did);
    }
  }

  const entries = Object.entries(target?.map ?? {}).filter(([, d]) => d.length > 0);
  const activeDids = (target?.map ?? {})[activeTab] ?? [];

  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <AppPressable style={rdStyles.overlay} onPress={onClose}>
        <AppPressable style={[rdStyles.sheet, { backgroundColor: colors.surface }]} onPress={(e) => e.stopPropagation()}>
          {/* Emoji tabs */}
          {entries.length > 1 ? (
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
              {entries.map(([emoji, dids]) => (
                <AppPressable
                  key={emoji}
                  onPress={() => setActiveTab(emoji)}
                  style={[
                    rdStyles.tab,
                    { borderColor: activeTab === emoji ? colors.accent : colors.border, backgroundColor: activeTab === emoji ? tabTint.fill : 'transparent' },
                  ]}
                >
                  <Text style={{ fontSize: 18 }}>{emoji}</Text>
                  <Text style={{ fontSize: 12, color: activeTab === emoji ? tabTint.ink : colors.textMuted, marginLeft: 4, fontWeight: '600' }}>{dids.length}</Text>
                </AppPressable>
              ))}
            </View>
          ) : (
            <Text style={[rdStyles.heading, { color: colors.text }]}>
              {activeTab || (target?.activeEmoji ?? '')} Реакция
            </Text>
          )}
          {/* Users list */}
          <View style={{ width: '100%', maxHeight: 200 }}>
            <ScrollView showsVerticalScrollIndicator={false}>
              {activeDids.map((did) => (
                <View key={did} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 }}>
                  <View style={{ ...avatarShape(32), backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 14 }}>{nameInitial(didToName(did))}</Text>
                  </View>
                  <Text style={{ color: colors.text, fontSize: 15 }}>{didToName(did)}</Text>
                </View>
              ))}
              {activeDids.length === 0 ? (
                <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 14, paddingVertical: 12 }}>Нет данных</Text>
              ) : null}
            </ScrollView>
          </View>
          <AppPressable style={[rdStyles.closeBtn, { borderColor: colors.border }]} onPress={onClose}>
            <Text style={{ color: colors.accent }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}
const rdStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', alignItems: 'center', padding: 24 },
  sheet: { borderRadius: radius.lg, paddingVertical: 20, paddingHorizontal: 24, width: 300, maxWidth: '90%', alignItems: 'center', gap: 10 },
  heading: { fontSize: 28, marginBottom: 6 },
  tab: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.xl, borderWidth: 1.5 },
  name: { fontSize: 15, textAlign: 'center' },
  closeBtn: { marginTop: 8, paddingHorizontal: 24, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1 },
});

// ─── Message bubble ──────────────────────────────────────────────────────────
const MessageRow = React.memo(
  function MessageRowInner({
    item,
    gateway,
    onLongPress,
    onSwipeReply,
    onSwipeStar,
    onSelect,
    isSelected,
    highlight,
    searchMatch,
    onReplyTap,
    getReplyTo,
    onImagePress,
    onReactionTap,
    onRetryFailed,
    onDoubleTap,
    onViewOnceTap,
    pair,
    translatedText,
    fontSizeOverride,
  }: {
    item: ChatMessageRow;
    gateway: string;
    onLongPress: (item: ChatMessageRow) => void;
    onSwipeReply: (item: ChatMessageRow) => void;
    onSwipeStar?: (item: ChatMessageRow) => void;
    onSelect?: (item: ChatMessageRow) => void;
    isSelected?: boolean;
    highlight?: boolean;
    searchMatch?: boolean;
    onReplyTap?: (replyToId: string) => void;
    getReplyTo: (id: string) => ChatMessageRow | null;
    onImagePress: (urls: string[], index: number) => void;
    onReactionTap?: (emoji: string, dids: string[], reactions: string) => void;
    onRetryFailed?: (item: ChatMessageRow) => void;
    onDoubleTap?: (item: ChatMessageRow) => void;
    onViewOnceTap?: (item: ChatMessageRow) => void;
    pair: KeyPairBytes;
    translatedText?: string;
    fontSizeOverride?: number;
  }): React.ReactElement {
    const { colors, fontSize: themeFontSize } = useTheme();
    const msgFontSize = fontSizeOverride ?? themeFontSize;
    const swipeAnim = useRef(new RNAnimated.Value(0)).current;
    const lastTapRef = useRef(0);
    const doubleTapHeart = useRef(new RNAnimated.Value(0)).current;
    const highlightFadeAnim = useRef(new RNAnimated.Value(0)).current;
    useEffect(() => {
      if (highlight) {
        highlightFadeAnim.setValue(1);
        RNAnimated.timing(highlightFadeAnim, { toValue: 0, duration: 1400, delay: 300, useNativeDriver: false }).start();
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [highlight]);
    const timeStr = clockTime(item.createdAt);
    const replyOrigin = item.replyToId ? getReplyTo(item.replyToId) : null;
    // v4.32.598: пустая строка от непрочитанного столбца прежде проходила
    // как «это не ответ» — рамка цитаты не рисовалась вовсе.
    const replyQuote = quoteView(replyOrigin?.text, item.replyToPreview, item.replyToPreviewUnreadable);
    const replyPreview = replyQuote.text;
    const isOut = item.direction === 'out';
    // Detect emoji-only messages for transparent bubble rendering
    const rawDisplayText = item.text ?? '';
    const isEmojiOnlyMsg = !item.mediaCids && !rawDisplayText.startsWith('\x01') && !rawDisplayText.startsWith(POLL_PREFIX) && !isVoiceMessage(rawDisplayText) && !isDocMessage(rawDisplayText) && !isForwardedMessage(rawDisplayText) && !item.replyToId && isBigEmoji(rawDisplayText);
    const bubbleBg = isEmojiOnlyMsg ? 'transparent' : (isOut ? colors.bubbleOut : colors.surfaceHigh);
    // Блок цитаты лежит ВНУТРИ пузыря, поэтому и заливка, и чернила в нём
    // считаются от пузыря, а не от фона ленты (v4.32.387).
    const quoteFill = nestedFill(bubbleBg);
    const quoteInk = inkOn(colors, quoteFill);
    /**
     * Плашки реакций лежат внутри пузыря — той же вложенности, что и цитата.
     * Но у сообщения из одних эмодзи пузыря нет (bubbleBg прозрачный), и
     * плашка ложится прямо на фон ленты; считать её от 'transparent' нельзя
     * (v4.32.395).
     */
    const reactionHost = isEmojiOnlyMsg ? colors.background : bubbleBg;
    /**
     * Содержимое лежит на тёмной заливке исходящего пузыря — значит красится
     * `bubbleOutText`, а не палитрой темы.
     *
     * v4.32.346: у сообщения из одних эмодзи пузыря нет (фон прозрачный), и
     * содержимое оказывается на фоне чата — там нужны обычные цвета темы. До
     * этого признак «исходящее» и признак «на тёмной заливке» не различались.
     */
    const onDarkFill = isOut && !isEmojiOnlyMsg;
    /**
     * v4.32.413: поверхность содержимого пузыря. Заливка уже вычислена выше
     * (`reactionHost` — это `bubbleBg`, а у сообщения из одних эмодзи, где
     * пузыря нет вовсе, фон списка), поэтому чернила выводятся из неё, а не из
     * `isOut`. Раньше содержимое, нарисованное прямо в экране, писало белый с
     * прозрачностью руками: в светлой теме подвал давал на #0068D6 3.40:1,
     * линия под «Переслано» — 1.70:1, а подпись перевода на эмодзи-сообщении
     * (пузыря нет, под ней фон списка) — белым по белому.
     */
    const bubble = bubbleSurfaceOn(colors, reactionHost, onDarkFill);
    /** Время и «изменено» в подвале пузыря. */
    const footerInk = bubble.ink.secondary;

    const panResponder = useRef(PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => {
        if (g.dx > 0 && g.dx < 80) swipeAnim.setValue(g.dx);
        else if (g.dx < 0 && g.dx > -80) swipeAnim.setValue(g.dx);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx > 50) {
          Vibration.vibrate(20);
          onSwipeReply(item);
        } else if (g.dx < -50 && onSwipeStar) {
          Vibration.vibrate(20);
          onSwipeStar(item);
        }
        RNAnimated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
      },
      onPanResponderTerminate: () => {
        RNAnimated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
      },
    })).current;

    /**
     * v4.32.532: новое сообщение приезжает, а не возникает.
     *
     * Анимация даётся ТОЛЬКО свежему сообщению (моложе двух секунд на момент
     * монтирования). FlatList переиспользует строки при прокрутке; без этого
     * условия вся переписка заново выезжала бы каждый раз, когда её пролистали
     * туда-обратно, — а это ровно тот случай, когда анимация мешает.
     *
     * Решение принимается один раз в ref: `Date.now()` при каждом рендере
     * менял бы ответ на середине жизни строки.
     */
    const appear = useRef(new RNAnimated.Value(
      !isReducedMotion() && Date.now() - item.createdAt < 2000 ? 0 : 1
    )).current;
    useEffect(() => {
      // @ts-expect-error _value — единственный способ прочитать стартовое значение
      if (appear._value === 1) return;
      RNAnimated.timing(appear, {
        toValue: 1,
        duration: motion.base,
        useNativeDriver: true,
      }).start();
    }, [appear]);

    // v4.32.237: системная строка личного чата («включены исчезающие
    // сообщения») — серым по центру, без пузыря, свайпов и меню, как в
    // группах. Возврат стоит после всех хуков, иначе порядок хуков поплывёт.
    if (rawDisplayText.startsWith(DM_SYS_PREFIX)) {
      return (
        <View style={{ paddingVertical: 6, paddingHorizontal: 24 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12, textAlign: 'center' }}>
            {rawDisplayText.slice(DM_SYS_PREFIX.length)}
          </Text>
        </View>
      );
    }

    return (
      <RNAnimated.View
        style={[
          s.bubbleRow,
          isOut ? s.bubbleOut : s.bubbleIn,
          {
            opacity: appear,
            transform: [
              { translateX: swipeAnim },
              { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
            ],
          },
          isSelected ? { backgroundColor: rowMark(colors, 'selected') } : searchMatch ? { backgroundColor: rowMark(colors, 'found') } : null,
        ]}
        {...(onSelect ? {} : panResponder.panHandlers)}
      >
        {highlight ? (
          <RNAnimated.View
            style={[StyleSheet.absoluteFill, {
              backgroundColor: highlightFadeAnim.interpolate({ inputRange: [0, 1], outputRange: [rowMark(colors, 'found', 0), rowMark(colors, 'found', 0.35)] }),
            }]}
            pointerEvents="none"
          />
        ) : null}
        {isSelected !== undefined ? (
          <View style={{ justifyContent: 'center', paddingLeft: 4, paddingRight: 8 }}>
            <View style={[s.selCircle, isSelected ? { backgroundColor: colors.primary, borderColor: colors.primary } : { borderColor: colors.textMuted }]}>
              {isSelected ? <Ionicons name="checkmark" size={13} color={contrastingInk(colors.primary)} /> : null}
            </View>
          </View>
        ) : null}
        <AppPressable
          style={[s.bubble, isOut ? s.bubbleAnchorOut : s.bubbleAnchorIn, { backgroundColor: bubbleBg }]}
          delayLongPress={400}
          onLongPress={() => onSelect ? onSelect(item) : onLongPress(item)}
          onPress={() => {
            if (onSelect) { onSelect(item); return; }
            const now = Date.now();
            if (now - lastTapRef.current < 320 && onDoubleTap) {
              onDoubleTap(item);
              RNAnimated.sequence([
                RNAnimated.timing(doubleTapHeart, { toValue: 1, duration: 180, useNativeDriver: true }),
                RNAnimated.timing(doubleTapHeart, { toValue: 0, duration: 400, useNativeDriver: true }),
              ]).start();
            }
            lastTapRef.current = now;
          }}
        >
          {/* v4.32.301: убрана вторая метка «Переслано» по колонке
              forwardedFrom — колонку не заполнял никто, а заполнись она, метка
              встала бы над настоящей «Переслано от N» (она ниже, из конверта
              '\x08fwd:'). Пересылка живёт в тексте сообщения, см. ensureMessageExtraColumns. */}
          {item.replyToId && (replyPreview !== null || replyQuote.unreadable) ? (
            <AppPressable
              style={[s.quotedBlock, { backgroundColor: quoteFill }]}
              onPress={() => item.replyToId && onReplyTap?.(item.replyToId)}
              hitSlop={4}
            >
              <View style={[s.quotedBar, { backgroundColor: quoteInk.accent }]} />
              <Text
                style={[
                  s.quotedText,
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
                  : isForwardedMessage(replyPreview) ? `↪ ${parseForwardedMessage(replyPreview)?.originalText?.slice(0, 60) ?? 'Пересланное сообщение'}`
                  : replyPreview}
              </Text>
            </AppPressable>
          ) : null}
          {isUnreadableMessage(item) ? (
            // v4.32.559: столбец с текстом не открылся ключом данных. Прежде
            // сюда приходила пустая строка, и пузырь выглядел ровно как
            // сообщение без подписи — единственный признак того, что с ключом
            // что-то не так, был спрятан от того, кто мог бы на это ответить.
            <Text style={{ fontSize: 13, color: colors.textMuted, fontStyle: 'italic' }}>{UNREADABLE_MESSAGE_TEXT}</Text>
          ) : (item.text ?? '').startsWith(POLL_PREFIX) ? (
            <DmPollBubble
              messageId={item.id}
              pollText={item.text ?? ''}
              isOut={isOut}
              myPubB64={Buffer.from(pair.publicKey).toString('base64')}
              peerPubB64={item.contactPubB64}
              pid={profileManager.getActiveProfile()?.id ?? 1}
            />
          ) : isContactCard(item.text ?? '') ? (
            <ContactCardBubble text={item.text ?? ''} isOutgoing={isOut} pair={pair} />
          ) : isDocMessage(item.text ?? '') ? (
            <DocBubble text={item.text ?? ''} isOutgoing={isOut} gateway={gateway} />
          ) : isLocationMessage(item.text ?? '') ? (
            <LocationBubble text={item.text ?? ''} isOutgoing={isOut} />
          ) : isGifMessage(item.text ?? '') ? (
            <GifBubble url={parseGifUrl(item.text ?? '')} isMe={isOut} />
          ) : isLiveLocMessage(item.text ?? '') ? (
            <LiveLocationBubble text={item.text ?? ''} isOutgoing={isOut} />
          ) : (item.text ?? '').startsWith('\x02') || (item.text ?? '').startsWith('\x03') || isLeakedGroupEnvelope(item.text ?? '') ? (
            // v4.32.227 (KB-2): defensive guard. A legacy/echoed group-control
            // envelope (\x02grp: message, \x03grpr: read-receipt) that leaked into
            // DM storage must NEVER render its raw JSON — it embeds a member pubkey
            // and a local file:// media path. messaging.ts now drops these in BOTH
            // directions at the source so no new rows are created; this neutralises
            // any pre-existing leaked row (text is encrypted at rest, so we hide it
            // at render time rather than risk a decrypt-and-delete sweep).
            // IB-02: also catches bare `grp:{`/`grpr:{` rows stored without the
            // control byte by older builds.
            <Text style={{ fontSize: 13, color: colors.textMuted, fontStyle: 'italic' }}>Системное сообщение</Text>
          ) : legacyMediaPlaceholder(item.text ?? '') ? (
            // IB-02: legacy media envelope stored without its control byte (bare
            // `voice:{`/`doc:{`/`loc:{`...). The embedded local file:// uri is dead
            // cross-device anyway; render a friendly label instead of leaking JSON.
            <Text style={{ fontSize: 13, color: colors.textMuted, fontStyle: 'italic' }}>{legacyMediaPlaceholder(item.text ?? '')}</Text>
          ) : !isVoiceMessage(item.text ?? '') && !(isViewOnceMessage(item.text ?? '') && !item.mediaCids) ? (() => {
            // v4.32.173: text-only view-once рендерится отдельно (ниже), сюда
            // не попадает — иначе VIEW_ONCE_PREFIX утекал бы в UI как "\tvo:...".
            const fwdInfo = isForwardedMessage(item.text ?? '') ? parseForwardedMessage(item.text ?? '') : null;
            const displayText = fwdInfo ? stripViewOncePrefix(fwdInfo.originalText) : stripViewOncePrefix(item.text ?? '');
            const fwdLabel = fwdInfo ? (fwdInfo.senderName ? `Переслано от ${fwdInfo.senderName}` : 'Переслано') : null;
            return (
              <>
                {fwdLabel ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: bubble.hairline }}>
                    <Ionicons name="arrow-redo-outline" size={12} color={bubble.icon} />
                    <Text style={{ fontSize: font.xs, color: bubble.icon, marginLeft: 3, fontStyle: 'italic' }}>{fwdLabel}</Text>
                  </View>
                ) : null}
                {isBigEmoji(displayText) ? (
                  <Text style={{ fontSize: 52, textAlign: 'center' }}>{displayText}</Text>
                ) : (
                  // v4.32.346: цвет самого текста сообщения не зависел от
                  // пузыря — всегда `colors.text`. В тёмной теме это почти
                  // белый и на тёмно-синем пузыре читался, в светлой —
                  // near-black на том же тёмно-синем, то есть 1.4:1: свои
                  // сообщения в светлой теме не были видны вовсе. Всё
                  // остальное содержимое пузыря (пересланное, перевод,
                  // разделители) ветвилось по `isOut` правильно — не ветвилась
                  // ровно та строка, которую и читают.
                  <CollapsibleMessageBlock text={displayText} baseStyle={[s.bubbleText, { color: bubble.ink.text, fontSize: msgFontSize }]} isOutgoing={isOut} />
                )}
                {translatedText ? (
                  <>
                    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: bubble.hairline, marginVertical: 5 }} />
                    <Text style={{ fontSize: font.xs, color: bubble.ink.secondary, marginBottom: 2 }}>🌐 переведено</Text>
                    <MessageBlock text={translatedText} baseStyle={[s.bubbleText, { color: bubble.ink.text, fontSize: msgFontSize - 1 }]} isOutgoing={isOut} />
                  </>
                ) : null}
                {(() => {
                  const u = extractFirstUrl(displayText);
                  return u ? <LinkPreview url={u} isOutgoing={isOut} fromPeer={!isOut} /> : null;
                })()}
              </>
            );
          })() : null}
          {/* v4.32.597: столбец с вложениями не открылся ключом. Молчать об
              этом значит выдать сообщение за написанное без вложений — а у
              сообщения без текста не остаётся вообще ничего. */}
          {item.mediaUnreadable ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
              <Ionicons name="image-outline" size={14} color={colors.warning} style={{ marginRight: 4 }} />
              <Text style={{ fontSize: 13, color: colors.warning, fontStyle: 'italic' }}>{UNREADABLE_MEDIA_TEXT}</Text>
            </View>
          ) : item.mediaCids || (item.text && isVoiceMessage(item.text)) || (item.text && isViewOnceMessage(item.text)) ? (
            isViewOnceMessage(item.text ?? '') ? (
              <AppPressable
                onPress={() => onViewOnceTap?.(item)}
                style={{ alignItems: 'center', justifyContent: 'center', height: 120, borderRadius: radius.lg, backgroundColor: bubble.plate.fill, marginTop: 4 }}
              >
                <Ionicons name="eye-outline" size={32} color={bubble.plate.ink.secondary} />
                <Text style={{ color: bubble.plate.ink.text, fontSize: 13, marginTop: 6, fontWeight: '500' }}>
                  {isOut ? 'Один просмотр' : 'Нажмите, чтобы открыть'}
                </Text>
              </AppPressable>
            ) : (
              <MediaStrip
                gateway={gateway}
                mediaCids={item.mediaCids ?? '[]'}
                messageText={item.text}
                isOutgoing={isOut}
                onImagePress={onImagePress}
              />
            )
          ) : null}
          <View style={[s.messageFooter, isOut ? s.messageFooterOut : s.messageFooterIn]}>
            {/* v4.32.384: звезда красится от поверхности, на которой лежит, —
                тем же правилом, что время и «изменено» строкой ниже. Золото
                светлой темы на синем пузыре давало бы 1.5:1. */}
            {item.starred ? <Ionicons name="star" size={10} color={onDarkFill ? bubbleInk(colors).star : colors.star} style={{ marginRight: 3 }} /> : null}
            {/* v4.32.346: время и «изменено» были прибиты к '#6b728e'. Этот
                серый не проходил порог нигде: 2.7:1 на исходящем пузыре, 3.9:1
                на входящем в светлой теме, 3.1:1 в тёмной — при 4.5:1 для
                мелкого текста. Теперь берутся от поверхности, на которой
                лежат. */}
            {item.editedAt ? <Text style={[s.editedLabel, { color: footerInk }]}>изменено · </Text> : null}
            <AppPressable onLongPress={() => Alert.alert('', fullDateTime(item.createdAt))} hitSlop={6}>
              <Text style={[s.messageTime, { color: footerInk }]}>{timeStr}</Text>
            </AppPressable>
            <MessageStatusIcon
              status={item.status}
              cid={item.cid}
              direction={item.direction}
              onDarkFill={onDarkFill}
              onRetry={item.status === 'failed' ? () => onRetryFailed?.(item) : undefined}
            />
          </View>
          {/* v4.32.600: непрочитанный столбец с реакциями прежде был
              неотличим от «на это никто не реагировал». */}
          {item.reactions || item.reactionsUnreadable ? (
            <ReactionBar
              reactions={item.reactions ?? null}
              host={reactionHost}
              unreadable={item.reactionsUnreadable}
              onReactionTap={onReactionTap}
            />
          ) : null}
        </AppPressable>
        <RNAnimated.Text
          style={{
            position: 'absolute',
            fontSize: 36,
            top: '30%',
            alignSelf: 'center',
            opacity: doubleTapHeart,
            transform: [{ scale: doubleTapHeart.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.5, 1.4, 1] }) }],
            pointerEvents: 'none',
          } as import('react-native').StyleProp<import('react-native').TextStyle>}
        >❤️</RNAnimated.Text>
      </RNAnimated.View>
    );
  },
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.item.status === next.item.status &&
    prev.item.text === next.item.text &&
    prev.item.unreadable === next.item.unreadable &&
    prev.item.cid === next.item.cid &&
    prev.item.reactions === next.item.reactions &&
    prev.item.reactionsUnreadable === next.item.reactionsUnreadable &&
    prev.item.editedAt === next.item.editedAt &&
    prev.item.starred === next.item.starred &&
    prev.gateway === next.gateway &&
    prev.pair === next.pair &&
    prev.onSwipeReply === next.onSwipeReply &&
    prev.onSwipeStar === next.onSwipeStar &&
    prev.isSelected === next.isSelected &&
    prev.highlight === next.highlight &&
    prev.searchMatch === next.searchMatch &&
    prev.onSelect === next.onSelect &&
    prev.onReplyTap === next.onReplyTap &&
    prev.onReactionTap === next.onReactionTap &&
    prev.onRetryFailed === next.onRetryFailed &&
    prev.onDoubleTap === next.onDoubleTap &&
    prev.onViewOnceTap === next.onViewOnceTap
);

// ─── Reactions picker modal ───────────────────────────────────────────────────
// Extracted to src/ui/components/modals/chat/ChatReactionsModal.tsx (B.3.f).
// Extracted to src/ui/components/modals/chat/ChatMessageInfoModal.tsx (B.3.f).



// ─── Wallpaper Picker Modal ───────────────────────────────────────────────────
// v4.32.410: набор фонов переехал в src/ui/wallpapers.ts — это ДАННЫЕ, а не
// часть экрана, и рядом с ними живёт правило «что читается поверх обоев».
import { defaultWallpaper, feedGround, type Wallpaper } from '../wallpapers';
import { WallpaperBackground } from '../components/WallpaperBackground';
import { WallpaperPickerModal } from '../components/modals/chat/ChatWallpaperPickerModal';

// ─── Schedule Message Modal ───────────────────────────────────────────────────
import { ScheduleModal } from '../components/modals/chat/ChatScheduleModal';
import { shortIdentity } from '../identity/shortId';
import { clockTime, fullDateTime } from '../../core/time/ruDateTime';
import { rawErrorText, userErrorText } from '../components/userErrorText';
import { runGuardedOp } from '../components/runGuardedOp';
import { createReceiptClaims } from '../../core/social/receiptClaim';
import { COPY_ACTION, COPY_LINK_ACTION, COPIED_TEXT, COPIED_LINK } from '../clipboardText';




// ─── ChatThreadView — pure thread UI ─────────────────────────────────────────
function ChatThreadView({
  pair,
  peerB64,
  displayName,
  onBack,
  initialJumpMsgId,
}: {
  pair: KeyPairBytes;
  peerB64: string;
  displayName: string;
  onBack: () => void;
  initialJumpMsgId?: string;
}): React.ReactElement {
  // v4.32.16: gate через tabRef — НЕ prop, чтобы setTab не вызывал re-render тяжёлого треда.
  const tabRef = useTabRef();
  const { colors, scheme } = useTheme();
  // v4.32.540: отступ под часы и «остров» теперь у экрана, а не у оболочки.
  const insets = useSafeAreaInsets();
  // v4.32.409: плашка «включён фильтр» в шапке. Шапка — поверхность, а не
  // фон экрана, поэтому подложка считается от неё, а значок — от подложки.
  const headerTint = useMemo(() => badgeTint(colors, 'accent', colors.surface), [colors]);
  const myPubB64 = useMemo(
    () => Buffer.from(pair.publicKey).toString('base64'),
    [pair]
  );
  const isSavedMessages = peerB64 === myPubB64;
  const { open: openMedia, element: mediaViewerElement } = useMediaViewer();
  const presence = usePresence(isSavedMessages ? '' : peerB64);
  // v4.32.111 K.11h: детектируем шринк activity через ПРЯМОЙ onLayout — useWindowDimensions
  // на ColorOS не обновляется синхронно, а на Vivo FunTouchOS adjustResize не работает
  // вообще (uiautomator: activity остаётся 1504 из 1600 при клавиатуре 580px — т.е. не
  // шринкается). Измеряем фактическую высоту корня чата: baselineHeight при kb=0,
  // currentHeight при kb>0. Если разница ≈ kbHeight — activity шринкается (Realme),
  // manualKbPad=0. Если нет — не шринкается (Vivo), manualKbPad=kbHeight.
  const kbHeight = useKeyboardHeight();
  const [rootHeight, setRootHeight] = useState(0);
  const baselineHeightRef = useRef(0);
  if (kbHeight === 0 && rootHeight > baselineHeightRef.current) {
    baselineHeightRef.current = rootHeight;
  }
  const activityShrunk = kbHeight > 0 && baselineHeightRef.current - rootHeight > kbHeight / 2;
  const manualKbPad = Platform.OS === 'android' && kbHeight > 0 && !activityShrunk ? kbHeight : 0;
  const [msg, setMsg] = useState('');
  // TextInput can deliver the final keystroke immediately before the send tap,
  // while React state is still waiting for its render. The ref keeps the send
  // path on the same value the native input just delivered.
  const msgRef = useRef('');
  useEffect(() => {
    msgRef.current = msg;
  }, [msg]);
  const [lines, setLines] = useState<ChatMessageRow[]>([]);
  const [sending, setSending] = useState(false);
  const [sendEffectParticles, setSendEffectParticles] = useState<string[] | null>(null);
  const [gifPickerVisible, setGifPickerVisible] = useState(false);
  // v4.32.60: AttachSheet (Telegram-style hub) заменяет Alert attach menu
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [activeLiveLocId, setActiveLiveLocId] = useState<string | null>(null);
  const [optimisticOutgoing, setOptimisticOutgoing] = useState<ChatMessageRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // v4.32.539: место, где остановилась подгрузка — пара «время и id» самой
  // старой прочитанной строки. Раньше её роль играло число уже показанных
  // сообщений, и оно врало: см. chatPageCursor.ts.
  const olderCursorRef = useRef<ChatPageCursor | null>(null);
  // Замок держится в ref, а не в состоянии: два касания подряд успевают
  // пройти проверку до того, как перерисовка донесёт `loadingMore = true`.
  const loadingMoreRef = useRef(false);
  const [gateway, setGateway] = useState('');
  const [isBlocked, setIsBlocked] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [mutedUntil, setMutedUntil] = useState<number | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const peerTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v4.32.125 (AUDIT P2): isMounted guard для deferred callbacks
  // (setTimeout/async awaits), чтобы не делать setState после unmount.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const [replyTo, setReplyTo] = useState<ChatMessageRow | null>(null);
  const [editTarget, setEditTarget] = useState<ChatMessageRow | null>(null);
  const [pinnedMsg, setPinnedMsg] = useState<ChatMessageRow | null>(null);
  const [pinnedMsgList, setPinnedMsgList] = useState<DmPinnedEntry[]>([]);
  const [pinnedMsgIdx, setPinnedMsgIdx] = useState(0);
  const [pinnedListVisible, setPinnedListVisible] = useState(false);
  const [disappearMs, setDisappearMs] = useState<number | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHitIdx, setSearchHitIdx] = useState(0);
  /** Результаты поиска из базы: null — поиск не активен, показываем переписку. */
  const [searchResults, setSearchResults] = useState<ChatMessageRow[] | null>(null);
  /**
   * v4.32.581: сколько строк переписки поиск не смог прочитать. «0/0» без
   * этого счёта одинаково выглядело и при честном отсутствии совпадений, и
   * при истории, которую не открыл ключ данных.
   */
  const [searchScan, setSearchScan] = useState<SearchScan | null>(null);
  const [mediaFilterActive, setMediaFilterActive] = useState(false);
  const [reactionsTarget, setReactionsTarget] = useState<ChatMessageRow | null>(null);
  const [quickReactMsg, setQuickReactMsg] = useState<ChatMessageRow | null>(null);
  const [forwardTarget, setForwardTarget] = useState<ChatMessageRow | null>(null);
  const [forwardBundleText, setForwardBundleText] = useState<string | null>(null);
  const [msgInfoTarget, setMsgInfoTarget] = useState<ChatMessageRow | null>(null);
  const [reactionDetail, setReactionDetail] = useState<{ activeEmoji: string; map: Record<string, string[]> } | null>(null);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const myDid = useMemo(() => publicKeyToDidKey(pair.publicKey), [pair.publicKey]);
  const [scheduleVisible, setScheduleVisible] = useState(false);
  const [pollCreatorVisible, setPollCreatorVisible] = useState(false);
  const [quickRepliesVisible, setQuickRepliesVisible] = useState(false);
  const [quickRepliesList, setQuickRepliesList] = useState<QuickReply[]>([]);
  const [wallpaperPickerVisible, setWallpaperPickerVisible] = useState(false);
  const [pendingImageUris, setPendingImageUris] = useState<string[]>([]);
  const [imageCaption, setImageCaption] = useState('');
  const [viewOncePending, setViewOncePending] = useState(false);
  const [showFormatBar, setShowFormatBar] = useState(false);
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  const [chatCmdFilter, setChatCmdFilter] = useState<string | null>(null);
  const msgSelRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const [composeLinkUrl, setComposeLinkUrl] = useState<string | null>(null);
  const [composeLinkDismissed, setComposeLinkDismissed] = useState<string | null>(null);
  const composeLinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emojiSuggestions = useMemo(() => getEmojiSuggestions(msg), [msg]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgInputRef = useRef<any>(null);
  const [chatWallpaper, setChatWallpaper] = useState<Wallpaper | null>(null);
  /**
   * Что на самом деле нарисовано под лентой.
   *
   * v4.32.533: у разговора без выбора обои теперь тоже есть — градиент по
   * теме. Плоская заливка `colors.background` была не «отсутствием
   * оформления», а таким же решением, просто невидимым, и именно из-за него
   * все разговоры выглядели одинаково. Явный выбор «Без обоев» из набора
   * по-прежнему возможен и по-прежнему даёт плоский фон.
   */
  const wallpaper = chatWallpaper ?? defaultWallpaper(scheme);
  // v4.32.410: всё, что лежит на ленте, считается от ОБОЕВ, а не от палитры.
  // То же правило, что в группах с 387-го, — теперь общее на оба экрана.
  const feed = useMemo(() => feedGround(colors, wallpaper), [colors, wallpaper]);
  const [mediaGalleryVisible, setMediaGalleryVisible] = useState(false);
  const [starredVisible, setStarredVisible] = useState(false);
  const [starredEntries, setStarredEntries] = useState<StarredMessageEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectedIds.size > 0;
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Текст, ждущий записи в черновик; см. saveDraft/flushDraft (v4.32.322). */
  const pendingDraftRef = useRef<string | null>(null);
  /**
   * v4.32.583: черновик не открылся ключом данных. Поле ввода тогда пустое,
   * и любая пустая запись — «набрал букву и стёр», отправка сообщения —
   * молча затирала бы целый шифротекст черновика. См. draftGuard.
   */
  const draftUnreadableRef = useRef(false);
  // v4.32.182 (Round-12 #6): clear all compose/typing timers on unmount so they
  // do not fire setComposeLinkUrl / setTyping after the screen is gone.
  // v4.32.322: таймер черновика отсюда убран — его нельзя просто отменить, не
  // потеряв написанное. Им занимается отдельный эффект рядом с flushDraft.
  useEffect(() => {
    return () => {
      if (composeLinkTimerRef.current) { clearTimeout(composeLinkTimerRef.current); composeLinkTimerRef.current = null; }
      if (typingDebounceRef.current) { clearTimeout(typingDebounceRef.current); typingDebounceRef.current = null; }
    };
  }, []);
  const activeProfileId = profileManager.getActiveProfile()?.id ?? 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flashListRef = useRef<any>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const showScrollToBottomRef = useRef(false);
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const [contactInfoVisible, setContactInfoVisible] = useState(false);
  const [localDisplayName, setLocalDisplayName] = useState(displayName);
  const [scheduledMsgs, setScheduledMsgs] = useState<ScheduledMessage[]>([]);
  const [openUnreadCount, setOpenUnreadCount] = useState(0);
  const openUnreadRef = useRef(0);
  const [autoTranslate, setAutoTranslate] = useState(false);
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({});
  const [translateLang, setTranslateLang] = useState('ru');
  const [chatFontSize, setChatFontSize] = useState<number | null>(null);
  const [scheduledListVisible, setScheduledListVisible] = useState(false);
  const [recentReactions, setRecentReactions] = useState<string[]>([]);
  const [reactionsMoreVisible, setReactionsMoreVisible] = useState(false);
  const [recentlyDeletedVisible, setRecentlyDeletedVisible] = useState(false);
  const [recentlyDeletedList, setRecentlyDeletedList] = useState<Array<{ id: string; text: string; createdAt: number; deletedAt: number; direction: string }>>([]);
  useEffect(() => { setLocalDisplayName(displayName); }, [displayName]);

  // v4.32.61: системная кнопка «Назад» (Android) в открытом чате.
  // Порядок: внутренние non-Modal overlays → композер-бары → return false
  // (App.tsx top-level handler поймает false и закроет peerJump/вернёт на
  // список чатов). Все Modal'ы (attachSheet, gifPicker, pinnedList, search
  // results, starred, mediaGallery, forward, reactions etc.) обрабатывают
  // back сами через prop onRequestClose.
  useBackHandler(true, () => {
    if (tabRef.current !== 'chat') return false;
    if (selectedIds.size > 0) {
      setSelectedIds(new Set());
      return true;
    }
    if (searchVisible) {
      setSearchVisible(false);
      setSearchQuery('');
      return true;
    }
    if (editTarget) {
      setEditTarget(null);
      setMsg('');
      return true;
    }
    if (replyTo) {
      setReplyTo(null);
      return true;
    }
    if (showEmojiPanel) {
      setShowEmojiPanel(false);
      return true;
    }
    if (showFormatBar) {
      setShowFormatBar(false);
      return true;
    }
    if (pendingImageUris.length > 0) {
      setPendingImageUris([]);
      setImageCaption('');
      setViewOncePending(false);
      return true;
    }
    // v4.32.228 (BUG-07): закрываем открытый диалог здесь, а не делегируем наверх
    // через `return false`. Раньше: чат, открытый из СПИСКА чатов (setOpenPeer без
    // peerJump), при hardware BACK проваливался в App.tsx top-level handler, где
    // ветка `if (peerJump)` ложна → срабатывал `tab!=='feed' → scheduleTab('feed')`
    // и пользователя уносило на «Новости» вместо списка чатов. (А чат, открытый
    // через peerJump, наоборот, «застревал»: App чистил peerJump, но openPeer
    // оставался.) Теперь onBack() закрывает диалог → возврат к списку чатов при
    // ЛЮБОМ способе открытия; обработчик верхнего уровня для чатов больше не нужен.
    onBack();
    return true;
  });

  useEffect(() => {
    void loadConfig().then((c) => setGateway(c.ipfs.gatewayUrl.replace(/\/$/, '')));
  }, []);

  // v4.32.31: «Сохранённые сообщения» больше НЕ добавляется как self-contact.
  // Пользователь просил убрать эту запись из списка контактов и из обычного
  // списка чатов — остаётся только закрепленный заголовок в ChatListScreen
  // (он использует myPubB64 напрямую, self-contact ему не нужен).
  // Локальное хранение сообщений self-чата работает и без contact-строки:
  // messaging.ts ветка "Self-chat (Saved Messages) — store locally, no network delivery".

  useEffect(() => {
    if (!peerB64) { setIsBlocked(false); return; }
    // v4.32.318: блок-лист поднимается с диска не мгновенно. Переписку
    // открывают и сразу после запуска — и тогда синхронный ответ был «не
    // заблокирован»: поле ввода активно, шапка обычная. Отправить не дало бы
    // ядро, но узнать об этом человек мог только по отказу.
    let alive = true;
    void rateLimiter.whenReady().then(() => {
      if (alive) setIsBlocked(rateLimiter.isBlocked(peerB64));
    });
    return () => { alive = false; };
  }, [peerB64]);

  // Load and restore draft + mute state when opening chat
  useEffect(() => {
    if (!peerB64) return;
    void listConversations(activeProfileId).then((convs) => {
      const conv = convs.find((c) => c.contactPubB64 === peerB64);
      draftUnreadableRef.current = draftIsUnreadable(conv?.draftUnreadable);
      if (conv?.draftText && hasReadableDraft(conv.draftText, conv.draftUnreadable)) setMsg(conv.draftText);
      if (conv) {
        setIsMuted(conv.muted);
        setMutedUntil(conv.mutedUntil ?? null);
      }
    });
  }, [peerB64, activeProfileId]);

  // Load chat wallpaper
  useEffect(() => {
    if (!peerB64) return;
    // v4.32.190 (Round-20 #5): alive flag + shape validation. kvGet
    // resolves after unmount on fast nav; and a corrupt row stored as
    // `"null"` / `'"x"'` would previously set chatWallpaper to a non-
    // object, crashing `chatWallpaper?.value` access downstream.
    // v4.32.487: оформление разговора — своё у каждого аккаунта: собеседник
    // у двух профилей может быть один и тот же.
    let alive = true;
    void (async () => {
      const raw = await scopedKvGet(chatBgKey(peerB64));
      if (!alive || !raw) return;
      try {
        const p = JSON.parse(raw) as unknown;
        if (p && typeof p === 'object' && !Array.isArray(p)) {
          const o = p as Record<string, unknown>;
          if ((o.type === 'color' || o.type === 'image' || o.type === 'mesh') && typeof o.value === 'string') {
            setChatWallpaper({ type: o.type, value: o.value });
          }
        }
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [peerB64]);

  // Load auto-translate setting
  useEffect(() => {
    if (!peerB64) return;
    void (async () => {
      const raw = await scopedKvGet(chatAutoTranslateKey(peerB64));
      if (raw === '1') setAutoTranslate(true);
    })();
  }, [peerB64]);

  // Notify when contact comes online (if user opted in)
  const prevPresenceBucketRef = useRef<string>('');
  useEffect(() => {
    if (isSavedMessages || !peerB64) return;
    const prev = prevPresenceBucketRef.current;
    const curr = presence.bucket;
    prevPresenceBucketRef.current = curr;
    if (prev && prev !== 'online' && curr === 'online') {
      void (async () => {
        // v4.32.311: просьба своя у каждого аккаунта — контакты у профилей
        // разные, и общая просьба показывала бы второму аккаунту человека,
        // которого он не добавлял.
        const { notifyOnlineGet, notifyOnlineSet } = await import('../../core/settings/privacyPrefs');
        if (await notifyOnlineGet(peerB64)) {
          // Просьба одноразовая: снимаем её сразу.
          await notifyOnlineSet(peerB64, false);
          try {
            const channelId = await notifee.createChannel({ id: 'online_alerts', name: 'Онлайн уведомления', importance: 4 });
            await notifee.displayNotification({ title: 'AirChat — онлайн', body: `${displayName} сейчас в сети`, android: { channelId, smallIcon: NOTIFICATION_SMALL_ICON } });
          } catch { /* best-effort */ }
        }
      })();
    }
  }, [presence.bucket, peerB64, displayName, isSavedMessages]);

  // Load per-chat font size override
  useEffect(() => {
    if (!peerB64) return;
    void (async () => {
      const raw = await scopedKvGet(chatFontSizeKey(peerB64));
      if (raw) { const n = parseInt(raw, 10); if (!isNaN(n) && n > 0) setChatFontSize(n); }
    })();
  }, [peerB64]);

  // Load contacts for reaction detail modal
  useEffect(() => { void listContacts().then(setAllContacts); }, []);

  // v4.32.238: сообщить собеседнику решение «показывать ли моё время входа».
  // Рассылка при смене настройки охватывает только контакты — переписка идёт
  // и с теми, кого в контактах нет, а их приложение тоже считает «был(а) в
  // сети». Отправляется один раз на решение (см. syncLastSeenPrefTo).
  useEffect(() => {
    if (!peerB64) return;
    void syncLastSeenPrefTo(peerB64);
    // v4.32.247: заодно — своё имя, фото и «О себе». Рассылка при правке
    // профиля охватывает только контакты, а переписка идёт и с теми, кого в
    // контактах нет. Отправляется один раз на версию (см. syncMyProfileTo).
    void syncMyProfileTo(peerB64);
  }, [peerB64]);

  // v4.32.312: «не отправлять отметки о прочтении» здесь больше не читают.
  // Значение спрашивает сама sendReadReceipt — там же, где проверяется блок-лист.
  // Прочитанная при открытии копия успевала устареть: настройки открываются
  // ПОВЕРХ переписки, и та не размонтируется, пока человек ходит туда и обратно.

  // Load recently used reactions
  useEffect(() => {
    void (async () => {
      const raw = await scopedKvGet(RECENT_REACTIONS_KEY);
      if (raw) { try { setRecentReactions(JSON.parse(raw) as string[]); } catch { /* */ } }
    })();
  }, []);

  // Load translation target language
  useEffect(() => {
    void (async () => {
      const lang = await scopedKvGet(TRANSLATION_TARGET_LANG_KEY);
      if (lang) setTranslateLang(lang);
    })();
  }, []);

  // Subscribe to peer typing
  useEffect(() => {
    if (!peerB64) return;
    const svc = getMessagingService();
    if (!svc) return;
    const unsub = svc.onTyping(peerB64, () => {
      setPeerTyping(true);
      if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
      peerTypingTimerRef.current = setTimeout(() => setPeerTyping(false), 3000);
    });
    return () => {
      unsub();
      if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
      setPeerTyping(false);
    };
  }, [peerB64]);

  const reloadThread = useCallback(async () => {
    const svc = getMessagingService();
    if (!svc || !peerB64) {
      olderCursorRef.current = null;
      setLines([]); setHasMore(false); setOptimisticOutgoing(null); return;
    }
    const page = await svc.getOlderMessages(peerB64, PAGE, null);
    const filtered = page.messages;
    olderCursorRef.current = page.cursor;
    setLines(filtered);
    setHasMore(page.hasMore);
    setOptimisticOutgoing((opt) => {
      if (!opt) return null;
      const exists = filtered.some(
        (m) => m.direction === 'out' && m.text === opt.text && Math.abs(m.createdAt - opt.createdAt) < 25_000
      );
      return exists ? null : opt;
    });
    // Load pinned message and disappear timer from conversation metadata
    const convs = await listConversations(activeProfileId);
    const conv = convs.find((c) => c.contactPubB64 === peerB64);
    if (conv?.pinnedMessageId) {
      const pinned = filtered.find((m) => m.id === conv.pinnedMessageId) ?? null;
      setPinnedMsg(pinned);
    } else {
      setPinnedMsg(null);
    }
    // Load pinned message list (multiple pinned)
    // v4.32.235: текст берётся из chat_messages, а не из копии в kv — копия
    // лежала открытым текстом мимо шифрования at-rest и устаревала после
    // правки сообщения.
    try {
      const list = await resolveDmPinned(peerB64, activeProfileId);
      setPinnedMsgList(list);
      setPinnedMsgIdx(0);
      // Show most recent pinned msg if no single pin set
      if (!conv?.pinnedMessageId && list.length > 0) {
        const first = filtered.find((m) => m.id === list[0].id) ?? null;
        if (first) setPinnedMsg(first);
      }
    } catch { /* */ }
    setDisappearMs(conv?.disappearAfterMs ?? null);
    // Capture unread count on first open only (before messages are auto-marked as read)
    if (openUnreadRef.current === 0 && (conv?.unreadCount ?? 0) > 0) {
      openUnreadRef.current = conv!.unreadCount;
      setOpenUnreadCount(conv!.unreadCount);
    }
  }, [peerB64, activeProfileId]);

  useEffect(() => { void reloadThread(); }, [reloadThread]);

  /**
   * Запрашивает последние POLL_BATCH сообщений, мёржит по id с O(N+M) через insertSortedDesc.
   * Инвариант: lines всегда отсортирован DESC (новейшие первыми).
   */
  // v4.32.545: своя склейка вызовов уехала в coalescedTask. Здесь она
  // отказывала наружу, а зовут это обновление из двадцати восьми мест, почти
  // все — `void appendNewMessages()`: сорвавшееся чтение базы не попадало ни в
  // журнал, ни на экран, переписка просто переставала пополняться.
  const appendTaskRef = useRef(
    createCoalescedTask({
      onError: (e) => log.error('ui_chat_append_failed', { err: rawErrorText(e) }),
    }),
  );
  const appendNewMessages = useCallback(async () => {
    await appendTaskRef.current.run(async () => {
      const svc = getMessagingService();
      if (!svc || !peerB64) return;
      // v4.32.17: timing для getMessages — подозреваемый в 2.2с SQLite lock contention.
      const _t0 = Date.now();
      const latest = await svc.getMessages(peerB64, POLL_BATCH, 0);
      if (!isMountedRef.current) return;
      const _dt = Date.now() - _t0;
    if (_dt > 150) log.info('ui_chat_poll_getmsgs', { ms: _dt, n: latest.length });
    const filtered = latest.filter((m) => m.text !== '\u200b');
    if (filtered.length === 0) return;

      setLines((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const newOnes = filtered.filter((m) => !existingIds.has(m.id));

      // Обновляем статусы существующих сообщений (например, 'sending' → 'sent')
      const updatedStatuses = new Map(filtered.map((m) => [m.id, m.status]));
      const hasStatusChanges = prev.some(
        (m) => updatedStatuses.has(m.id) && updatedStatuses.get(m.id) !== m.status
      );
      const updated = hasStatusChanges
        ? prev.map((m) =>
            updatedStatuses.has(m.id) ? { ...m, status: updatedStatuses.get(m.id)! } : m
          )
        : prev;

      if (newOnes.length === 0) {
        return hasStatusChanges ? updated : prev;
      }
      // O(N + M) слияние: сохраняет DESC-инвариант, обрабатывает out-of-order доставку
      return insertSortedDesc(updated, newOnes);
      });

      setOptimisticOutgoing((opt) => {
      if (!opt) return null;
      const confirmed = filtered.some(
        (m) =>
          m.direction === 'out' &&
          m.text === opt.text &&
          Math.abs(m.createdAt - opt.createdAt) < 25_000
      );
      return confirmed ? null : opt;
      });
    });
  }, [peerB64]);

  useEffect(() => {
    setOptimisticOutgoing(null);
    openUnreadRef.current = 0;
    setOpenUnreadCount(0);
    didScrollToUnreadRef.current = false;
  }, [peerB64]);

  // Track whether we've auto-scrolled to first unread (reset on peer change)
  const didScrollToUnreadRef = useRef(false);

  // v4.32.124 (AUDIT P0 #9): refs for values read inside the translate
  // pipeline. Previously the `useCallback([])` captured `translateLang` at
  // mount, and the effect suppressed `translationCache` from deps to avoid
  // re-trigger loops — so a language change would never propagate and
  // cache-fill inside the async loop read a stale snapshot. Refs fix both
  // without re-running the effect per-character.
  const translateLangRef = useRef(translateLang);
  useEffect(() => { translateLangRef.current = translateLang; }, [translateLang]);
  const translationCacheRef = useRef(translationCache);
  useEffect(() => { translationCacheRef.current = translationCache; }, [translationCache]);
  // Тот же приём для showMessageMenu: он передаётся в мемоизированные строки
  // списка (onLongPress), поэтому включать в его deps volatile-значения нельзя —
  // идентичность колбэка менялась бы на каждое новое сообщение и убивала
  // мемоизацию строк (тот самый re-render storm, чинившийся в v4.32.227).
  const linesRef = useRef(lines);
  useEffect(() => { linesRef.current = lines; }, [lines]);
  const pinnedMsgListRef = useRef(pinnedMsgList);
  useEffect(() => { pinnedMsgListRef.current = pinnedMsgList; }, [pinnedMsgList]);
  const onBackRef = useRef(onBack);
  useEffect(() => { onBackRef.current = onBack; }, [onBack]);

  // v4.32.541: что уже ушло на перевод. Раньше дедупликации не было вовсе:
  // эффект перезапускался на каждое изменение списка, а заполнение кэша
  // случалось лишь в конце пачки — поэтому пришедшее во время перевода
  // сообщение начинало ВТОРУЮ пачку с теми же текстами, и один и тот же
  // текст уходил на чужой сервис по нескольку раз.
  const translateClaimsRef = useRef(createReceiptClaims());
  // Запрос, который идёт прямо сейчас: его надо оборвать при уходе с экрана.
  const translateAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    translateAbortRef.current?.abort();
    translateAbortRef.current = null;
  }, []);

  // Auto-translate incoming messages
  const translateVisibleMessages = useCallback(async (msgs: ChatMessageRow[]) => {
    // v4.32.181 (Round-11 #9): master privacy switch + OTP skip. Do not leak
    // short numeric codes (2FA/OTP) to third-party translation endpoint.
    // v4.32.486: одно решение на все места перевода — social/translateConsent.
    if (!(await cloudTranslateAllowed())) return;
    if (!isMountedRef.current) return;
    // v4.32.366: решение «что можно отдать наружу» — одно на все пять мест
    // перевода (core/social/cloudTranslate). Здешний список исключений знал
    // про \x01 и \x04, а служебных префиксов в приложении 22, включая
    // карточку контакта с данными третьего человека.
    const toTranslate = msgs.filter((m) => m.direction === 'in' && translateBlockReason(m.text ?? '') === null);
    // translate up to 20 at a time to avoid rate limiting
    // Занимаем ПОСЛЕ отсечения по двадцать: занять всё — значит навсегда
    // потерять двадцать первое сообщение, до него бы просто не дошли.
    const batch = toTranslate.slice(0, 20);
    const claimed = new Set(translateClaimsRef.current.claim(batch.map((m) => m.id)));
    const queue = batch.filter((m) => claimed.has(m.id));
    const updates: Record<string, string> = {};
    for (let i = 0; i < queue.length; i++) {
      const m = queue[i];
      // Уход с экрана обрывает пачку. До v4.32.541 её никто не останавливал:
      // двадцать запросов по восемь секунд ожидания — это две с половиной
      // минуты, в течение которых закрытая переписка продолжала отдавать
      // тексты сообщений чужому сервису.
      if (!isMountedRef.current) {
        translateClaimsRef.current.release(queue.slice(i).map((q) => q.id));
        break;
      }
      const url = buildTranslateUrl(m.text, translateLangRef.current);
      if (!url) {
        // Язык испорчен — следующие дадут тот же отказ. Их не переводили,
        // значит и держать занятыми нельзя: язык ещё поправят.
        translateClaimsRef.current.release(queue.slice(i).map((q) => q.id));
        break;
      }
      const ctrl = new AbortController();
      translateAbortRef.current = ctrl;
      const to = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        const out = parseTranslation(await res.json(), m.text);
        if (out.ok) updates[m.id] = out.text;
      } catch { /* ignore network errors */ } finally {
        clearTimeout(to);
        if (translateAbortRef.current === ctrl) translateAbortRef.current = null;
      }
      // Не перевелось — отпускаем: пометка нужна лишь на время запроса, чтобы
      // соседняя пачка не отправила тот же текст второй раз. Держать её после
      // сетевого сбоя значило бы потерять перевод до закрытия переписки.
      if (updates[m.id] === undefined) translateClaimsRef.current.release([m.id]);
    }
    if (!isMountedRef.current) return;
    if (Object.keys(updates).length > 0) {
      setTranslationCache((prev) => ({ ...prev, ...updates }));
    }
  }, []);

  // When autoTranslate turns on or lines change, translate new messages.
  // Reads translationCache via ref to avoid effect-loop; omission of
  // translationCache from deps is therefore intentional and safe.
  useEffect(() => {
    if (!autoTranslate || lines.length === 0) return;
    const cache = translationCacheRef.current;
    const untranslated = lines.filter(
      (m) => m.direction === 'in' && !cache[m.id] && m.text && !m.text.startsWith('\x01')
    );
    if (untranslated.length > 0) {
      void translateVisibleMessages(untranslated);
    }
  }, [autoTranslate, lines, translateVisibleMessages]);

  // Load scheduled messages for this peer
  const reloadScheduled = useCallback(async () => {
    if (!peerB64) return;
    const all = await listAllScheduledMessages(activeProfileId);
    setScheduledMsgs(all.filter((m) => m.contactPubB64 === peerB64));
  }, [peerB64, activeProfileId]);
  useEffect(() => { void reloadScheduled(); }, [reloadScheduled]);

  // Отметка «эта ветка открыта» — чтобы не показывать баннер о сообщении из
  // переписки, которую человек и так читает.
  //
  // v4.32.525: проверки на активную вкладку здесь больше нет. Она читалась из
  // tabRef ровно один раз, при монтировании ветки, и никогда не пересчитывалась:
  // ref по своему устройству не вызывает перерисовку. Отсюда выходило и то, и
  // другое. Ветка, смонтированная не на вкладке переписки (переход по
  // уведомлению), не отмечалась вовсе — и баннер приходил поверх открытого
  // диалога. А отмеченная — не снимала отметку при уходе на другую вкладку,
  // потому что вкладки остаются смонтированными: уведомления от этого человека
  // пропадали до перезапуска приложения. Экран отвечает за «какая ветка
  // открыта»; про вкладку и передний план знают MainTabs и AppState, и сходится
  // это в activeChatSuppress.
  useEffect(() => {
    if (!peerB64) return;
    const peerDid = publicKeyToDidKey(new Uint8Array(Buffer.from(peerB64, 'base64')));
    setActiveChatDid(peerDid);
    return () => { setActiveChatDid(null); };
  }, [peerB64]);

  // v4.32.536: три места отправляли отметки о прочтении, и каждое считало
  // по-своему — см. `core/social/receiptClaim`. Теперь счётчик один на экран, и
  // он же решает, что уже ушло. Занимаем идентификаторы ДО отправки (иначе два
  // места пошлют одно и то же), а при отказе отпускаем — отметка уйдёт со
  // следующей попыткой, а не пропадёт навсегда.
  const readClaimsRef = useRef(createReceiptClaims());
  const sendReadReceiptsFor = useCallback((ids: readonly string[]): void => {
    if (!peerB64) return;
    const svc = getMessagingService();
    if (!svc) return;
    const fresh = readClaimsRef.current.claim(ids);
    if (fresh.length === 0) return;
    void svc.sendReadReceipt(peerB64, fresh).catch((e: unknown) => {
      readClaimsRef.current.release(fresh);
      log.warn('chat_read_receipt_failed', { n: fresh.length, err: rawErrorText(e) });
    });
  }, [peerB64]);

  // Auto-poll for updates + mark read + send read receipts
  // v4.32.16: gate tabRef.current внутри interval-колбэка; effect не пересоздаётся на setTab.
  useEffect(() => {
    if (!peerB64) return;
    if (tabRef.current === 'chat') {
      void markConversationRead(peerB64, activeProfileId);
      // Send read receipts for unread incoming messages (best-effort, fire-and-forget)
      void (async () => {
        try {
          const msgs = await import('../../core/storage/local').then((m) =>
            m.listChatMessages({ contactPubB64: peerB64, limit: 100, offset: 0, ownerProfileId: activeProfileId })
          );
          // v4.32.536: здесь стоял отбор `status !== 'read'`. У ВХОДЯЩЕЙ строки
          // это состояние не меняется никогда — «прочитано» ставится нашим
          // исходящим по отметке собеседника, — поэтому отбор не отсеивал
          // ничего, и конверт на сто идентификаторов уходил заново при каждом
          // пересоздании эффекта. Кто уже получил отметку, помнит счётчик.
          sendReadReceiptsFor(msgs.filter((m) => m.direction === 'in').map((m) => m.id));
        } catch (e) {
          log.warn('chat_read_receipt_scan_failed', { err: rawErrorText(e) });
        }
      })();
    }
    // v4.32.124 (AUDIT P1 Block 8): also gate on AppState — when the app is
    // backgrounded, Android still fires setInterval (JS task stays alive
    // briefly), wasting SQLite reads + decryption for no visible effect. On
    // resume, appendNewMessages will catch up via the focus-triggered effect.
    // v4.32.227 (PERF): 5s→15s. Live messages already arrive via WS/WebRTC push
    // (every send handler calls appendNewMessages directly); this interval is only
    // a safety net for missed pushes. At 5s it was the top JS-thread starver while
    // a chat was open — an SQLite read + decrypt of POLL_BATCH rows every 5s,
    // feeding the ui_kv_get_slow lock contention. 15s keeps the safety net without
    // the per-frame theft.
    const id = setInterval(() => {
      if (tabRef.current !== 'chat') return;
      if (AppState.currentState !== 'active') return;
      void appendNewMessages();
    }, 15000);
    return () => clearInterval(id);
  }, [peerB64, appendNewMessages, activeProfileId, tabRef, sendReadReceiptsFor]);

  // v4.32.235: закрепление собеседника не создаёт строки в chat_messages,
  // поэтому appendNewMessages о нём не узнает — баннер обновляем по сигналу
  // хранилища (handleIncomingDmPin будит подписчиков явно).
  // v4.32.237: тем же сигналом обновляется таймер исчезающих сообщений —
  // собеседник может изменить его в любой момент, а он живёт в строке
  // разговора, куда лента сообщений не заглядывает.
  useEffect(() => {
    if (!peerB64) return;
    return subscribeChatWrites(() => {
      if (tabRef.current !== 'chat') return;
      void (async () => {
        const list = await resolveDmPinned(peerB64, activeProfileId);
        setPinnedMsgList(list);
        if (!list.length) setPinnedMsg(null);
        const convs = await listConversations(activeProfileId);
        setDisappearMs(convs.find((c) => c.contactPubB64 === peerB64)?.disappearAfterMs ?? null);
      })();
    });
  }, [peerB64, activeProfileId, tabRef]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingMoreRef.current || sending || !peerB64) return;
    const svc = getMessagingService();
    if (!svc) return;
    // Первая страница ещё не легла — курсора нет, и брать «то, что старше
    // ничего» нельзя: это вернуло бы ту же самую первую страницу.
    const cursor = olderCursorRef.current;
    if (!cursor) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await svc.getOlderMessages(peerB64, PAGE, cursor);
      if (!isMountedRef.current) return;
      // Курсор двигается только вперёд и только своей страницей: пока шёл
      // запрос, переписку могли перезагрузить, и чужой курсор затирать нельзя.
      if (olderCursorRef.current === cursor) {
        olderCursorRef.current = page.cursor ?? cursor;
        setLines((prev) => mergeOlderPage(prev, page.messages));
        setHasMore(page.hasMore);
      }
    } catch (e) {
      log.warn('chat_load_older_failed', { err: rawErrorText(e) });
      if (isMountedRef.current) showError(userErrorText(e, 'Не удалось загрузить старые сообщения'));
    } finally {
      loadingMoreRef.current = false;
      if (isMountedRef.current) setLoadingMore(false);
    }
  }, [hasMore, sending, peerB64]);

  /** Единственная точка записи черновика переписки (v4.32.583). */
  const writeDraft = useCallback((next: string | null) => {
    if (!decideDraftWrite(next, draftUnreadableRef.current).write) return;
    draftUnreadableRef.current = unreadableAfterWrite(next, draftUnreadableRef.current);
    void setConversationDraft(peerB64, activeProfileId, next);
  }, [peerB64, activeProfileId]);

  // Save draft with debounce
  const saveDraft = useCallback((text: string) => {
    if (draftSaveRef.current) clearTimeout(draftSaveRef.current);
    // v4.32.322: то, что ждёт записи, лежит в ref — иначе дописать черновик
    // досрочно (flushDraft) неоткуда: нужный текст остался бы только внутри
    // замыкания уже отменённого таймера.
    pendingDraftRef.current = text;
    draftSaveRef.current = setTimeout(() => {
      draftSaveRef.current = null;
      const pending = pendingDraftRef.current ?? '';
      pendingDraftRef.current = null;
      writeDraft(pending.trim() || null);
    }, 800);
  }, [writeDraft]);

  /**
   * Дописать черновик немедленно, не дожидаясь секунды тишины (v4.32.322).
   *
   * Нужно там, где экран может не дожить до срабатывания таймера: уход из
   * переписки и запуск системного picker'а (галерея, камера, документ) — под
   * ними активити уходит в фон и на Android её вправе убить. До сих пор в
   * обоих случаях таймер просто отменялся: набранный текст исчезал, если между
   * последней буквой и уходом прошло меньше 800 мс.
   */
  const flushDraft = useCallback(() => {
    if (!draftSaveRef.current) return;
    clearTimeout(draftSaveRef.current);
    draftSaveRef.current = null;
    const pending = pendingDraftRef.current ?? '';
    pendingDraftRef.current = null;
    writeDraft(pending.trim() || null);
  }, [writeDraft]);

  // Уход из переписки (и смена собеседника) дописывает черновик, а не отменяет
  // его. Замыкание берётся прошлое — записать надо туда, откуда уходим.
  useEffect(() => {
    return () => { flushDraft(); };
  }, [flushDraft]);

  // Clear draft when message sent
  const clearDraft = useCallback(() => {
    if (draftSaveRef.current) { clearTimeout(draftSaveRef.current); draftSaveRef.current = null; }
    // Отложенный текст тоже снимается: иначе flushDraft воскресил бы уже
    // отправленное сообщение обратно в поле ввода.
    pendingDraftRef.current = null;
    writeDraft(null);
  }, [writeDraft]);

  const pickImage = useCallback(async () => {
    // v4.32.322: предел считается один раз и честно. Прежнее
    // `Math.max(1, 10 - выбрано)` при десяти уже выбранных просило у picker'а
    // ещё одну — её принимали, а потом молча срезали при склейке.
    const remainingSlots = remainingImageSlots(pendingImageUris.length);
    if (remainingSlots === 0) {
      showError(`Можно приложить не больше ${CHAT_MAX_IMAGES} фото`);
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { showPermissionDeniedAlert('Фото', 'Для отправки медиа нужен доступ к галерее.'); return; }
    // v4.32.54: quality: 1 — см. FeedScreen.pickImages. При quality<1 expo-image-picker
    // 16.1.4 зовёт `AppContext.imageLoader` которого нет в expo-modules-core 55.0.17 →
    // NoSuchMethodError. Пропускаем CompressionImageExporter, сжимаем потом через
    // expo-image-manipulator (см. ниже).
    // v4.32.57: Telegram-style — до 10 фото за раз, учёт уже выбранных (remainingSlots).
    // Набранный текст дописывается в черновик до запуска галереи: пока она
    // открыта, нашу активити на Android вправе убить.
    flushDraft();
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 1,
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      videoMaxDuration: 120,
      exif: false,
    });
    if (res.canceled || res.assets.length === 0) return;
    // If all selected are videos, send them as documents
    const videoAssets = res.assets.filter((a) => a.type === 'video');
    if (videoAssets.length > 0 && peerB64) {
      // v4.32.48: video size guard. expo-image-picker не сжимает видео → если пропустить,
      // base64 raw bytes могут забить память (OOM) и транспорт (envelope лимит 2MB в feedTransport,
      // DM без жёсткого лимита но практически 5MB уже ломает LAN/WebRTC). Лимит 25MB = защита.
      // v4.32.245: без IPFS видео уходит зашифрованным вложением, а его предел
      // 8 МБ. Раньше отправка видео была просто заблокирована алертом, хотя
      // фото и файлы этим путём ходят с v4.32.226.
      // v4.32.358: предел один на всё приложение — uploadRoute. Здесь он был
      // записан своим числом, а размер брался из галереи, которая сообщает его
      // не всегда: ролик без заявленного размера проходил проверку целиком.
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
      const svc = getMessagingService();
      if (!svc) return;
      setSending(true);
      try {
        const { uploadMediaToCid } = await import('../../core/media/mediaUpload');
        const peerDid = didFromPubB64(peerB64);
        if (!peerDid) { showError('У контакта испорчен ключ'); return; }
        let sentAny = false;
        let skippedTooLarge = 0;
        for (const va of videoAssets) {
          const name = va.fileName ?? va.uri.split('/').pop() ?? 'video.mp4';
          const up = await uploadMediaToCid(va.uri, {
            mime: va.mimeType ?? 'video/mp4',
            targetDid: peerDid,
            ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES,
          });
          if (!up.ok) {
            if (up.reason === 'oversize') skippedTooLarge++;
            continue;
          }
          const docText = makeDocText(name.includes('.') ? name : `${name}.mp4`, up.sizeBytes ?? va.fileSize ?? 0, up.cid);
          await svc.sendMessage(peerB64, docText);
          sentAny = true;
        }
        if (skippedTooLarge > 0) showError(`Видео больше ${formatLimit(videoMaxBytes)} отправить нельзя (пропущено: ${skippedTooLarge})`);
        else if (!sentAny) showError('Не удалось загрузить видео');
        void appendNewMessages();
      } catch (e) {
        showError(userErrorText(e, 'Не удалось отправить видео'));
      } finally {
        setSending(false);
      }
      return;
    }
    // v4.32.226: image sending works WITHOUT IPFS now — uploadMediaFromUri
    // falls back to the E2E-encrypted ntfy attachment store (≤8MB/file), same
    // path as voice messages. The old v4.32.51 hard gate is gone.
    const imageAssets = res.assets.filter((a) => a.type !== 'video');
    // v4.32.57: Show caption preview before sending images — накапливаем с уже
    // выбранными, truncate до лимита 10 (если picker проигнорировал selectionLimit).
    setImageCaption(msg.trim());
    // v4.32.322: повторно отмеченная фотография больше не уходит собеседнику
    // дважды, а лишние сверх предела не пропадают молча.
    const merged = mergePickedImages(pendingImageUris, imageAssets.map((a) => a.uri));
    setPendingImageUris(merged.next);
    if (merged.overLimit > 0) showError(`Приложено не всё: предел — ${CHAT_MAX_IMAGES} фото`);
  }, [msg, peerB64, pendingImageUris, flushDraft, appendNewMessages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Защита от двойного нажатия
  const { onPress: handlePickImage } = useAsyncButton(pickImage, { throttleMs: 500 });

  // v4.32.60: хендлеры для AttachSheet (факторизация Alert-опций)
  const handleCameraCapture = useCallback(async () => {
    // v4.32.322: снимок добавляется к уже выбранному, а не затирает его —
    // раньше «выбрать три фото, доснять четвёртое» оставляло одну четвёртую.
    if (remainingImageSlots(pendingImageUris.length) === 0) {
      showError(`Можно приложить не больше ${CHAT_MAX_IMAGES} фото`);
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { showPermissionDeniedAlert('Камера', 'Для съёмки фото или видео нужен доступ к камере.'); return; }
    flushDraft();
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, allowsEditing: false, quality: 1, exif: false });
    if (res.canceled || !res.assets[0]) return;
    const { uri } = res.assets[0];
    // Подпись берётся из поля ввода — так же, как для фото из галереи. Без
    // этого набранный текст в предпросмотр не попадал и уходил отдельным
    // сообщением следом за снимком.
    setImageCaption(msg.trim());
    setPendingImageUris(mergePickedImages(pendingImageUris, [uri]).next);
  }, [msg, pendingImageUris, flushDraft]);

  // v4.32.543: здесь не было ни одного catch. Выключенная в телефоне
  // геолокация роняет getCurrentPositionAsync, отказ уходил необработанным
  // отклонением промиса — и нажатие на «моё местоположение» не давало ровно
  // ничего: ни точки на карте, ни ошибки. Отдельно от этого молчала и сама
  // отправка: try/finally без catch гасил любой отказ доставки, человек видел
  // только то, как разблокировалось поле ввода.
  const handleSendLocationOnce = useCallback(async () => {
    if (!peerB64) return;
    const svc = getMessagingService();
    if (!svc) { showError('Сервис не готов.'); return; }
    const read = await readPlaceOnce();
    if (!isMountedRef.current) return;
    if (!read.ok) {
      if (read.kind === 'denied') {
        showPermissionDeniedAlert('Геолокация', 'Чтобы отправить своё местоположение, разрешите доступ к геолокации.');
        return;
      }
      log.warn('chat_location_read_failed', { kind: read.kind });
      showError(locationFailureText(read.kind));
      return;
    }
    const label = await reverseGeocodeLabel(read.coords.lat, read.coords.lon);
    if (!isMountedRef.current) return;
    const locText = makeLocationText(read.coords.lat, read.coords.lon, label);
    setSending(true);
    try {
      await svc.sendMessage(peerB64, locText);
    } catch (e) {
      log.error('chat_send_location_failed', { err: rawErrorText(e) });
      if (isMountedRef.current) showError(userErrorText(e, 'Не удалось отправить местоположение'));
    } finally {
      if (isMountedRef.current) { setSending(false); void appendNewMessages(); }
    }
  }, [peerB64, appendNewMessages]);

  const handleShareLiveLocation = useCallback(async (durationMinutes: 15 | 60 | 480) => {
    if (!peerB64) return;
    if (activeLiveLocId) {
      stopLiveLocSession(activeLiveLocId);
      setActiveLiveLocId(null);
      return;
    }
    // v4.32.543: место спрашивают ДО того, как пообещать человеку восемь часов
    // трансляции. Раньше хватало выданного разрешения: при выключенной в
    // телефоне геолокации сессия исправно заводилась, полоса «остановить»
    // появлялась — и не уходило ни одной посылки, о чём узнать было неоткуда.
    const read = await readPlaceOnce();
    if (!isMountedRef.current) return;
    if (!read.ok) {
      if (read.kind === 'denied') {
        showPermissionDeniedAlert('Геолокация', 'Чтобы отправить своё местоположение, разрешите доступ к геолокации.');
        return;
      }
      log.warn('chat_live_location_read_failed', { kind: read.kind });
      showError(locationFailureText(read.kind));
      return;
    }
    const svc = getMessagingService();
    if (!svc) return;
    const liveId = await startLiveLocSession({
      peerPubB64: peerB64,
      durationMinutes,
      onUpdate: async (payload) => {
        // v4.32.524: номер сессии берётся из самой посылки. Раньше он ждал
        // возврата startLiveLocSession, а первая отправка идёт до возврата —
        // на первом такте номер был ещё null, и всё тело обработчика
        // пропускалось: пузырь не появлялся, а собеседник узнавал о том, что
        // с ним поделились геолокацией, только через полминуты.
        const txt = makeLiveLocText(payload);
        await upsertChatMessage({ id: payload.liveId, contactPubB64: peerB64, cid: `live:${payload.liveId}`, text: txt, direction: 'out', status: 'delivered', mediaCids: null, createdAt: payload.expireAt - durationMinutes * 60_000, ownerProfileId: activeProfileId, replyToId: null, replyToPreview: null });
        await svc.sendMessage(peerB64, txt);
        void appendNewMessages();
      },
      onExpire: () => setActiveLiveLocId(null),
    });
    setActiveLiveLocId(liveId);
    void appendNewMessages();
  }, [peerB64, activeLiveLocId, activeProfileId, appendNewMessages]);

  // v4.32.524: сессия живой геолокации переживает закрытие переписки, а полоса
  // «остановить» — нет. ChatThreadView пересоздаётся на каждого собеседника,
  // activeLiveLocId сбрасывается в null, и человек остаётся без единственной
  // кнопки остановки: координаты продолжают уходить каждые полминуты до восьми
  // часов, и заметить это уже неоткуда. Реестр сессий размонтирование
  // переживает — спрашиваем его при входе. Свой таймер нужен потому, что
  // onExpire замкнут на прошлое монтирование и полосу нынешнего экрана убрать
  // не может.
  useEffect(() => {
    const banner = liveLocBannerFor(getActiveLiveLoc(peerB64), Date.now());
    setActiveLiveLocId(banner ? banner.liveId : null);
    if (!banner) return;
    const t = setTimeout(() => {
      if (isMountedRef.current) setActiveLiveLocId(null);
    }, banner.clearAfterMs);
    return () => clearTimeout(t);
  }, [peerB64]);

  const handleShareContact = useCallback(async (c: { peerPublicKey: string; displayName: string }) => {
    if (!peerB64) return;
    const cardText = makeContactCardText(c.displayName ?? '', c.peerPublicKey);
    const svc = getMessagingService();
    if (!svc) return;
    setSending(true);
    // v4.32.543: catch здесь не было. Отказ доставки карточки контакта гасился
    // молча — собеседник не получал ничего, а отправитель видел обычный
    // разблокированный ввод и был уверен, что карточка ушла.
    try {
      await svc.sendMessage(peerB64, cardText);
    } catch (e) {
      log.error('chat_share_contact_failed', { err: rawErrorText(e) });
      if (isMountedRef.current) showError(userErrorText(e, 'Не удалось отправить карточку контакта'));
    } finally {
      if (isMountedRef.current) { setSending(false); void appendNewMessages(); }
    }
  }, [peerB64, appendNewMessages]);

  const handlePickQuickReply = useCallback((text: string) => {
    setMsg((prev) => (prev ? prev + ' ' + text : text));
    setTimeout(() => msgInputRef.current?.focus(), 50);
  }, []);

  const closeQuickReplies = useCallback(() => setQuickRepliesVisible(false), []);
  const pickQuickReplyFromModal = useCallback((text: string) => {
    setMsg((prev) => prev + (prev ? ' ' : '') + text);
  }, []);

  const closePinnedList = useCallback(() => setPinnedListVisible(false), []);
  const closeScheduledList = useCallback(() => setScheduledListVisible(false), []);
  const deleteScheduledFromModal = useCallback((id: string) => {
    runGuardedOp(async () => {
      await deleteScheduledMessage(id);
      await reloadScheduled();
    }, 'Не удалось удалить отложенное сообщение', 'ui_chat_delete_scheduled_failed');
  }, [reloadScheduled]);
  const closeStarred = useCallback(() => setStarredVisible(false), []);
  const unstarFromModal = useCallback((id: string) => {
    runGuardedOp(async () => {
      await setMessageStarred(id, false);
      setStarredEntries((prev) => prev.filter((e) => (e.message as ChatMessageRow).id !== id));
      void appendNewMessages();
    }, 'Не удалось убрать из избранного', 'ui_chat_unstar_failed');
  }, [appendNewMessages]);
  const closeRecentlyDeleted = useCallback(() => setRecentlyDeletedVisible(false), []);
  const restoreRecentlyDeleted = useCallback((text: string) => {
    setMsg(text);
    setRecentlyDeletedVisible(false);
    showSuccess('Текст восстановлен в поле ввода');
  }, []);
  const closeReactionsMore = useCallback(() => {
    setReactionsMoreVisible(false);
    setReactionsTarget(null);
  }, []);
  const unpinFromList = useCallback((id: string) => {
    void (async () => {
      const res = await toggleDmPinAndSync({ peerPubB64: peerB64, msgId: id, on: false });
      announceDmPin(res.sync);
      const newList = res.entries;
      setPinnedMsgList(newList);
      if (newList.length === 0) {
        setPinnedMsg(null);
        setPinnedListVisible(false);
      } else {
        setPinnedMsgIdx(0);
      }
    })();
  }, [peerB64]);

  // Из AttachSheet grid «Галерея» прилетает список ассетов с type — роутим так же, как pickImage:
  // видео → IPFS upload + doc message; фото → setPendingImageUris (превью-модалка).
  const handleAcceptGalleryAssets = useCallback(async (assets: Array<{ uri: string; type: 'image' | 'video' }>) => {
    if (!peerB64) return;
    const videoAssets = assets.filter((a) => a.type === 'video');
    const imageAssets = assets.filter((a) => a.type !== 'video');
    if (videoAssets.length > 0) {
      const svc = getMessagingService();
      if (!svc) return;
      // v4.32.245: та же заглушка стояла и здесь, во втором входе в галерею.
      setSending(true);
      let tooLargeCount = 0;
      try {
        // v4.32.358: здесь размер проверялся дважды и оба раза по уже
        // прочитанному в память файлу — то есть от переполнения не спасало ни
        // одно из двух чисел. Теперь размер спрашивается до чтения.
        const { uploadMediaToCid } = await import('../../core/media/mediaUpload');
        const { formatLimit, IPFS_VIDEO_MAX_BYTES } = await import('../../core/media/uploadRoute');
        const peerDid = publicKeyToDidKey(new Uint8Array(Buffer.from(peerB64, 'base64')));
        let sentAny = false;
        let limitBytes = MAX_BLOB_BYTES;
        for (const va of videoAssets) {
          try {
            const up = await uploadMediaToCid(va.uri, {
              mime: 'video/mp4',
              targetDid: peerDid,
              ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES,
            });
            if (!up.ok) {
              if (up.reason === 'oversize') { tooLargeCount++; limitBytes = up.limitBytes; }
              continue;
            }
            const name = va.uri.split('/').pop() ?? 'video.mp4';
            const docText = makeDocText(name.includes('.') ? name : `${name}.mp4`, up.sizeBytes ?? 0, up.cid);
            await svc.sendMessage(peerB64, docText);
            sentAny = true;
          } catch (e) { log.warn('attachsheet_video_send_failed', { err: rawErrorText(e) }); }
        }
        if (tooLargeCount > 0) showError(`Видео больше ${formatLimit(limitBytes)} отправить нельзя (пропущено: ${tooLargeCount})`);
        else if (!sentAny) showError('Не удалось загрузить видео');
        void appendNewMessages();
      } finally { setSending(false); }
    }
    if (imageAssets.length > 0) {
      // v4.32.226: photos work without IPFS via the encrypted ntfy-blob path.
      setImageCaption(msg.trim());
      // v4.32.322: тот же отбор, что и в pickImage — повторы и предел здесь
      // считались отдельной строкой и без учёта повторов.
      const merged = mergePickedImages(pendingImageUris, imageAssets.map((a) => a.uri));
      setPendingImageUris(merged.next);
      if (merged.overLimit > 0) showError(`Приложено не всё: предел — ${CHAT_MAX_IMAGES} фото`);
    }
  }, [peerB64, msg, pendingImageUris, appendNewMessages]);

  const pickDocument = useCallback(async () => {
    if (!peerB64) return;
    if (isBlocked) { showError('Контакт заблокирован'); return; }
    flushDraft();
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    // v4.32.226: files ride the E2E-encrypted ntfy attachment store (same as
    // voice/photos) — IPFS is not required anymore.
    // v4.32.358: предел брался отсюда числом и не знал про IPFS-сборки, где он
    // выше; текст ошибки тоже был записан вручную.
    const { isIpfsEnabled } = await import('../../core/transport/ipfs/heliaNode');
    const { uploadLimitBytes, formatLimit, IPFS_DOC_MAX_BYTES } = await import('../../core/media/uploadRoute');
    const docMaxBytes = uploadLimitBytes({ ipfsEnabled: isIpfsEnabled(), ipfsMaxBytes: IPFS_DOC_MAX_BYTES });
    if ((asset.size ?? 0) > docMaxBytes) {
      Alert.alert('Файл слишком большой', `Максимальный размер файла — ${formatLimit(docMaxBytes)}.`);
      return;
    }
    const svc = getMessagingService();
    if (!svc) return;
    setSending(true);
    try {
      const { uploadMediaToCid } = await import('../../core/media/mediaUpload');
      const peerDid = didFromPubB64(peerB64);
      if (!peerDid) { showError('У контакта испорчен ключ'); return; }
      const up = await uploadMediaToCid(asset.uri, {
        mime: asset.mimeType,
        targetDid: peerDid,
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
      const docText = makeDocText(asset.name ?? 'document', asset.size ?? up.sizeBytes ?? 0, up.cid);
      await svc.sendMessage(peerB64, docText);
      void appendNewMessages();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось отправить документ'));
    } finally {
      setSending(false);
    }
  }, [peerB64, isBlocked, flushDraft, appendNewMessages]);

  const sendWithMedia = async (uris: string[], captionOverride?: string) => {
    if (!peerB64 || sending) return;
    if (isBlocked) { showError('Контакт заблокирован'); return; }
    const text = captionOverride !== undefined ? (captionOverride.trim() || ' ') : (msg.trim() || ' ');
    const optimistic: ChatMessageRow = {
      id: `ui-opt-${Date.now()}`,
      contactPubB64: peerB64,
      cid: null,
      text,
      direction: 'out',
      status: 'sending',
      mediaCids: null,
      createdAt: Date.now(),
      ownerProfileId: activeProfileId,
    };
    setMsg('');
    setOptimisticOutgoing(optimistic);
    setSending(true);
    requestAnimationFrame(() => {
      void (async () => {
        try {
          const svc = getMessagingService();
          if (!svc) { setMsg(text); setOptimisticOutgoing(null); showError('Сервис не готов. Подождите.'); return; }
          await measurePerformance('chat_send_media', () => svc.sendMessage(peerB64, text, uris));
          void appendNewMessages();
        } catch (e) {
          setMsg(text);
          setOptimisticOutgoing(null);
          // v4.32.569: отказ отправки был виден только в журнале. Подпись
          // возвращалась в поле ввода, пузырь исчезал — и ни слова о том,
          // почему. Теперь причина видна (например, «Файл слишком большой»).
          showError(userErrorText(e, 'Не удалось отправить сообщение'));
          log.error('chat_send_failed', { err: rawErrorText(e) });
        } finally {
          setSending(false);
        }
      })();
    });
  };

  const sendVoice = useCallback(
    async (result: VoiceRecordingResult) => {
      if (!peerB64 || sending) return;
      if (isBlocked) { showError('Контакт заблокирован'); return; }
      setSending(true);
      clearDraft();
      try {
        if (isSavedMessages) {
          const ts = Date.now();
          // Saved Messages live only on this device — the local uri is enough.
          const voiceText = makeVoiceText(result.uri, result.durationMs);
          await upsertChatMessage({
            id: uuidv4(),
            contactPubB64: peerB64,
            cid: `local:${ts}`,
            text: voiceText,
            direction: 'out',
            status: 'delivered',
            mediaCids: null,
            createdAt: ts,
            ownerProfileId: activeProfileId,
            replyToId: null,
            replyToPreview: null,
          });
          void touchConversation(peerB64, activeProfileId, '🎤 Голосовое сообщение', 'out', false);
          void appendNewMessages();
        } else {
          const svc = getMessagingService();
          if (!svc) throw new Error('Сервис не готов. Подождите и повторите.');
          // v4.32.226: upload the recording as an E2E-encrypted ntfy attachment so
          // the recipient can fetch the bytes — IPFS is unavailable on mobile and
          // the 3KB text channel can't carry audio. The sender keeps the local uri
          // for instant own-playback; the blob descriptor (url + random key) rides
          // inside the already-E2E-encrypted DM envelope for the recipient.
          // v4.32.562: файл больше вложения не отправится ни с какой попытки,
          // а прежний общий текст звал повторить — то есть объяснял отказом
          // сети то, к чему сеть отношения не имела.
          const tooBig = voiceUploadRefusal(await fileSizeBytes(result.uri), MAX_BLOB_BYTES);
          if (tooBig) throw new Error(tooBig);
          const peerDid = publicKeyToDidKey(new Uint8Array(Buffer.from(peerB64, 'base64')));
          const blob = await uploadEncryptedBlob(result.uri, 'audio/m4a', peerDid);
          if (!blob) throw new Error('Голосовое не загрузилось. Проверьте соединение и повторите.');
          const voiceText = makeVoiceText(result.uri, result.durationMs, blob);
          await svc.sendMessage(peerB64, voiceText);
          void appendNewMessages();
        }
      } catch (e) {
        await deleteCachedFileUris([result.uri]).catch(() => {});
        log.error('voice_send_failed', { err: rawErrorText(e) });
        showError(userErrorText(e, 'Не удалось отправить голосовое'));
      } finally {
        setSending(false);
      }
    },
    [peerB64, sending, isBlocked, isSavedMessages, activeProfileId, clearDraft, appendNewMessages]
  );

  const sendGif = useCallback(async (gifText: string) => {
    if (!peerB64 || sending) return;
    if (isBlocked) { showError('Контакт заблокирован'); return; }
    setSending(true);
    try {
      if (isSavedMessages) {
        const ts = Date.now();
        await upsertChatMessage({
          id: uuidv4(),
          contactPubB64: peerB64,
          cid: `local:${ts}`,
          text: gifText,
          direction: 'out',
          status: 'delivered',
          mediaCids: null,
          createdAt: ts,
          ownerProfileId: activeProfileId,
          replyToId: null,
          replyToPreview: null,
        });
        void touchConversation(peerB64, activeProfileId, '🎞 GIF', 'out', false);
        void appendNewMessages();
      } else {
        const svc = getMessagingService();
        if (!svc) { showError('Сервис не готов'); return; }
        await svc.sendMessage(peerB64, gifText);
        void appendNewMessages();
      }
    } catch (e) {
      showError(userErrorText(e, 'Не удалось отправить GIF'));
    } finally {
      setSending(false);
    }
  }, [peerB64, sending, isBlocked, isSavedMessages, activeProfileId, appendNewMessages]);

  // ─── Slash command suggestions ───────────────────────────────────────────────
  const CHAT_CMDS = useMemo(() => [
    { cmd: '/dice', desc: 'Бросить кубик' },
    { cmd: '/coin', desc: 'Подбросить монету' },
    { cmd: '/magic', desc: 'Магический шар' },
    { cmd: '/random', desc: 'Случайное число 0–99' },
  ], []);
  const chatCmdSuggestions = useMemo(() => {
    if (chatCmdFilter === null) return [];
    return CHAT_CMDS.filter((c) => c.cmd.slice(1).startsWith(chatCmdFilter) || chatCmdFilter === '');
  }, [chatCmdFilter, CHAT_CMDS]);

  // v4.32.228 (IB-03): после отправки прокручиваем перевёрнутый список к самому
  // новому сообщению (offset 0 = низ), иначе исходящий пузырь не появлялся в
  // зоне видимости, если пользователь был прокручен вверх. RAF — чтобы скролл
  // выполнился после рендера нового (оптимистичного/локального) элемента.
  const scrollToNewest = useCallback(() => {
    requestAnimationFrame(() => {
      flashListRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
  }, []);

  const send = useCallback(() => {
    if (editTarget) {
      const newText = msgRef.current.trim();
      if (!newText || sending) return;
      const target = editTarget;
      setMsg('');
      msgRef.current = '';
      setEditTarget(null);
      setSending(true);
      clearDraft();
      void (async () => {
        try {
          const svc = getMessagingService();
          if (!svc) { showError('Сервис не готов'); return; }
          const echo = await svc.editMessage(peerB64, target.id, newText);
          void appendNewMessages();
          reportTwoSided(echo, 'edit');
        } catch (e) {
          log.error('chat_edit_failed', { err: rawErrorText(e) });
        } finally {
          setSending(false);
        }
      })();
      return;
    }

    const currentMsg = msgRef.current;
    if (!peerB64 || !currentMsg.trim() || sending) return;
    // v4.32.170: блокировка — не даём отправлять, иначе UX «Заблокировано» был ложью.
    if (isBlocked) { showError('Контакт заблокирован'); return; }
    let text = currentMsg.trim();

    // ─── Fun slash commands ─────────────────────────────────────────────────
    if (text === '/dice' || text === '/кость') {
      const result = Math.floor(Math.random() * 6) + 1;
      const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
      text = `🎲 Кубик: ${faces[result - 1]} (${result})`;
    } else if (text === '/coin' || text === '/монета') {
      text = `🪙 Монета: ${Math.random() < 0.5 ? 'Орёл' : 'Решка'}`;
    } else if (text === '/magic' || text === '/шар') {
      const answers = ['Несомненно', 'Это точно', 'Без сомнений', 'Да', 'Скорее да', 'Не предсказуемо', 'Не уверен', 'Сомнительно', 'Нет', 'Определённо нет'];
      text = `🔮 Магический шар: ${answers[Math.floor(Math.random() * answers.length)]}`;
    } else if (text === '/random' || text === '/рандом') {
      text = `🎰 Случайное число: ${Math.floor(Math.random() * 100)}`;
    }
    // ───────────────────────────────────────────────────────────────────────

    setChatCmdFilter(null);
    const replyRef = replyTo;

    // Self-chat (Saved Messages) — store locally, no network delivery
    if (isSavedMessages) {
      const ts = Date.now();
      const row: ChatMessageRow = {
        id: uuidv4(),
        contactPubB64: peerB64,
        cid: `local:${ts}`,
        text,
        direction: 'out',
        status: 'delivered',
        mediaCids: null,
        createdAt: ts,
        ownerProfileId: activeProfileId,
        replyToId: replyRef?.id ?? null,
        replyToPreview: truncateReplyPreview(replyRef?.text),
      };
      setMsg('');
      msgRef.current = '';
      setReplyTo(null);
      clearDraft();
      Vibration.vibrate(30);
      scrollToNewest();
      void (async () => {
        await upsertChatMessage(row);
        void touchConversation(peerB64, activeProfileId, previewLabelForText(text).slice(0, 120), 'out', false);
        void appendNewMessages();
      })();
      return;
    }

    const optimistic: ChatMessageRow = {
      id: `ui-opt-${Date.now()}`,
      contactPubB64: peerB64,
      cid: null,
      text,
      direction: 'out',
      status: 'sending',
      mediaCids: null,
      createdAt: Date.now(),
      ownerProfileId: activeProfileId,
    };
    const effectPs = detectSendEffect(text);
    if (effectPs) setSendEffectParticles(effectPs);
    setMsg('');
    msgRef.current = '';
    setReplyTo(null);
    setOptimisticOutgoing(optimistic);
    setSending(true);
    clearDraft();
    Vibration.vibrate(30);
    scrollToNewest();
    requestAnimationFrame(() => {
      void (async () => {
        try {
          const svc = getMessagingService();
          if (!svc) { setMsg(text); setOptimisticOutgoing(null); showError('Сервис не готов.'); return; }
          await measurePerformance('chat_send_text', () =>
            svc.sendMessage(peerB64, text, undefined, replyRef?.id, truncateReplyPreview(replyRef?.text) ?? undefined)
          );
          void appendNewMessages();
        } catch (e) {
          const errMsg = rawErrorText(e);
          setMsg(text);
          setOptimisticOutgoing(null);
          log.error('chat_send_failed', { err: errMsg });
          showError(errMsg);
        } finally {
          setSending(false);
        }
      })();
    });
  }, [peerB64, sending, isBlocked, isSavedMessages, replyTo, appendNewMessages, editTarget, activeProfileId, clearDraft, scrollToNewest]);

  // v4.32.428: раньше здесь не было catch, а вызов уходил как
  // `void doSchedule(sendAt)`. scheduleMessage бросает на выбранном времени
  // (`send_at_out_of_range` — дальше года вперёд или больше минуты назад) и на
  // длине текста (`invalid_text_length`). Отказ становился необработанным
  // отклонением промиса: окно закрывалось, черновик оставался, сообщение не
  // планировалось — и человек не видел ни ошибки, ни подтверждения. Молчание
  // здесь хуже английского текста: непонятно даже, что что-то пошло не так.
  const doSchedule = useCallback(async (sendAt: number) => {
    const text = msg.trim();
    if (!text || !peerB64) return;
    try {
      await scheduleMessage(peerB64, text, sendAt);
    } catch (e) {
      log.warn('schedule_dm_failed', { err: rawErrorText(e) });
      showError(userErrorText(e, 'Не удалось запланировать отправку'));
      return;
    }
    setMsg('');
    clearDraft();
    showSuccess(`Запланировано на ${fullDateTime(sendAt)}`);
  }, [msg, peerB64, clearDraft]);

  const retryFailedMessage = useCallback((row: ChatMessageRow) => {
    if (!peerB64 || row.status !== 'failed') return;
    // v4.32.175: не ретраим в заблокированный контакт; ретрай с медиа сохраняет
    // медиа (раньше только text уходил — фото/войс/док становились text-only).
    if (isBlocked) {
      showError('Контакт заблокирован');
      return;
    }
    const svc = getMessagingService();
    if (!svc) return;
    setSending(true);
    void (async () => {
      try {
        // v4.32.357: в mediaCids лежат ССЫЛКИ на уже загруженные вложения
        // (`nb:`-дескриптор или IPFS-CID), а sendMessage ждёт локальные пути
        // файлов и пытается их прочитать и загрузить заново. Прочитать
        // «nb:{…}» как файл нельзя, загрузка молча отдавала null — и повтор
        // отправлял собеседнику голый текст, после чего deleteMessageLocally
        // стирал исходную строку вместе с единственной ссылкой на вложение.
        // Ровно это v4.32.182 и обещала не допускать, но закрыла только случай
        // испорченного JSON.
        //
        // Повторная отправка уже есть — retrySendDm, ею пользуется очередь:
        // она переиспользует готовые ссылки, сохраняет id и время сообщения и
        // сама переписывает строку в «доставлено». Удалять ничего не нужно.
        const mediaCids = parseMediaCidsColumn(row.mediaCids);
        if (mediaCids.length > 0) {
          const ok = await svc.retrySendDm({
            contactPubB64: peerB64,
            text: row.text ?? '',
            mediaCids,
            messageId: row.id,
            ts: row.createdAt,
            replyToId: row.replyToId ?? undefined,
            replyToPreview: outwardQuote(row.replyToPreview, row.replyToPreviewUnreadable),
          });
          if (!ok) {
            showError('Не удалось отправить, вложение сохранено');
            return;
          }
        } else {
          await svc.sendMessage(peerB64, row.text ?? '', undefined, row.replyToId ?? undefined, outwardQuote(row.replyToPreview, row.replyToPreviewUnreadable));
          await svc.deleteMessageLocally(row.id);
        }
        void appendNewMessages();
      } catch (e) {
        showError(userErrorText(e, 'Не удалось отправить сообщение'));
      } finally {
        setSending(false);
      }
    })();
  }, [peerB64, appendNewMessages, isBlocked]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await getMessagingService()?.syncHistoryFromPeer(peerB64, 100);
      await reloadThread();
    } catch (e) {
      // v4.32.545: потянули список вниз, история не пришла — и об этом не
      // говорили ни строчкой. Спиннер уезжал, сообщений не прибавлялось, и
      // выглядело это как «у собеседника ничего нет».
      log.error('ui_chat_refresh_failed', { err: rawErrorText(e) });
      if (isMountedRef.current) showError(userErrorText(e, 'Не удалось обновить историю'));
    } finally {
      setRefreshing(false);
    }
  }, [reloadThread, peerB64]);

  useEffect(() => {
    // v4.32.16: gate через tabRef — effect триггерится только при peerB64/lines, но не setTab.
    if (tabRef.current !== 'chat' || !peerB64) return;
    // v4.32.536: один конверт на всю пачку. Раньше уходил конверт НА КАЖДОЕ
    // сообщение: открыть переписку с сорока непрочитанными значило отправить
    // сорок шифрованных конвертов подряд.
    sendReadReceiptsFor(lines.filter((m) => m.direction === 'in').map((m) => m.id));
  }, [peerB64, lines, tabRef, sendReadReceiptsFor]);

  const onViewableChanged = useCallback(
    (info: { viewableItems: Array<{ item?: ChatListItem | null }> }) => {
      const ids: string[] = [];
      for (const v of info.viewableItems) {
        const item = v.item;
        if (!item || (item as DateSeparatorItem).type === 'date_sep') continue;
        const m = item as import('../../core/storage/local').ChatMessageRow;
        if (m.direction === 'in') ids.push(m.id);
      }
      sendReadReceiptsFor(ids);
    },
    [sendReadReceiptsFor]
  );

  const addRecentReaction = useCallback(async (emoji: string) => {
    const raw = await scopedKvGet(RECENT_REACTIONS_KEY);
    let list: string[] = [];
    // v4.32.184 (Round-14 #5): Array.isArray guard.
    try { const p = raw ? JSON.parse(raw) : null; if (Array.isArray(p)) list = p as string[]; } catch { /* */ }
    list = [emoji, ...list.filter((e) => e !== emoji)].slice(0, 8);
    await scopedKvSet(RECENT_REACTIONS_KEY, JSON.stringify(list));
    setRecentReactions(list);
  }, []);

  const applyReaction = useCallback(
    (targetMsg: ChatMessageRow, emoji: string) => {
      // v4.32.232: реакция не уходила собеседнику вообще, а ключом в карте был
      // ЛОКАЛЬНЫЙ profile.id ('1') — одинаковый на всех устройствах, то есть
      // авторов было не различить в принципе. Ключ теперь — публичный ключ,
      // как в группах; отправка — toggleAndSyncReaction.
      // v4.32.447: отказ и неразосланный конверт больше не молчат — раньше
      // отсюда возвращался boolean|null, где null значил сразу четыре разных
      // отказа, а «реакция стоит» не отличалось от «реакция стоит только у вас».
      void toggleAndSyncReaction({ msgId: targetMsg.id, emoji, peerPubB64: peerB64 }).then((res) => {
        if (!res.ok) {
          showError(res.reason);
          return;
        }
        if (res.warning) showError(res.warning);
        if (res.on) void addRecentReaction(emoji);
        void appendNewMessages();
      });
    },
    [appendNewMessages, addRecentReaction, peerB64]
  );

  const handleViewOnceTap = useCallback(
    (row: ChatMessageRow) => {
      // Show full media, then delete after viewing
      if (!row.mediaCids) return;
      // v4.32.248: одноразовое фото на телефоне не открывалось ВООБЩЕ — адрес
      // собирался только для обычного CID, а на телефоне IPFS выключен и
      // фотография ездит зашифрованным вложением (`nb:`). Список адресов
      // получался пустым, поэтому не открывался просмотрщик и не удалялось
      // сообщение: снимок «на один раз» оставался в переписке навсегда.
      //
      // v4.32.243: адрес собирает core/media/gatewayUrl — CID пришёл от
      // собеседника, а '../' в нём уводил просмотрщик на чужой сервер.
      // v4.32.516: порядок — один на оба экрана (runViewOnceTap). Здесь он был
      // написан целиком, в группе скопирован без проверок «экран ещё жив»;
      // теперь копия ровно одна. Заодно ушли два своих изъяна: отказ удаления
      // улетал необработанным отклонением обещания, а уход из чата за 0,8
      // секунды отменял удаление уже ПОКАЗАННОГО снимка — то есть оставлял
      // «одноразовое» фото в переписке навсегда.
      const cids = row.mediaCids;
      void runViewOnceTap({
        resolve: () => resolveMediaCidsToUris(cids, gateway),
        alive: () => isMountedRef.current,
        open: (uris) => openMedia(uris, 0),
        later: (fn) => { setTimeout(fn, VIEW_ONCE_DELETE_DELAY_MS); },
        remove: async () => {
          const svc = getMessagingService();
          if (svc) await svc.deleteMessageLocally(row.id);
        },
        reload: () => { void appendNewMessages(); },
        // Вложение живёт на relay около трёх часов; в группе про это говорили,
        // в личном чате молчали (v4.32.359).
        onUnavailable: () => showError('Снимок больше недоступен'),
        onRemoveFailed: () => showError('Не удалось удалить одноразовый снимок'),
      });
    },
    [gateway, openMedia, appendNewMessages]
  );

  const toggleSelect = useCallback((row: ChatMessageRow) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }, []);

  // Stage C: stable row callbacks so MessageRow's memo (with strict === compare) holds.
  const handleRowSwipeStar = useCallback((row: ChatMessageRow) => {
    runGuardedOp(async () => {
      await setMessageStarred(row.id, !row.starred);
      await appendNewMessages();
    }, 'Не удалось изменить избранное', 'ui_chat_star_failed');
  }, [appendNewMessages]);
  const handleRowDoubleTap = useCallback((row: ChatMessageRow) => {
    applyReaction(row, '❤️');
  }, [applyReaction]);
  const handleRowReactionTap = useCallback((emoji: string, _dids: string[], reactions: string) => {
    setReactionDetail({ activeEmoji: emoji, map: parseReactionMap(reactions) });
  }, []);

  // v4.32.252: пять действий жили внутри showMessageMenu и потому существовали
  // только в iOS-меню (ActionSheetIOS). На Android длинное нажатие открывает
  // ChatQuickReactModal, и «Перевести», «Копировать ссылку», «Закрепить»,
  // «Выбрать» и «Завершить опрос» были недоступны в принципе. Вынесены наружу,
  // чтобы оба меню звали одну и ту же реализацию.
  const isRowPinned = useCallback(
    (id: string) => pinnedMsgListRef.current.some((p) => p.id === id) || pinnedMsg?.id === id,
    [pinnedMsg]
  );

  const toggleRowPin = useCallback((id: string) => {
    void (async () => {
      // v4.32.235: закрепление уходит и собеседнику. Раньше оно жило
      // только в своей БД — баннер появлялся у одного, у второго не
      // менялось ничего.
      const res = await toggleDmPinAndSync({ peerPubB64: peerB64, msgId: id, on: !isRowPinned(id) });
      announceDmPin(res.sync);
      const list = res.entries;
      setPinnedMsgList(list);
      setPinnedMsgIdx(0);
      if (list.length === 0) {
        setPinnedMsg(null);
      } else {
        const top = linesRef.current.find((m) => m.id === list[0].id) ?? null;
        setPinnedMsg(top);
      }
    })();
  }, [peerB64, isRowPinned]);

  const selectRow = useCallback((id: string) => {
    setSelectedIds(new Set([id]));
  }, []);

  const copyRowLink = useCallback((id: string) => {
    Clipboard.setString(`airchat://dm/${encodeURIComponent(peerB64)}/msg/${encodeURIComponent(id)}`);
    showSuccess(COPIED_LINK);
  }, [peerB64]);

  /**
   * v4.32.366: пункт «Перевести» отправлял расшифрованное сообщение на
   * сторонний сервис, не спрашивая выключатель «Облачный перевод» в
   * настройках, — тот проверял только авто-перевод. Выключатель, выключенный
   * по умолчанию, обходился одним тапом. И фильтр одноразовых кодов стоял
   * тоже только на авто-пути.
   */
  const translateRow = useCallback((rowText: string) => {
    const text = (rowText ?? '').slice(0, MAX_TRANSLATE_CHARS);
    const blocked = translateBlockReason(text);
    if (blocked) { showError(translateBlockMessage(blocked)); return; }
    void (async () => {
      if (!(await cloudTranslateAllowed())) {
        showError(CLOUD_TRANSLATE_OFF_MESSAGE);
        return;
      }
      const url = buildTranslateUrl(text, translateLangRef.current);
      if (!url) { showError('Не выбран язык перевода'); return; }
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        const out = parseTranslation(await res.json(), text);
        if (out.ok) {
          Alert.alert('Перевод', out.text, [
            { text: COPY_ACTION, onPress: () => { Clipboard.setString(out.text); showSuccess(COPIED_TEXT); } },
            { text: 'OK', style: 'cancel' },
          ]);
        } else {
          showError(translateFailureMessage(out.reason));
        }
      } catch { showError('Ошибка перевода'); } finally { clearTimeout(to); }
    })();
  }, []);

  const closeRowPoll = useCallback((id: string) => {
    Alert.alert('Завершить опрос?', 'Голосование будет закрыто, новые голоса не принимаются.', [
      // v4.32.251: завершение уходит собеседнику конвертом — раньше опрос
      // закрывался только у автора, а собеседник продолжал голосовать.
      // v4.32.446: «Опрос завершён» печаталось и тогда, когда конверт не ушёл
      // собеседнику: у автора опрос закрыт, у собеседника открыт.
      { text: 'Завершить', style: 'destructive', onPress: () => void closeAndSyncPoll({ msgId: id, myPubB64, peerPubB64: peerB64 }).then((res) => { if (res.ok) showSuccess('Опрос завершён'); else showError(res.reason); }).catch(() => showError('Не удалось завершить опрос')) },
      { text: 'Отмена', style: 'cancel' },
    ]);
  }, [myPubB64, peerB64]);

  const showMessageMenu = useCallback(
    (row: ChatMessageRow) => {
      Vibration.vibrate(30);
      const svc = getMessagingService();
      if (!svc) return;

      const runLocal = async () => {
        // Save to recently deleted (KV) before actual delete
        void (async () => {
          try {
            // v4.32.552: чтение-дополнение-запись идёт через kvUpdateSecretScoped.
            // Раньше не открывшийся шифртекст приходил сюда пустой строкой,
            // список начинался с нуля и уходил в базу поверх прежней корзины:
            // до полусотни удалённых сообщений, которые и собирались вернуть,
            // исчезали от одного нажатия «Удалить».
            const { kvUpdateSecretScoped } = await import('../../core/storage/local');
            const now = Date.now();
            await kvUpdateSecretScoped(activeProfileId, recentlyDeletedKey(peerB64), (raw) => {
              let list: Array<{ id: string; text: string; createdAt: number; deletedAt: number; direction: string }> = [];
              if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch { /* */ } }
              // v4.32.183 (Round-13 #8): defense — if parse yielded non-array, list stays [].
              list = list.filter((m) => m && now - m.deletedAt < DM_RECENTLY_DELETED_TTL_MS);
              if (row.text && row.text.length < 2000 && !row.text.startsWith('\x01')) {
                list.unshift({ id: row.id, text: row.text, createdAt: row.createdAt, deletedAt: now, direction: row.direction });
              }
              if (list.length > 50) list = list.slice(0, 50);
              return JSON.stringify(list);
            });
          } catch { /* ignore */ }
        })();
        await svc.deleteMessageLocally(row.id);
        void appendNewMessages();
        showSuccess('Сообщение удалено');
      };

      const confirmEveryone = () => {
        Alert.alert('Удалить у всех', 'Сообщение будет удалено у всех участников чата.', [
          { text: 'Отмена', style: 'cancel' },
          {
            text: 'Удалить',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                const echo = await svc.deleteMessageForEveryone(peerB64, row.id);
                void appendNewMessages();
                reportTwoSided(echo, 'delete');
              })();
            },
          },
        ]);
      };

      const startEdit = () => { setEditTarget(row); setMsg(row.text); };

      const copyText = () => {
        Clipboard.setString(row.text);
        showSuccess(COPIED_TEXT);
      };

      const selectMsg = () => selectRow(row.id);

      const showReactions = () => setReactionsTarget(row);

      const forwardMsg = () => setForwardTarget(row);

      const togglePin = () => toggleRowPin(row.id);

      const pinLabel = isRowPinned(row.id) ? 'Открепить' : 'Закрепить';

      const isStarred = Boolean(row.starred);
      const starLabel = isStarred ? 'Убрать из избранного' : 'В избранное';
      const toggleStar = () => {
        runGuardedOp(async () => {
          await setMessageStarred(row.id, !isStarred);
          await appendNewMessages();
        }, 'Не удалось изменить избранное', 'ui_chat_star_failed');
      };

      const translateMsg = () => translateRow(row.text ?? '');

      const scheduleReminder = () => {
        const preview = row.text.startsWith('\x01') ? 'Медиасообщение' : row.text.slice(0, 40);
        promptMessageReminder(preview, showSuccess, showError);
      };

      const isPollRow = (row.text ?? '').startsWith(POLL_PREFIX);
      const closeDmPoll = () => closeRowPoll(row.id);
      const copyMsgLink = () => copyRowLink(row.id);

      if (row.direction === 'out') {
        if (Platform.OS === 'ios') {
          const iosOutOpts = ['Ответить', 'Переслать', 'Реакция', 'Редактировать', COPY_ACTION, '🌐 Перевести', COPY_LINK_ACTION, starLabel, pinLabel, 'Напомнить', 'Подробнее', 'Выбрать'];
          if (isPollRow) iosOutOpts.push('Завершить опрос');
          iosOutOpts.push('Удалить у себя', 'Удалить у всех', 'Отмена');
          const iosCancelIdx = iosOutOpts.length - 1;
          const iosDelLocalIdx = iosOutOpts.indexOf('Удалить у себя');
          ActionSheetIOS.showActionSheetWithOptions(
            { options: iosOutOpts, cancelButtonIndex: iosCancelIdx, destructiveButtonIndex: iosDelLocalIdx },
            (i) => {
              const idx = (s: string) => iosOutOpts.indexOf(s);
              if (i === 0) setReplyTo(row);
              else if (i === 1) forwardMsg();
              else if (i === 2) showReactions();
              else if (i === 3) startEdit();
              else if (i === 4) copyText();
              else if (i === idx('🌐 Перевести')) translateMsg();
              else if (i === idx(COPY_LINK_ACTION)) copyMsgLink();
              else if (i === idx(starLabel)) toggleStar();
              else if (i === idx(pinLabel)) togglePin();
              else if (i === idx('Напомнить')) scheduleReminder();
              else if (i === idx('Подробнее')) setMsgInfoTarget(row);
              else if (i === idx('Выбрать')) selectMsg();
              else if (isPollRow && i === idx('Завершить опрос')) closeDmPoll();
              else if (i === idx('Удалить у себя')) void runLocal();
              else if (i === idx('Удалить у всех')) confirmEveryone();
            }
          );
        } else {
          setQuickReactMsg(row);
        }
      } else if (Platform.OS === 'ios') {
        const markUnread = () => void import('../../core/storage/local').then((m) => m.markConversationUnread(peerB64, activeProfileId)).then(onBackRef.current);
        const iosInOpts = ['Ответить', 'Переслать', 'Реакция', COPY_ACTION, '🌐 Перевести', COPY_LINK_ACTION, starLabel, pinLabel, 'Напомнить', '📩 Отметить непрочитанным', 'Выбрать', 'Удалить у себя', 'Отмена'];
        ActionSheetIOS.showActionSheetWithOptions(
          { options: iosInOpts, cancelButtonIndex: iosInOpts.indexOf('Отмена'), destructiveButtonIndex: iosInOpts.indexOf('Удалить у себя') },
          (i) => {
            const idx = (s: string) => iosInOpts.indexOf(s);
            if (i === 0) setReplyTo(row);
            else if (i === 1) forwardMsg();
            else if (i === 2) showReactions();
            else if (i === 3) copyText();
            else if (i === idx('🌐 Перевести')) translateMsg();
            else if (i === idx(COPY_LINK_ACTION)) copyMsgLink();
            else if (i === idx(starLabel)) toggleStar();
            else if (i === idx(pinLabel)) togglePin();
            else if (i === idx('Напомнить')) scheduleReminder();
            else if (i === idx('📩 Отметить непрочитанным')) markUnread();
            else if (i === idx('Выбрать')) selectMsg();
            else if (i === idx('Удалить у себя')) void runLocal();
          }
        );
      } else {
        setQuickReactMsg(row);
      }
    },
    [peerB64, appendNewMessages, activeProfileId,
      isRowPinned, toggleRowPin, selectRow, copyRowLink, translateRow, closeRowPoll]
  );

  // v4.32.239: поиск по переписке ходит в базу, а не фильтрует загруженную
  // страницу. Раньше искалось только среди PAGE = 40 последних сообщений, и
  // слово из переписки месячной давности давало «0/0» — при том что в группах
  // тот же поиск всегда работал по всей истории (searchGroupMessages).
  useEffect(() => {
    if (!searchVisible || !searchQuery.trim()) {
      setSearchResults(null);
      setSearchScan(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void searchChatMessages(peerB64, searchQuery.trim(), activeProfileId).then((res) => {
        if (!alive) return;
        setSearchResults(res.items);
        setSearchScan(res.scan);
        setSearchHitIdx(0);
      });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [searchVisible, searchQuery, peerB64, activeProfileId]);

  const displayMessages = useMemo((): ChatListItem[] => {
    // Во время поиска список — это найденные сообщения (как на экране группы),
    // поэтому дальше не примешиваются ни отправляемое сейчас, ни разделитель
    // непрочитанных: и то и другое к результатам поиска отношения не имеет.
    if (searchResults) return injectDateSeparators(searchResults);
    let merged = optimisticOutgoing ? [...lines, optimisticOutgoing] : lines;
    // Media filter: show only messages with media attachments
    if (mediaFilterActive) {
      merged = merged.filter((m) => m.text.startsWith('\x01') || (m.mediaCids && m.mediaCids.length > 0));
    }
    const sorted = [...merged].sort((a, b) => a.createdAt - b.createdAt).reverse();
    const withDates = injectDateSeparators(sorted);
    // Inject "N new messages" separator if we opened with unread messages
    if (!mediaFilterActive && openUnreadCount > 0) {
      let msgCount = 0;
      for (let i = 0; i < withDates.length; i++) {
        if ((withDates[i] as DateSeparatorItem).type !== 'date_sep') {
          msgCount++;
          if (msgCount === openUnreadCount) {
            withDates.splice(i + 1, 0, {
              type: 'date_sep',
              label: `↓ ${openUnreadCount} новых`,
              key: 'unread_sep',
            });
            break;
          }
        }
      }
    }
    return withDates;
  }, [lines, optimisticOutgoing, openUnreadCount, mediaFilterActive, searchResults]);

  const messageById = useMemo(() => {
    const map = new Map<string, ChatMessageRow>();
    for (const m of lines) map.set(m.id, m);
    return map;
  }, [lines]);

  // Search hit indices inside displayMessages (newest-first order)
  const searchHitIndices = useMemo((): number[] => {
    // trim обязателен: в базу запрос уходит обрезанным, и без него счётчик
    // «n/m» показывал 0 при найденных сообщениях, стоило добавить пробел.
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const hits: number[] = [];
    for (let i = 0; i < displayMessages.length; i++) {
      const item = displayMessages[i];
      if ((item as DateSeparatorItem).type === 'date_sep') continue;
      const msg = item as ChatMessageRow;
      if (matchesSearch(msg.text, q)) hits.push(i);
    }
    return hits;
  }, [displayMessages, searchQuery]);

  // v4.32.506: место в поиске держится за идентификатором сообщения, а не за
  // его номером в списке. Список пересобирается сам по себе — входящее
  // сообщение, правка, доехавшая отметка о прочтении, — и номера съезжают.
  const searchHitIds = useMemo((): string[] => {
    const ids: string[] = [];
    for (const i of searchHitIndices) {
      const item = displayMessages[i];
      if (item && (item as DateSeparatorItem).type !== 'date_sep') ids.push((item as ChatMessageRow).id);
    }
    return ids;
  }, [searchHitIndices, displayMessages]);
  // Ключ по составу: сам массив пересоздаётся на каждый рендер списка, и
  // эффект, завязанный на его тождество, срабатывал бы вхолостую.
  const searchHitKey = useMemo(() => hitSetKey(searchHitIds), [searchHitIds]);
  const searchHitIdsRef = useRef<string[]>(searchHitIds);
  searchHitIdsRef.current = searchHitIds;
  const searchHitIndicesRef = useRef<number[]>(searchHitIndices);
  searchHitIndicesRef.current = searchHitIndices;
  const searchAnchorRef = useRef<string | null>(null);

  // Stage C.2: hold messageById in a ref so getReplyTo stays a stable reference
  // across message updates — otherwise every new/edited line rebuilds the Map,
  // flips getReplyTo's identity, and busts MessageRow's memo for every row.
  const messageByIdRef = useRef(messageById);
  messageByIdRef.current = messageById;
  const getReplyTo = useCallback((id: string): ChatMessageRow | null => messageByIdRef.current.get(id) ?? null, []);

  // Scroll to first unread message separator on initial load
  useEffect(() => {
    if (didScrollToUnreadRef.current || openUnreadCount === 0) return;
    const sepIdx = displayMessages.findIndex((m) => 'key' in m && (m as { key: string }).key === 'unread_sep');
    if (sepIdx < 0) return;
    // Give FlashList time to render before scrolling
    const t = setTimeout(() => {
      try {
        flashListRef.current?.scrollToIndex({ index: sepIdx, animated: true, viewPosition: 0.3 });
        didScrollToUnreadRef.current = true;
      } catch { /* ignore if list not ready */ }
    }, 350);
    return () => clearTimeout(t);
  }, [displayMessages, openUnreadCount]);

  const searchHitId = useMemo(() => {
    if (!searchHitIndices.length) return null;
    const idx = searchHitIndices[searchHitIdx % searchHitIndices.length];
    const item = displayMessages[idx];
    if (!item || (item as DateSeparatorItem).type === 'date_sep') return null;
    return (item as ChatMessageRow).id;
  }, [searchHitIndices, searchHitIdx, displayMessages]);

  /**
   * v4.32.229: подсветка текущего совпадения поиска.
   * `searchHitId` вычислялся, но не использовался: при переходе по стрелкам
   * ↑/↓ («3/12») список прокручивался, однако все совпадения выглядели
   * одинаково — понять, какое из них сейчас «третье», было невозможно.
   */
  useEffect(() => {
    if (!searchHitId) return;
    setJumpHighlightId(searchHitId);
    const t = setTimeout(() => setJumpHighlightId(null), 1500);
    return () => clearTimeout(t);
  }, [searchHitId]);

  // Jump to current search hit
  const jumpToHit = useCallback((idx: number) => {
    const indices = searchHitIndicesRef.current;
    if (!indices.length) return;
    const next = clampHitIndex(idx, indices.length);
    // Якорь ставим до прокрутки: пересборка списка следом должна вернуть
    // курсор именно сюда, а не в начало.
    searchAnchorRef.current = searchHitIdsRef.current[next] ?? null;
    try {
      flashListRef.current?.scrollToIndex({ index: indices[next], animated: true, viewPosition: 0.5 });
    } catch { /* ignore */ }
    setSearchHitIdx(next);
  }, []);

  /**
   * v4.32.506: раньше этот эффект висел на тождестве массива совпадений и
   * при каждом входящем сообщении сбрасывал счётчик на «1/N» и утаскивал
   * прокрутку к самому свежему совпадению — человек терял место в поиске.
   * Теперь состав набора сверяется по ключу, курсор идёт за якорем, а
   * прокрутка случается только когда якоря среди совпадений не осталось,
   * то есть при новом поиске или исчезнувшем сообщении.
   */
  useEffect(() => {
    const ids = searchHitIdsRef.current;
    const indices = searchHitIndicesRef.current;
    if (indices.length === 0) {
      searchAnchorRef.current = null;
      return;
    }
    const keep = anchorStillPresent(ids, searchAnchorRef.current);
    const next = hitIndexForAnchor(ids, searchAnchorRef.current);
    setSearchHitIdx((prev) => (prev === next ? prev : next));
    if (keep) return;
    searchAnchorRef.current = ids[next] ?? null;
    try {
      flashListRef.current?.scrollToIndex({ index: indices[next], animated: true, viewPosition: 0.5 });
    } catch { /* ignore */ }
  }, [searchHitKey]);

  // Stage C.2: hold displayMessages in a ref so scrollToReply keeps a stable
  // identity across every new/edited message — otherwise its identity flips
  // and MessageRow's onReplyTap memo check fails for every row on each update.
  const displayMessagesRef = useRef(displayMessages);
  displayMessagesRef.current = displayMessages;
  const scrollToReply = useCallback((replyToId: string) => {
    const displayList = displayMessagesRef.current;
    const idx = displayList.findIndex((item) => {
      if ((item as DateSeparatorItem).type === 'date_sep') return false;
      return (item as ChatMessageRow).id === replyToId;
    });
    if (idx < 0) return;
    try {
      flashListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
      setJumpHighlightId(replyToId);
      setTimeout(() => setJumpHighlightId(null), 1500);
    } catch { /* ignore */ }
  }, []);

  const jumpToPinned = useCallback((id: string, idx: number) => {
    scrollToReply(id);
    setPinnedMsgIdx(idx);
    setPinnedListVisible(false);
  }, [scrollToReply]);

  // Stage D-ext: stabilize FlashList renderItem identity via ref-to-latest-fn pattern.
  const renderChatMsgImpl = ({ item }: { item: ChatListItem }) => {
    const sep = item as DateSeparatorItem;
    if (sep.type === 'date_sep') {
      const isUnread = sep.key === 'unread_sep';
      return (
        <AppPressable
          style={{ alignItems: 'center', paddingVertical: 6 }}
          onLongPress={() => {
            if (isUnread) return;
            const now = Date.now();
            const chatMsgs = lines.filter((l) => !('type' in l)) as ChatMessageRow[];
            const periods = [
              { label: 'Начало переписки', ts: 0 },
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
                    const sorted = [...chatMsgs].sort((a, b) => a.createdAt - b.createdAt);
                    if (sorted.length === 0) return;
                    const target = ts === 0
                      ? sorted[0]
                      : sorted.reduce((prev, curr) =>
                          Math.abs(curr.createdAt - ts) < Math.abs(prev.createdAt - ts) ? curr : prev
                        );
                    scrollToReply(target.id);
                  },
                })),
                { text: 'Отмена', style: 'cancel' },
              ]
            );
          }}
        >
          {/* v4.32.410: плашка считается от обоев, а не от палитры. Серый
              'rgba(128,128,128,0.25)' здесь стоял поверх чего угодно, а
              надпись бралась из палитры — в светлой теме на тёмных обоях это
              было чёрным по тёмному. */}
          <View style={{ backgroundColor: isUnread ? feed.loud.fill : feed.quiet.fill, borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 4 }}>
            <Text style={{ color: isUnread ? feed.loud.ink : feed.quiet.ink.secondary, fontSize: 12, fontWeight: isUnread ? '700' : '500' }}>{sep.label}</Text>
          </View>
        </AppPressable>
      );
    }
    const msg = item as ChatMessageRow;
    return (
      <MessageRow
        item={msg}
        gateway={gateway}
        onLongPress={showMessageMenu}
        onSwipeReply={setReplyTo}
        onSwipeStar={handleRowSwipeStar}
        onSelect={isSelecting ? toggleSelect : undefined}
        isSelected={isSelecting ? selectedIds.has(msg.id) : undefined}
        highlight={jumpHighlightId === msg.id}
        searchMatch={searchVisible ? matchesSearch(msg.text, searchQuery.trim().toLowerCase()) : false}
        onReplyTap={scrollToReply}
        getReplyTo={getReplyTo}
        onImagePress={openMedia}
        onReactionTap={handleRowReactionTap}
        onRetryFailed={retryFailedMessage}
        onDoubleTap={handleRowDoubleTap}
        onViewOnceTap={handleViewOnceTap}
        pair={pair}
        translatedText={autoTranslate && msg.direction === 'in' ? translationCache[msg.id] : undefined}
        fontSizeOverride={chatFontSize ?? undefined}
      />
    );
  };
  const renderChatMsgImplRef = useRef(renderChatMsgImpl);
  renderChatMsgImplRef.current = renderChatMsgImpl;
  const renderChatMsg = useCallback(
    (args: { item: ChatListItem }) => renderChatMsgImplRef.current(args),
    [],
  );

  // ─── Jump to initial message (from global search) ─────────────────────────
  const initialJumpDoneRef = useRef(false);
  useEffect(() => {
    if (!initialJumpMsgId || initialJumpDoneRef.current || lines.length === 0) return;
    const found = lines.some((m) => m.id === initialJumpMsgId);
    if (!found) return;
    initialJumpDoneRef.current = true;
    const t = setTimeout(() => scrollToReply(initialJumpMsgId), 450);
    return () => clearTimeout(t);
  }, [lines, initialJumpMsgId, scrollToReply]);

  return (
    <KeyboardHost>
    <View
      style={{ flex: 1, backgroundColor: colors.background }}
      onLayout={(e) => setRootHeight(e.nativeEvent.layout.height)}
    >
      {/* v4.32.540: обои поднялись из-под ленты в самый низ экрана. Раньше слой
          стоял ПОСЛЕ шапки, то есть начинался под ней, и весь верх — полоса
          часов и поле вокруг капсулы — оставался плоской `colors.background`.
          Фон переписки обрывался ровно там, где на него смотрят первым делом.
          Клип у слоя свой (`overflow: 'hidden'` внутри), поэтому дрейф пятен
          по-прежнему не вылезает за экран, а шапка теперь размывает обои —
          ради этого стекло и заводилось. */}
      <WallpaperBackground wallpaper={wallpaper} ground={feed.ground} />
      {/* Thread header with back button */}
      <GlassSurface style={[s.threadHeader, { marginTop: insets.top + spacing.sm }]} variant="regular">
        <AppPressable style={s.backBtn} onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Назад к чатам">
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </AppPressable>
        <AppPressable
          style={s.headerInfo}
          onPress={() => { if (!isSavedMessages) setContactInfoVisible(true); }}
          hitSlop={4}
          accessibilityRole={isSavedMessages ? undefined : 'button'}
          accessibilityLabel={isSavedMessages ? undefined : `Открыть профиль: ${localDisplayName}`}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={[s.headerName, { color: colors.text }]} numberOfLines={1}>{localDisplayName}</Text>
            {isMuted ? <Ionicons name="notifications-off-outline" size={14} color={colors.textMuted} /> : null}
          </View>
          {isSavedMessages ? (
            <Text style={[s.headerStatus, { color: colors.textMuted }]}>Заметки для себя</Text>
          ) : peerTyping ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <AnimatedDots dotColor={colors.primary} dotSize={5} dotSpacing={6} stepDurationMs={200} />
              <Text style={[s.headerStatus, { color: colors.accent, fontStyle: 'italic' }]}>печатает</Text>
            </View>
          ) : disappearMs ? (
            <Text style={[s.headerStatus, { color: colors.warning }]}>
              {'⏱ '}Исчезают через {formatDisappearLabel(disappearMs)}
            </Text>
          ) : presence.label || presence.status ? (
            // v4.32.375: раньше это были две ветки, и статус стоял первым —
            // значит собеседник, однажды написавший «на созвоне», навсегда
            // забирал у шапки строку «в сети»/«был(а) недавно». Правило сборки
            // и почему порядок именно такой — см. presenceSubtitle.
            <Text
              style={[s.headerStatus, { color: presence.bucket === 'online' ? colors.success : colors.textMuted }]}
              numberOfLines={1}
            >
              {presenceSubtitle(presence.label, presence.status)}
            </Text>
          ) : null}
        </AppPressable>
        <View style={s.headerRight}>
          {!isSavedMessages && peerB64 ? (
            <>
              <AppPressable
                style={s.headerIconBtn}
                accessibilityRole="button"
                accessibilityLabel="Видеозвонок"
                onPress={() => {
                  if (getCurrentCall()) { showError('Уже активен звонок'); return; }
                  void initiateCall(peerB64, localDisplayName, true)
                    .then((ok) => { if (!ok) showError('Не удалось начать видеозвонок'); })
                    .catch(() => showError('Не удалось начать видеозвонок'));
                }}
              >
                <Ionicons name="videocam-outline" size={20} color={colors.text} />
              </AppPressable>
              <AppPressable
                style={s.headerIconBtn}
                accessibilityRole="button"
                accessibilityLabel="Позвонить"
                onPress={() => {
                  if (getCurrentCall()) { showError('Уже активен звонок'); return; }
                  void initiateCall(peerB64, localDisplayName)
                    .then((ok) => { if (!ok) showError('Не удалось начать звонок'); })
                    .catch(() => showError('Не удалось начать звонок'));
                }}
              >
                <Ionicons name="call-outline" size={20} color={colors.text} />
              </AppPressable>
            </>
          ) : null}
          <AppPressable
            style={[s.headerIconBtn, mediaFilterActive && { backgroundColor: headerTint.fill, borderRadius: radius.md }]}
            accessibilityRole="button"
            accessibilityLabel="Медиа в чате"
            accessibilityState={{ selected: mediaFilterActive }}
            onPress={() => { setMediaFilterActive((v) => !v); setSearchVisible(false); }}
          >
            <Ionicons name="images-outline" size={20} color={mediaFilterActive ? headerTint.ink : colors.text} />
          </AppPressable>
          <AppPressable style={s.headerIconBtn} onPress={() => { setSearchVisible((v) => !v); setMediaFilterActive(false); }} accessibilityRole="button" accessibilityLabel={searchVisible ? 'Закрыть поиск' : 'Поиск'}>
            <Ionicons name={searchVisible ? 'close' : 'search'} size={20} color={colors.text} />
          </AppPressable>
          {!isSavedMessages ? (
            <AppPressable
              style={s.headerIconBtn}
              accessibilityRole="button"
              accessibilityLabel="Меню чата"
              onPress={() => {
                const disappearLabel = disappearMs
                  ? `Исчезновение: ${formatDisappearLabel(disappearMs)}`
                  : 'Установить исчезновение';
                const blockLabel = isBlocked ? 'Разблокировать' : 'Заблокировать';
                const muteLabel = isMuted
                  ? (mutedUntil ? `Снять без звука (${muteRemainingLabel(mutedUntil)})` : 'Включить звук')
                  : 'Беззвучно…';
                const autoTranslateLabel = autoTranslate ? '🌐 Автоперевод: вкл' : '🌐 Автоперевод: выкл';
                Alert.alert('Чат', localDisplayName, [
                  {
                    text: autoTranslateLabel,
                    onPress: () => {
                      const newVal = !autoTranslate;
                      void (async () => {
                        await scopedKvSet(chatAutoTranslateKey(peerB64), newVal ? '1' : '0');
                        setAutoTranslate(newVal);
                        if (!newVal) setTranslationCache({});
                      })();
                    },
                  },
                  {
                    text: 'Медиафайлы',
                    onPress: () => setMediaGalleryVisible(true),
                  },
                  {
                    text: `Размер шрифта${chatFontSize ? ` (${chatFontSize}пт)` : ''}`,
                    onPress: () => {
                      const options = ['Маленький (13)', 'Обычный (15)', 'Крупный (17)', 'Очень крупный (20)', 'По умолчанию', 'Отмена'];
                      const sizes = [13, 15, 17, 20, null];
                      if (Platform.OS === 'ios') {
                        ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: 5 }, (i) => {
                          if (i >= 5) return;
                          const sz = sizes[i];
                          setChatFontSize(sz ?? null);
                          void scopedKvSet(chatFontSizeKey(peerB64), sz ? String(sz) : '');
                        });
                      } else {
                        Alert.alert('Размер шрифта', 'Выберите размер:', [
                          { text: 'Маленький (13)', onPress: () => { setChatFontSize(13); void scopedKvSet(chatFontSizeKey(peerB64), '13'); } },
                          { text: 'Обычный (15)', onPress: () => { setChatFontSize(15); void scopedKvSet(chatFontSizeKey(peerB64), '15'); } },
                          { text: 'Крупный (17)', onPress: () => { setChatFontSize(17); void scopedKvSet(chatFontSizeKey(peerB64), '17'); } },
                          { text: 'Очень крупный (20)', onPress: () => { setChatFontSize(20); void scopedKvSet(chatFontSizeKey(peerB64), '20'); } },
                          { text: 'По умолчанию', onPress: () => { setChatFontSize(null); void scopedKvSet(chatFontSizeKey(peerB64), ''); } },
                          { text: 'Отмена', style: 'cancel' },
                        ]);
                      }
                    },
                  },
                  {
                    text: 'Избранные сообщения',
                    onPress: () => {
                      void listStarredMessages(activeProfileId).then((entries) => {
                        setStarredEntries(entries.filter((e) => e.kind === 'chat' && e.contextId === peerB64));
                        setStarredVisible(true);
                      });
                    },
                  },
                  {
                    text: muteLabel,
                    onPress: () => {
                      if (isMuted) {
                        void setConversationMuted(peerB64, activeProfileId, false).then(async () => {
                          await muteUnset('chat', peerB64);
                          setIsMuted(false); setMutedUntil(null);
                        });
                      } else {
                        const snooze = (ms: number | null) => async () => {
                          const untilMs = ms === null ? null : Date.now() + ms;
                          await setConversationMutedUntil(peerB64, activeProfileId, untilMs);
                          await muteSet('chat', peerB64, untilMs !== null ? { untilMs } : undefined);
                          setIsMuted(true); setMutedUntil(untilMs);
                        };
                        Alert.alert('Беззвучный режим', 'Выберите длительность:', [
                          { text: '1 час', onPress: () => void snooze(3_600_000)() },
                          { text: '8 часов', onPress: () => void snooze(8 * 3_600_000)() },
                          { text: '1 день', onPress: () => void snooze(86_400_000)() },
                          { text: '1 неделя', onPress: () => void snooze(7 * 86_400_000)() },
                          { text: 'Навсегда', onPress: () => void snooze(null)() },
                          { text: 'Отмена', style: 'cancel' },
                        ]);
                      }
                    },
                  },
                  {
                    text: disappearLabel,
                    onPress: () => Alert.alert(
                      'Исчезающие сообщения',
                      'Выбранное время действует у обоих собеседников и применяется к сообщениям, отправленным после включения.',
                      [
                        // v4.32.236: явное «Выкл» пишется как 0, а не NULL. NULL
                        // означает «пользователь не выбирал», и туда ставится
                        // значение по умолчанию из настроек — иначе оно вернуло
                        // бы таймер, который человек только что снял.
                        // v4.32.237: решение уходит и собеседнику (setDisappearAndSync).
                        ...([
                          ['Выкл', 0],
                          ['1 мин', 60_000],
                          ['1 час', 3_600_000],
                          ['1 день', 86_400_000],
                          ['1 неделя', 7 * 86_400_000],
                        ] as const).map(([label, ms]) => ({
                          text: label,
                          // v4.32.448: обещание выше — «действует у обоих» — теперь
                          // проверяется. Если конверт до собеседника не доехал,
                          // человек узнаёт об этом сразу, а не по чужой переписке,
                          // которая никуда не делась.
                          onPress: () => void setDisappearAndSync({ peerPubB64: peerB64, ms }).then((res) => {
                            setDisappearMs(ms);
                            if (!res.synced) showError(res.warning);
                          }),
                        })),
                        { text: 'Отмена', style: 'cancel' as const },
                      ]
                    ),
                  },
                  {
                    text: blockLabel,
                    style: isBlocked ? 'default' : 'destructive',
                    onPress: () => {
                      if (isBlocked) {
                        runGuardedOp(async () => {
                          await rateLimiter.unblockContact(peerB64);
                          Alert.alert('AirChat', 'Разблокировано');
                          setIsBlocked(false);
                        }, 'Не удалось разблокировать', 'ui_chat_unblock_failed');
                      } else {
                        Alert.alert('Заблокировать?', 'Сообщения будут отклонены.', [
                          { text: 'Отмена', style: 'cancel' },
                          { text: 'Заблокировать', style: 'destructive', onPress: () => runGuardedOp(async () => {
                            await rateLimiter.blockContact(peerB64);
                            Alert.alert('AirChat', 'Заблокировано');
                            setIsBlocked(true);
                          }, 'Не удалось заблокировать', 'ui_chat_block_failed') },
                        ]);
                      }
                    },
                  },
                  {
                    text: 'Недавно удалённые',
                    onPress: () => {
                      void import('../../core/storage/local').then((m) => m.kvGetSecretScoped(activeProfileId, recentlyDeletedKey(peerB64))).then((raw) => {
                        let list: Array<{ id: string; text: string; createdAt: number; deletedAt: number; direction: string }> = [];
                        if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch { /* */ } }
                        const now = Date.now();
                        list = list.filter((m) => m && now - m.deletedAt < DM_RECENTLY_DELETED_TTL_MS);
                        setRecentlyDeletedList(list);
                        setRecentlyDeletedVisible(true);
                      });
                    },
                  },
                  {
                    text: 'Очистить историю',
                    style: 'destructive',
                    onPress: () => {
                      Alert.alert(
                        'Очистить историю?',
                        'Все сообщения в этом чате будут удалены локально. Собеседник их не потеряет.',
                        [
                          { text: 'Отмена', style: 'cancel' },
                          {
                            text: 'Очистить',
                            style: 'destructive',
                            onPress: () => {
                              void clearChatHistory(peerB64, activeProfileId).then(() => {
                                void reloadThread();
                                showSuccess('История очищена');
                              });
                            },
                          },
                        ]
                      );
                    },
                  },
                  {
                    text: 'Экспорт чата',
                    onPress: () => {
                      void (async () => {
                        try {
                          const allMsgs = await listAllChatMessages({ contactPubB64: peerB64, ownerProfileId: activeProfileId });
                          // v4.32.604: файл сохранят и на него сошлются, поэтому
                          // выгружаем либо всё, либо ничего — как в группе с v4.32.532.
                          if (!shouldApplyRows(allMsgs)) { showError('Не удалось прочитать переписку для экспорта'); return; }
                          const lines2 = [...allMsgs].sort((a, b) => a.createdAt - b.createdAt);
                          const text2 = lines2.map((m) => {
                            const d = fullDateTime(m.createdAt);
                            const who = m.direction === 'out' ? 'Вы' : localDisplayName;
                            return `[${d}] ${who}: ${exportBody(m)}`;
                          }).join('\n');
                          // v4.32.310: имя даёт cacheFiles — он же за этим
                          // файлом и убирает. Тут лежит расшифрованная
                          // переписка, а до этой версии за ней не убирал никто.
                          // v4.32.313: и отдача общая — три копии расходились.
                          const shared = await shareTextExport('chat', text2, `Чат с ${localDisplayName}`, Date.now());
                          if (!shared) Alert.alert('Экспорт', 'Системное «Поделиться» недоступно на этом устройстве');
                        } catch (e) {
                          showError(userErrorText(e, 'Не удалось выгрузить переписку'));
                        }
                      })();
                    },
                  },
                  {
                    text: 'Фон чата',
                    onPress: () => setWallpaperPickerVisible(true),
                  },
                  { text: 'Отмена', style: 'cancel' },
                ]);
              }}
            >
              <Ionicons
                name={isBlocked ? 'ban' : 'ellipsis-vertical'}
                size={20}
                color={isBlocked ? colors.error : colors.text}
              />
            </AppPressable>
          ) : null}
        </View>
      </GlassSurface>

      {/* v4.32.105 K.11: на Android behavior=undefined — adjustResize из манифеста сам ресайзит
          окно, KAV с padding вызывал двойную компенсацию (контент сжимался дважды, TextInput
          уходил за клавиатуру). На iOS behavior=padding остаётся — там adjustResize не существует. */}
      <View style={{ flex: 1, paddingBottom: manualKbPad }}>
        <View style={{ flex: 1 }}>
        <FlashList
          ref={flashListRef}
          style={{ flex: 1 }}
          data={displayMessages}
          inverted
          getItemType={(item) => (item as DateSeparatorItem).type === 'date_sep' ? 'sep' : 'msg'}
          keyboardDismissMode="interactive"
          keyExtractor={(item) => (item as DateSeparatorItem).type === 'date_sep' ? (item as DateSeparatorItem).key : (item as ChatMessageRow).id}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            // Лента перевёрнута: «подвал» рисуется НАД самым старым сообщением —
            // ровно там, куда доезжает человек, когда просит показать ещё.
            // До v4.32.539 признак загрузки считался, но нигде не показывался.
            loadingMore ? (
              <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : null
          }
          onViewableItemsChanged={onViewableChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
          onScroll={(e) => {
            // inverted list: offset > 100 means user scrolled away from bottom
            const next = e.nativeEvent.contentOffset.y > 120;
            if (showScrollToBottomRef.current !== next) {
              showScrollToBottomRef.current = next;
              setShowScrollToBottom(next);
            }
          }}
          scrollEventThrottle={100}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
          renderItem={renderChatMsg}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingTop: 60 }}>
              {/* Надпись лежит на обоях — на своей плашке, как и дата. */}
              <View style={{ backgroundColor: feed.quiet.fill, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 8 }}>
                <Text style={{ color: feed.quiet.ink.secondary, textAlign: 'center' }}>
                  Нет сообщений. Отправьте первое!
                </Text>
              </View>
            </View>
          }
        />
        </View>

        {showScrollToBottom ? (
          <AppPressable
            style={[s.scrollToBottomBtn, { backgroundColor: colors.primary }]}
            accessibilityRole="button"
            accessibilityLabel="К последнему сообщению"
            onPress={() => flashListRef.current?.scrollToOffset({ offset: 0, animated: true })}
          >
            {openUnreadCount > 0 ? (
              <View style={{ position: 'absolute', top: -6, right: -6, backgroundColor: colors.errorFill, borderRadius: radius.md, minWidth: 18, paddingHorizontal: 4, alignItems: 'center' }}>
                <Text style={{ color: contrastingInk(colors.errorFill), fontSize: badgeDigit, fontWeight: '700' }}>{openUnreadCount > 99 ? '99+' : String(openUnreadCount)}</Text>
              </View>
            ) : null}
            <Ionicons name="chevron-down" size={22} color={contrastingInk(colors.primary)} />
          </AppPressable>
        ) : null}

        {(pinnedMsg || pinnedMsgList.length > 0) ? (() => {
          const currentPin = pinnedMsgList.length > 0 ? pinnedMsgList[pinnedMsgIdx % pinnedMsgList.length] : null;
          // v4.32.576: закрепление, чья своя копия не открывается ключом
          // данных, раньше показывалось пустой строкой — неотличимо от
          // сообщения без текста. Подставляется только показ; text остаётся
          // пустым и наружу (пересылка, копирование) не уходит.
          const displayPin = currentPin ?? (pinnedMsg ? { id: pinnedMsg.id, text: pinnedMsg.text ?? '', unreadable: isUnreadableMessage(pinnedMsg) } : null);
          const displayPinUnreadable = isUnreadableMessage(displayPin);
          const total = Math.max(pinnedMsgList.length, pinnedMsg ? 1 : 0);
          return (
            <AppPressable
              style={[s.pinnedBar, { backgroundColor: colors.surfaceHigh, borderTopColor: colors.border }]}
              onPress={() => {
                if (total > 1) {
                  // Cycle through pinned messages
                  const nextIdx = (pinnedMsgIdx + 1) % total;
                  setPinnedMsgIdx(nextIdx);
                  const nextPin = pinnedMsgList[nextIdx];
                  if (nextPin) scrollToReply(nextPin.id);
                } else if (displayPin) {
                  scrollToReply(displayPin.id);
                }
              }}
              onLongPress={() => total > 1 ? setPinnedListVisible(true) : undefined}
            >
              <AppPressable
                hitSlop={8}
                onPress={() => total > 1 ? setPinnedListVisible(true) : undefined}
                style={{ marginRight: 6 }}
              >
                <Ionicons name="pin" size={14} color={colors.accent} />
              </AppPressable>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[s.pinnedLabel, { color: colors.accent }]}>Закреплённое</Text>
                  {total > 1 ? (
                    <Text style={{ fontSize: font.xs, color: colors.textMuted }}>{pinnedMsgIdx + 1}/{total}</Text>
                  ) : null}
                </View>
                <Text
                  style={[s.pinnedText, { color: displayPinUnreadable ? colors.textMuted : colors.textSecondary, fontStyle: displayPinUnreadable ? 'italic' : 'normal' }]}
                  numberOfLines={1}
                >{displayPinUnreadable ? UNREADABLE_MESSAGE_TEXT : displayPin?.text ?? ''}</Text>
              </View>
              <AppPressable hitSlop={12} onPress={() => {
                if (total > 1) {
                  setPinnedListVisible(true);
                } else {
                  void (async () => {
                    const res = await clearDmPinnedAndSync(peerB64);
                    announceDmPin(res.sync);
                    setPinnedMsgList(res.entries);
                    setPinnedMsg(null);
                  })();
                }
              }}>
                <Ionicons name={total > 1 ? 'list' : 'close'} size={16} color={colors.textMuted} />
              </AppPressable>
            </AppPressable>
          );
        })() : null}

        {scheduledMsgs.length > 0 ? (
          <AppPressable
            style={[s.pinnedBar, { backgroundColor: colors.surfaceHigh, borderTopColor: colors.border }]}
            onPress={() => setScheduledListVisible(true)}
          >
            <Ionicons name="time-outline" size={14} color={colors.accent} style={{ marginRight: 6 }} />
            <Text style={{ flex: 1, color: colors.accent, fontSize: 13 }}>
              {scheduledMsgs.length} запланированных сообщений
            </Text>
            <Ionicons name="chevron-forward" size={14} color={colors.accent} />
          </AppPressable>
        ) : null}

        {peerTyping && !isSavedMessages ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 6, gap: 8, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
            <View style={{ backgroundColor: colors.surfaceHigh, borderRadius: radius.xl, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 100 }}>
              <AnimatedDots dotColor={colors.textMuted} dotSize={6} dotSpacing={4} stepDurationMs={300} />
            </View>
          </View>
        ) : null}

        {replyTo ? (
          <View style={[s.replyBar, { backgroundColor: colors.surfaceHigh, borderLeftColor: colors.primary }]}>
            <View style={s.replyBarBody}>
              <Text style={[s.replyLabel, { color: colors.accent }]}>
                {replyTo.direction === 'in' ? localDisplayName || displayName : 'Вы'}
              </Text>
              <Text style={[s.replyPreview, { color: colors.textSecondary }]} numberOfLines={1}>
                {isVoiceMessage(replyTo.text ?? '') ? '🎤 Голосовое сообщение'
                  : isDocMessage(replyTo.text ?? '') ? '📄 Документ'
                  : isLocationMessage(replyTo.text ?? '') ? '📍 Геолокация'
                  : isGifMessage(replyTo.text ?? '') ? '🎞 GIF'
                  : (replyTo.text ?? '').startsWith(POLL_PREFIX) ? '📊 Опрос'
                  : isContactCard(replyTo.text ?? '') ? '👤 Контакт'
                  : (replyTo.text ?? '').startsWith('\x09vo:') ? '🔥 Одноразовое сообщение'
                  : (replyTo.text ?? '').startsWith('\x0cliveloc:') ? '📡 Живая геолокация'
                  : isForwardedMessage(replyTo.text ?? '') ? `↪ ${parseForwardedMessage(replyTo.text ?? '')?.originalText?.slice(0, 50) ?? 'Пересланное сообщение'}`
                  : replyTo.text}
              </Text>
            </View>
            <AppPressable onPress={() => setReplyTo(null)} style={s.replyClear} accessibilityRole="button" accessibilityLabel="Отменить ответ">
              <Ionicons name="close" size={18} color={colors.textMuted} />
            </AppPressable>
          </View>
        ) : null}

        {editTarget ? (
          <View style={[s.replyBar, { backgroundColor: colors.surfaceHigh, borderLeftColor: colors.accent }]}>
            <Ionicons name="pencil" size={16} color={colors.accent} style={{ marginRight: 8 }} />
            <View style={s.replyBarBody}>
              {/* v4.32.344: у подписи не было цвета вообще — Text по умолчанию
                  чёрный, и на тёмной поверхности «Редактирование:» не читалось. */}
              <Text style={[s.replyLabel, { color: colors.accent }]}>Редактирование:</Text>
              <Text style={[s.replyPreview, { color: colors.textSecondary }]} numberOfLines={1}>{editTarget.text}</Text>
            </View>
            <AppPressable onPress={() => { setEditTarget(null); setMsg(''); }} style={s.replyClear} accessibilityRole="button" accessibilityLabel="Отменить редактирование">
              <Ionicons name="close" size={18} color={colors.textMuted} />
            </AppPressable>
          </View>
        ) : null}

        {searchVisible ? (
          <View style={[s.searchBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TextInput
              placeholder="Поиск по сообщениям…"
              placeholderTextColor={colors.textMuted}
              value={searchQuery}
              onChangeText={(q) => { setSearchQuery(q); setSearchHitIdx(0); searchAnchorRef.current = null; }}
              style={[s.searchInput, { color: colors.text }]}
              autoFocus
              autoCapitalize="none"
            />
            {/* v4.32.581: пометка стоит до счётчика и живёт в обеих его ветках —
                «0/0» без неё выдавало непрочитанную историю за пустой поиск. */}
            {searchScan && searchSkippedBadge(searchScan) ? (
              <Text
                style={{ fontSize: 12, color: colors.warning, marginRight: 4 }}
                accessibilityLabel={searchSkippedNotice(searchScan) ?? undefined}
              >
                {searchSkippedBadge(searchScan)}
              </Text>
            ) : null}
            {searchHitIndices.length > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                <Text style={{ fontSize: 12, color: colors.textMuted, minWidth: 44, textAlign: 'right' }}>
                  {hitLabel(searchHitIdx, searchHitIndices.length)}
                </Text>
                <AppPressable onPress={() => jumpToHit(stepHitIndex(searchHitIdx, searchHitIndices.length, -1))} hitSlop={8}>
                  <Ionicons name="chevron-up" size={20} color={colors.accent} />
                </AppPressable>
                <AppPressable onPress={() => jumpToHit(stepHitIndex(searchHitIdx, searchHitIndices.length, 1))} hitSlop={8}>
                  <Ionicons name="chevron-down" size={20} color={colors.accent} />
                </AppPressable>
              </View>
            ) : searchQuery.trim() ? (
              <Text style={{ fontSize: 12, color: colors.textMuted }}>0/0</Text>
            ) : null}
            <AppPressable
              onPress={() => { setSearchVisible(false); setSearchQuery(''); setSearchHitIdx(0); searchAnchorRef.current = null; }}
              accessibilityRole="button"
              accessibilityLabel="Закрыть поиск"
            >
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </AppPressable>
          </View>
        ) : null}

        {isSelecting ? (
          <View style={[s.selToolbar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
            <AppPressable style={s.selToolbarBtn} onPress={() => setSelectedIds(new Set())} accessibilityRole="button" accessibilityLabel="Отменить выбор сообщений">
              <Ionicons name="close" size={22} color={colors.text} />
              <Text style={[s.selToolbarLabel, { color: colors.text }]}>{selectedIds.size}</Text>
            </AppPressable>
            <View style={s.selToolbarActions}>
              <AppPressable
                style={s.selToolbarBtn}
                onPress={() => {
                  const ids = [...selectedIds];
                  const msgs = lines.filter((m) => ids.includes(m.id));
                  if (msgs.length === 0) return;
                  Alert.alert('Удалить выбранные?', `${ids.length} сообщ.`, [
                    { text: 'Отмена', style: 'cancel' },
                    { text: 'Удалить', style: 'destructive', onPress: () => {
                      const svc = getMessagingService();
                      if (!svc) return;
                      runGuardedOp(async () => {
                        await Promise.all(ids.map((id) => svc.deleteMessageLocally(id)));
                        setSelectedIds(new Set());
                        void appendNewMessages();
                      }, 'Не удалось удалить сообщения', 'ui_chat_delete_selected_failed');
                    }},
                  ]);
                }}
              >
                <Ionicons name="trash-outline" size={22} color={colors.error} />
                <Text style={[s.selToolbarLabel, { color: colors.error }]}>Удалить</Text>
              </AppPressable>
              <AppPressable
                style={s.selToolbarBtn}
                onPress={() => {
                  const ids = [...selectedIds];
                  const selected = lines.filter((m) => ids.includes(m.id)).sort((a, b) => a.createdAt - b.createdAt);
                  if (selected.length === 0) return;
                  if (selected.length === 1) {
                    setForwardTarget(selected[0]);
                  } else {
                    // v4.32.240: раньше конверты склеивались через '\n\n', а
                    // разбор режет по первому переводу строки — получатель видел
                    // одну пересылку, в тело которой затесались байты '\x08fwd:'
                    // остальных. Теперь это один конверт со строками «Имя: текст».
                    setForwardBundleText(
                      makeForwardBundleText(
                        selected.map((m) => ({ senderName: m.direction === 'out' ? 'Я' : displayName, text: m.text ?? '' }))
                      )
                    );
                  }
                  setSelectedIds(new Set());
                }}
              >
                <Ionicons name="arrow-redo-outline" size={22} color={colors.accent} />
                <Text style={[s.selToolbarLabel, { color: colors.accent }]}>Переслать</Text>
              </AppPressable>
              <AppPressable
                style={s.selToolbarBtn}
                onPress={() => {
                  const ids = [...selectedIds];
                  const text = lines.filter((m) => ids.includes(m.id)).map((m) => m.text).join('\n\n');
                  Clipboard.setString(text);
                  showSuccess(COPIED_TEXT);
                  setSelectedIds(new Set());
                }}
              >
                <Ionicons name="copy-outline" size={22} color={colors.accent} />
                <Text style={[s.selToolbarLabel, { color: colors.accent }]}>{COPY_ACTION}</Text>
              </AppPressable>
              <AppPressable
                style={s.selToolbarBtn}
                onPress={() => {
                  const ids = [...selectedIds];
                  const msgs = lines.filter((m) => ids.includes(m.id));
                  const allStarred = msgs.every((m) => m.starred);
                  runGuardedOp(async () => {
                    const mod = await import('../../core/storage/local');
                    await Promise.all(msgs.map((m) => mod.setMessageStarred(m.id, !allStarred)));
                    setSelectedIds(new Set());
                    void appendNewMessages();
                  }, 'Не удалось изменить избранное', 'ui_chat_star_selected_failed');
                }}
              >
                {/* v4.32.384: соседние действия панели («Переслать»,
                    «Копировать») подписаны акцентом, а это — золотом мимо
                    палитры: 1.9:1 в светлой теме при пороге 4.5:1 для подписи.
                    Золото остаётся у самого знака в переписке, здесь — команда. */}
                <Ionicons name="star-outline" size={22} color={colors.accent} />
                <Text style={[s.selToolbarLabel, { color: colors.accent }]}>Звезда</Text>
              </AppPressable>
            </View>
          </View>
        ) : null}

        {emojiSuggestions.length > 0 && !isSelecting ? (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            style={[s.emojiStrip, { backgroundColor: colors.surface, borderTopColor: colors.border }]}
            contentContainerStyle={{ paddingHorizontal: 6, alignItems: 'center', gap: 2 }}
          >
            {emojiSuggestions.map(({ key, emoji }) => (
              <AppPressable
                key={key}
                style={[s.emojiSuggestBtn, { borderColor: colors.border }]}
                onPress={() => {
                  const replaced = msg.replace(/:([a-z0-9_]{2,})$/, emoji);
                  setMsg(replaced);
                }}
              >
                <Text style={s.emojiSuggestEmoji}>{emoji}</Text>
                <Text style={[s.emojiSuggestKey, { color: colors.textMuted }]}>{key}</Text>
              </AppPressable>
            ))}
          </ScrollView>
        ) : null}

        {chatCmdSuggestions.length > 0 && !isSelecting ? (
          <View style={{ backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
            {chatCmdSuggestions.map((c) => (
              <AppPressable
                key={c.cmd}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}
                onPress={() => { setMsg(c.cmd + ' '); setChatCmdFilter(null); }}
              >
                <Text style={{ color: colors.accent, fontWeight: '600', fontSize: 14, minWidth: 80 }}>{c.cmd}</Text>
                <Text style={{ color: colors.textMuted, fontSize: 13, flex: 1 }} numberOfLines={1}>{c.desc}</Text>
              </AppPressable>
            ))}
          </View>
        ) : null}
        {showFormatBar && !isSelecting ? (
          <View style={[s.formatBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
            {([
              { marker: '**', label: 'B', style: { fontWeight: '700' as const } },
              { marker: '_', label: 'I', style: { fontStyle: 'italic' as const } },
              { marker: '`', label: '<>', style: { fontFamily: mono } },
              { marker: '~~', label: 'S', style: { textDecorationLine: 'line-through' as const } },
              { marker: '||', label: '||', style: {} },
            ] as const).map(({ marker, label, style }) => (
              <AppPressable
                key={label}
                style={[s.formatBtn, { borderColor: colors.border }]}
                onPress={() => {
                  const sel = msgSelRef.current;
                  if (sel.start !== sel.end) {
                    const before = msg.slice(0, sel.start);
                    const selected = msg.slice(sel.start, sel.end);
                    const after = msg.slice(sel.end);
                    setMsg(`${before}${marker}${selected}${marker}${after}`);
                  } else {
                    const before = msg.slice(0, sel.start);
                    const after = msg.slice(sel.start);
                    setMsg(`${before}${marker}${marker}${after}`);
                  }
                }}
              >
                <Text style={[s.formatBtnText, { color: colors.text }, style]}>{label}</Text>
              </AppPressable>
            ))}
          </View>
        ) : null}

        {activeLiveLocId ? (() => {
          const liveLocInk = inkOn(colors, colors.successFill);
          return (
          <AppPressable
            style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.successFill, paddingHorizontal: 14, paddingVertical: 8, gap: 8 }}
            onPress={() => { stopLiveLocSession(activeLiveLocId); setActiveLiveLocId(null); }}
          >
            {/* v4.32.401: полоса была залита '#1b5e20' — материаловским зелёным
                мимо палитры, с белым текстом и мятной точкой поверх. Заливка
                взята из токена, всё остальное считается из неё. */}
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: liveLocInk.success }} />
            <Text style={{ color: liveLocInk.text, fontSize: 13, flex: 1, fontWeight: '600' }}>Живая геолокация активна — нажмите, чтобы остановить</Text>
            <Ionicons name="close-circle" size={18} color={liveLocInk.secondary} />
          </AppPressable>
          );
        })() : null}
        {composeLinkUrl && !composeLinkDismissed ? (
          <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4 }}>
              <View style={{ flex: 1 }}>
                {/* Ссылку набрал сам пользователь — предпросмотр грузим всегда. */}
                <LinkPreview url={composeLinkUrl} isOutgoing={false} fromPeer={false} />
              </View>
              <AppPressable
                onPress={() => { setComposeLinkDismissed(composeLinkUrl); setComposeLinkUrl(null); }}
                style={{ padding: 8 }}
                hitSlop={8}
              >
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </AppPressable>
            </View>
          </View>
        ) : null}
        <View style={[s.composer, { borderTopColor: colors.border, backgroundColor: colors.surface, display: isSelecting ? 'none' : 'flex' }]}>
          {/* v4.32.60: Attach (📎) — Telegram-style. Тап открывает AttachSheet-hub
              с 8 вкладками (Галерея / Камера / Файл / Геопозиция / GIF / Опрос / Ответ / Контакт).
              Long-press оставляем shortcut-ом на системный picker галереи. */}
          <AppPressable
            style={s.roundIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Прикрепить файл"
            android_ripple={{ color: colors.ripple, borderless: true, radius: 22 }}
            onLongPress={handlePickImage}
            onPress={() => setAttachSheetOpen(true)}
            delayLongPress={400}
            disabled={sending}
          >
            <Ionicons name="attach" size={26} color={colors.accent} />
          </AppPressable>
          {/* v4.32.58: pill-shaped capsule — TextInput + inline emoji + flash */}
          <View style={[s.inputPill, { backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}>
            <TextInput
              ref={msgInputRef}
              placeholder={isBlocked ? 'Контакт заблокирован' : 'Сообщение'}
              placeholderTextColor={colors.textMuted}
              editable={!isBlocked}
              value={msg}
              onSelectionChange={(e) => { msgSelRef.current = e.nativeEvent.selection; }}
              onFocus={() => { setShowFormatBar(true); setShowEmojiPanel(false); }}
              onBlur={() => setShowFormatBar(false)}
              onChangeText={(t) => {
                msgRef.current = t;
                setMsg(t);
                saveDraft(t);
                // v4.32.175: не слать typing-indicator в заблокированный контакт.
                if (t.length > 0 && peerB64 && !isBlocked) {
                  if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
                  typingDebounceRef.current = setTimeout(() => {
                    void getMessagingService()?.sendTypingIndicator(peerB64);
                  }, 400);
                }
                // Detect slash command at start
                if (t.startsWith('/') && !t.includes(' ')) {
                  setChatCmdFilter(t.slice(1).toLowerCase());
                } else {
                  setChatCmdFilter(null);
                }
                // Detect URL for compose-time link preview (debounced)
                if (composeLinkTimerRef.current) clearTimeout(composeLinkTimerRef.current);
                composeLinkTimerRef.current = setTimeout(() => {
                  const url = extractFirstUrl(t);
                  if (url && url !== composeLinkDismissed) {
                    setComposeLinkUrl(url);
                  } else if (!url) {
                    setComposeLinkUrl(null);
                    setComposeLinkDismissed(null);
                  }
                }, 600);
              }}
              style={[s.pillText, { color: colors.text }]}
              multiline
              maxLength={MAX_MESSAGE_TEXT}
            />
            {msg.length > 3500 ? (
              <Text style={{ alignSelf: 'flex-end', marginBottom: 14, marginRight: 4, fontSize: font.xs, color: msg.length > 4000 ? colors.error : colors.textMuted }}>
                {MAX_MESSAGE_TEXT - msg.length}
              </Text>
            ) : null}
            {/* Inline emoji toggle — справа внутри пилюли */}
            <AppPressable
              style={s.pillInlineBtn}
              accessibilityRole="button"
              accessibilityLabel={showEmojiPanel ? 'Показать клавиатуру' : 'Открыть эмодзи'}
              accessibilityState={{ expanded: showEmojiPanel }}
              android_ripple={{ color: colors.ripple, borderless: true, radius: 20 }}
              onPress={() => {
                setShowEmojiPanel((v) => !v);
                if (!showEmojiPanel) {
                  requestAnimationFrame(() => {
                    Keyboard.dismiss();
                  });
                }
              }}
            >
              {/* v4.32.533: значок из того же набора, что и соседи по пилюле.
                  Литерал '😊' рисовался системным шрифтом эмодзи: на Android это
                  Noto Color Emoji, на вебе — что окажется у пользователя, и рядом
                  с однотонным Ionicons он выглядел вставкой из другого места. */}
              <Ionicons name={showEmojiPanel ? 'keypad-outline' : 'happy-outline'} size={20} color={colors.accent} />
            </AppPressable>
            {/* Inline flash (быстрые ответы) — справа внутри пилюли */}
            <AppPressable
              style={s.pillInlineBtn}
              accessibilityRole="button"
              accessibilityLabel="Быстрые ответы"
              android_ripple={{ color: colors.ripple, borderless: true, radius: 20 }}
              onPress={() => {
                setQuickRepliesVisible(true);
                requestAnimationFrame(() => {
                  void listQuickReplies(activeProfileId).then((list) => {
                    setQuickRepliesList(list);
                  });
                });
              }}
            >
              <Ionicons name="flash-outline" size={20} color={colors.accent} />
            </AppPressable>
          </View>
          {/* Voice / Send OUTSIDE pill, RIGHT — Telegram-style */}
          {!msg.trim() ? (
            <VoiceRecorderButton
              onRecorded={(r) => void sendVoice(r)}
              disabled={sending}
            />
          ) : null}
          <AppPressable
            style={[s.roundIconBtn, { backgroundColor: msg.trim() ? colors.primary : 'transparent', display: msg.trim() ? 'flex' : 'none' }]}
            accessibilityRole="button"
            accessibilityLabel="Отправить сообщение"
            android_ripple={{ color: rippleOn(colors.primary), borderless: true, radius: 22 }}
            onPress={send}
            onLongPress={() => { if (msg.trim()) setScheduleVisible(true); }}
            delayLongPress={600}
            disabled={sending}
          >
            {sending ? (
              <ActivityIndicator color={contrastingInk(colors.primary)} />
            ) : (
              <Ionicons name="send" size={20} color={contrastingInk(colors.primary)} />
            )}
          </AppPressable>
        </View>
        {showEmojiPanel && !isSelecting ? (
          <EmojiPanel
            onEmoji={(emoji) => {
              const sel = msgSelRef.current;
              const before = msg.slice(0, sel.end);
              const after = msg.slice(sel.end);
              setMsg(`${before}${emoji}${after}`);
            }}
            colors={colors}
          />
        ) : null}
      </View>

      <ChatQuickRepliesModal
        visible={quickRepliesVisible}
        onClose={closeQuickReplies}
        onPick={pickQuickReplyFromModal}
        quickReplies={quickRepliesList}
      />

      <ReactionsModal
        visible={reactionsTarget !== null}
        onClose={() => setReactionsTarget(null)}
        onSelect={(emoji) => {
          if (reactionsTarget) applyReaction(reactionsTarget, emoji);
          setReactionsTarget(null);
        }}
        recentEmojis={recentReactions}
        onMoreEmojis={() => setReactionsMoreVisible(true)}
      />
      {/* Full emoji picker for reactions */}
      <ChatReactionsPickerModal
        visible={reactionsMoreVisible}
        onClose={closeReactionsMore}
        renderPanel={() => (
          <EmojiPanel
            onEmoji={(emoji) => {
              if (reactionsTarget) applyReaction(reactionsTarget, emoji);
              setReactionsMoreVisible(false);
              setReactionsTarget(null);
            }}
            colors={colors}
          />
        )}
      />
      {/* Android quick-react popup (replaces Alert.alert on Android) */}
      <ChatQuickReactModal
        target={quickReactMsg}
        onClose={() => setQuickReactMsg(null)}
        recentReactions={recentReactions}
        reactionEmojis={REACTION_EMOJIS as unknown as string[]}
        onPickReaction={(emoji) => { if (quickReactMsg) applyReaction(quickReactMsg, emoji); setQuickReactMsg(null); }}
        onOpenMore={() => { setReactionsTarget(quickReactMsg); setQuickReactMsg(null); }}
        onReply={() => { if (quickReactMsg) setReplyTo(quickReactMsg); setQuickReactMsg(null); }}
        onCopy={() => { if (quickReactMsg) { Clipboard.setString(quickReactMsg.text); showSuccess(COPIED_TEXT); } setQuickReactMsg(null); }}
        onForward={() => { if (quickReactMsg) setForwardTarget(quickReactMsg); setQuickReactMsg(null); }}
        onEdit={() => { if (quickReactMsg) { setEditTarget(quickReactMsg); setMsg(quickReactMsg.text); } setQuickReactMsg(null); }}
        onToggleStar={() => {
          const q = quickReactMsg;
          if (q) {
            runGuardedOp(async () => {
              await setMessageStarred(q.id, !q.starred);
              await appendNewMessages();
            }, 'Не удалось изменить избранное', 'ui_chat_star_failed');
          }
          setQuickReactMsg(null);
        }}
        onMarkUnread={() => { void import('../../core/storage/local').then((m) => m.markConversationUnread(peerB64, activeProfileId)).then(onBack); setQuickReactMsg(null); }}
        onShowInfo={() => { if (quickReactMsg) setMsgInfoTarget(quickReactMsg); setQuickReactMsg(null); }}
        onTranslate={() => { const q = quickReactMsg; setQuickReactMsg(null); if (q) translateRow(q.text ?? ''); }}
        onCopyLink={() => { const q = quickReactMsg; setQuickReactMsg(null); if (q) copyRowLink(q.id); }}
        pinned={quickReactMsg ? isRowPinned(quickReactMsg.id) : false}
        onTogglePin={() => { const q = quickReactMsg; setQuickReactMsg(null); if (q) toggleRowPin(q.id); }}
        onSelect={() => { const q = quickReactMsg; setQuickReactMsg(null); if (q) selectRow(q.id); }}
        canClosePoll={!!quickReactMsg && quickReactMsg.direction === 'out' && (quickReactMsg.text ?? '').startsWith(POLL_PREFIX)}
        onClosePoll={() => { const q = quickReactMsg; setQuickReactMsg(null); if (q) closeRowPoll(q.id); }}
        onRemind={() => {
          const q = quickReactMsg;
          setQuickReactMsg(null);
          if (!q) return;
          const preview = q.text.startsWith('\x01') ? 'Медиасообщение' : q.text.slice(0, 40);
          promptMessageReminder(preview, showSuccess, showError);
        }}
        onDelete={() => {
          const q = quickReactMsg;
          setQuickReactMsg(null);
          if (!q) return;
          const svc2 = getMessagingService();
          if (!svc2) return;
          const isOut2 = q.direction === 'out';
          Alert.alert('Удалить сообщение', '', [
            { text: 'Удалить у себя', style: 'destructive', onPress: () => runGuardedOp(async () => {
              await svc2.deleteMessageLocally(q.id);
              await appendNewMessages();
            }, 'Не удалось удалить сообщение', 'ui_chat_delete_local_failed') },
            ...(isOut2 ? [{ text: 'Удалить у всех', style: 'destructive' as const, onPress: () => runGuardedOp(async () => {
              const echo = await svc2.deleteMessageForEveryone(peerB64, q.id);
              void appendNewMessages();
              reportTwoSided(echo, 'delete');
            }, 'Не удалось удалить у всех', 'ui_chat_delete_everyone_failed') }] : []),
            { text: 'Отмена', style: 'cancel' },
          ]);
        }}
      />

      <ForwardModal
        visible={forwardTarget !== null}
        text={forwardTarget ? makeForwardText(forwardTarget.direction === 'out' ? 'Я' : displayName, forwardTarget.text ?? '') : ''}
        pair={pair}
        onClose={() => setForwardTarget(null)}
        onForwarded={() => setForwardTarget(null)}
      />
      <ForwardModal
        visible={forwardBundleText !== null}
        text={forwardBundleText ?? ''}
        pair={pair}
        onClose={() => setForwardBundleText(null)}
        onForwarded={() => setForwardBundleText(null)}
      />
      <ScheduleModal
        visible={scheduleVisible}
        onClose={() => setScheduleVisible(false)}
        onSchedule={(sendAt) => void doSchedule(sendAt)}
      />
      <MessageInfoModal
        msg={msgInfoTarget}
        onClose={() => setMsgInfoTarget(null)}
      />
      <ReactionDetailModal
        target={reactionDetail}
        contacts={allContacts}
        myDid={myDid}
        onClose={() => setReactionDetail(null)}
      />

      {/* Pinned messages list */}
      <ChatPinnedListModal
        visible={pinnedListVisible}
        onClose={closePinnedList}
        pinnedList={pinnedMsgList}
        onJumpTo={jumpToPinned}
        onUnpin={unpinFromList}
      />

      <DmPollCreatorModal
        visible={pollCreatorVisible}
        onClose={() => setPollCreatorVisible(false)}
        onCreate={(question, options, correctAnswer) => {
          if (!peerB64) return;
          const svc = getMessagingService();
          if (!svc) return;
          // v4.32.48: обработка PollValidationError (длина вопроса/вариантов, минимум 2 опции).
          let pollText: string;
          try {
            pollText = makePollText(question, options, correctAnswer);
          } catch (err) {
            Alert.alert('Ошибка опроса', userErrorText(err, 'Проверьте вопрос и варианты ответа'));
            return;
          }
          setSending(true);
          void svc.sendMessage(peerB64, pollText).then(() => { setSending(false); void appendNewMessages(); }).catch(() => setSending(false));
        }}
      />
      {peerB64 ? (
        <WallpaperPickerModal
          visible={wallpaperPickerVisible}
          peerB64={peerB64}
          current={wallpaper}
          onClose={() => setWallpaperPickerVisible(false)}
          onApply={(wp) => setChatWallpaper(wp)}
        />
      ) : null}
      {peerB64 ? (
        <SharedMediaModal
          visible={mediaGalleryVisible}
          contactPubB64={peerB64}
          ownerProfileId={activeProfileId}
          gateway={gateway}
          onClose={() => setMediaGalleryVisible(false)}
          onImagePress={openMedia}
        />
      ) : null}
      <ScheduledListModal
        visible={scheduledListVisible}
        onClose={closeScheduledList}
        scheduled={scheduledMsgs}
        onDelete={deleteScheduledFromModal}
      />

      {peerB64 && !isSavedMessages ? (
        <ContactInfoModal
          visible={contactInfoVisible}
          peerB64={peerB64}
          myPubB64={myPubB64}
          displayName={localDisplayName}
          onClose={() => setContactInfoVisible(false)}
          onRename={(n) => setLocalDisplayName(n)}
          activeProfileId={activeProfileId}
          gateway={gateway}
          isMuted={isMuted}
          mutedUntil={mutedUntil}
          onMuteChanged={(muted, until) => { setIsMuted(muted); setMutedUntil(until); }}
        />
      ) : null}

      {/* Starred messages bottom sheet */}
      <ChatStarredModal
        visible={starredVisible}
        onClose={closeStarred}
        entries={starredEntries as Array<{ message: ChatMessageRow }>}
        selfLabel="Вы"
        peerLabel={localDisplayName}
        onUnstar={unstarFromModal}
      />

      {/* v4.32.57: Telegram-style preview — бейджи 1..N, "+Добавить", счётчик. */}
      <MediaPreviewModal
        visible={pendingImageUris.length > 0}
        uris={pendingImageUris}
        caption={imageCaption}
        viewOnce={viewOncePending}
        maxImages={CHAT_MAX_IMAGES}
        onCaptionChange={setImageCaption}
        onViewOnceChange={(v) => setViewOncePending(v)}
        onRemoveAt={(i) => setPendingImageUris((u) => u.filter((_, j) => j !== i))}
        onClearAll={() => setPendingImageUris([])}
        onAddMore={() => { void pickImage(); }}
        onCancel={() => { setPendingImageUris([]); setImageCaption(''); setViewOncePending(false); }}
        onSend={() => {
          const uris = pendingImageUris;
          const caption = viewOncePending ? makeViewOnceText(imageCaption) : imageCaption;
          setPendingImageUris([]);
          setImageCaption('');
          setViewOncePending(false);
          if (caption) setMsg('');
          void sendWithMedia(uris, caption);
        }}
      />

      {mediaViewerElement}
      <GifPickerModal
        visible={gifPickerVisible}
        onClose={() => setGifPickerVisible(false)}
        onSelect={(gifText) => void sendGif(gifText)}
      />
      {/* v4.32.60: Telegram-style attach hub — 8 tabs с горизонтальным TabBar снизу */}
      <AttachSheet
        visible={attachSheetOpen}
        onClose={() => setAttachSheetOpen(false)}
        onPickGalleryAssets={handleAcceptGalleryAssets}
        onOpenCamera={handleCameraCapture}
        onOpenImagePicker={handlePickImage}
        onOpenDocumentPicker={pickDocument}
        onSendLocation={handleSendLocationOnce}
        onShareLiveLocation={handleShareLiveLocation}
        onOpenGifPicker={() => setGifPickerVisible(true)}
        onOpenPollComposer={() => setPollCreatorVisible(true)}
        onPickQuickReply={handlePickQuickReply}
        onShareContact={handleShareContact}
        profileId={activeProfileId}
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

      {/* Recently Deleted Messages Modal */}
      <ChatRecentlyDeletedModal
        visible={recentlyDeletedVisible}
        onClose={closeRecentlyDeleted}
        items={recentlyDeletedList}
        onRestore={restoreRecentlyDeleted}
      />
    </View>
    </KeyboardHost>
  );
}

// ─── Main ChatScreen export ───────────────────────────────────────────────────
function ChatScreenImpl({ pair, peerJump, popToListToken, onConversationClosed }: Props): React.ReactElement {
  // v4.32.16: активность читается внутри ChatThreadView через useTabRef() — здесь prop не нужен.
  const [openPeer, setOpenPeer] = useState<{ pubB64: string; displayName: string; jumpMsgId?: string } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const tabRef = useTabRef();

  // v4.32.228 (BUG-07): повторный тап по активному табу «Чаты» → возврат из
  // открытого диалога к списку чатов. App.tsx инкрементит popToListToken; здесь
  // закрываем openPeer. Стартовое значение не считаем сигналом (сравнение с ref).
  const popSeenRef = useRef(popToListToken ?? 0);
  useEffect(() => {
    const t = popToListToken ?? 0;
    if (t === popSeenRef.current) return;
    popSeenRef.current = t;
    setOpenPeer(null);
    onConversationClosed?.();
  }, [popToListToken, onConversationClosed]);

  // Jump from Contacts tab — optimistic: open immediately, update name after
  useEffect(() => {
    if (!peerJump?.peer) return;
    const pub = peerJump.peer;
    setOpenPeer({ pubB64: pub, displayName: shortIdentity(pub) });
    void listContacts().then((ctacts) => {
      const c = ctacts.find((x) => x.peerPublicKey === pub);
      if (c?.displayName) {
        setOpenPeer((prev) => (prev?.pubB64 === pub ? { ...prev, displayName: c.displayName } : prev));
      }
    });
  }, [peerJump?.token, peerJump?.peer]);

  // When any chat message is written, refresh the list
  useEffect(() => {
    const unsub = subscribeChatWrites(() => {
      if (tabRef.current === 'chat') setRefreshTick((t) => t + 1);
    });
    return unsub;
  }, [pair, tabRef]);

  if (openPeer) {
    return (
      // v4.32.109 K.11f: 'bottom' УБРАН. Safe-area снизу теперь у App.tsx (таббар или
      // spacer при tabsHidden). SafeScreen bottom внутри tabBody + таббар снаружи давали
      // ~96px двойной компенсации и гигантский пробел между композером и таббаром.
      <SafeScreen edges={['left', 'right']} style={{ flex: 1 }}>
        <ChatThreadView
          // v4.32.434: ключ по собеседнику. Переход из «Контактов» ставит нового
          // собеседника поверх старого, не заходя через null (см. эффект peerJump),
          // поэтому без ключа React оставлял ТОТ ЖЕ экземпляр: полсотни useState
          // переживали смену переписки. Набранный текст, цитата (а её превью —
          // копия чужого сообщения) и правка уезжали в чужой чат. Сброс каждого
          // поля вручную — правило в полусотне мест; ремоунт — в одном.
          key={openPeer.pubB64}
          pair={pair}
          peerB64={openPeer.pubB64}
          displayName={openPeer.displayName}
          onBack={() => {
            setOpenPeer(null);
            setRefreshTick((t) => t + 1);
            onConversationClosed?.();
          }}
          initialJumpMsgId={openPeer.jumpMsgId}
        />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen edges={['left', 'right']} style={{ flex: 1 }}>
      <ChatListScreen
        pair={pair}
        onOpenChat={(pubB64, displayName) => setOpenPeer({ pubB64, displayName })}
        onOpenChatAt={(pubB64, displayName, msgId) => setOpenPeer({ pubB64, displayName, jumpMsgId: msgId })}
        refreshTick={refreshTick}
      />
    </SafeScreen>
  );
}

// IB-02 (v4.32.227): legacy/leaked envelopes that were stored WITHOUT their
// leading control byte (e.g. bare `grp:{...}` / `voice:{...}` from older builds)
// bypass the prefix detectors above and would otherwise render their raw JSON —
// leaking a member pubkey + a local file:// media path into the bubble. These
// JSON-shaped prefixes are never legitimate user-typed text, so detect them and
// render a friendly placeholder instead. New messages always carry the control
// byte; this only neutralises pre-existing rows at render time.
const LEAKED_GROUP_ENVELOPE_RE = /^(?:grp|grpr):\{/;
const LEGACY_MEDIA_ENVELOPE_RE = /^(voice|doc|loc|liveloc|vo):\{/;
function isLeakedGroupEnvelope(text: string): boolean {
  return LEAKED_GROUP_ENVELOPE_RE.test(text);
}
function legacyMediaPlaceholder(text: string): string | null {
  const m = text.match(LEGACY_MEDIA_ENVELOPE_RE);
  if (!m) return null;
  switch (m[1]) {
    case 'voice': return 'Голосовое сообщение';
    case 'doc': return 'Файл';
    case 'loc': return 'Геолокация';
    case 'liveloc': return 'Живая геолокация';
    case 'vo': return 'Одноразовое сообщение';
    default: return 'Медиасообщение';
  }
}






const s = StyleSheet.create({
  // v4.32.532: шапка диалога стала той же стеклянной капсулой, что и шапка
  // списка и таббар. Разные шапки на соседних экранах читаются как разные
  // приложения. Оговорка та же, что у таббара: капсула стоит в потоке, лента
  // под неё не уезжает, размывается фон, а не сообщения.
  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
    borderRadius: radius.xl,
    gap: 8,
    ...elevation.card,
  },
  backBtn: { padding: 8 },
  headerInfo: { flex: 1 },
  headerName: { fontSize: font.lg, fontWeight: '600', letterSpacing: -0.2 },
  headerStatus: { fontSize: font.xs, marginTop: 1 },
  headerRight: { flexDirection: 'row', gap: 4 },
  headerIconBtn: { padding: 8 },
  bubbleRow: { flexDirection: 'row', marginBottom: spacing.sm, alignItems: 'center' },
  bubbleOut: { justifyContent: 'flex-end' },
  bubbleIn: { justifyContent: 'flex-start' },
  selCircle: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  selToolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 8 },
  selToolbarBtn: { alignItems: 'center', gap: 3, paddingHorizontal: 6 },
  selToolbarLabel: { fontSize: font.xs, fontWeight: '600' },
  selToolbarActions: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  // v4.32.530: пузырь был скруглён одинаково со всех четырёх сторон, и
  // сторону отправителя приходилось искать по краю экрана. Угол у основания
  // срезан до 4: это единственная деталь, по которой «моё» и «его» различимы,
  // даже когда лента сжата, а цвета выключены высокой контрастностью.
  bubble: { maxWidth: '80%', borderRadius: radius.lg, padding: spacing.md },
  // v4.32.532: якорный угол был 4 — при скруглении 22 это уже не «хвостик»,
  // а скол. Пузырь должен читаться округлым целиком, поэтому угол у автора
  // только приглушён до sm, а не срезан.
  bubbleAnchorOut: { borderBottomRightRadius: radius.sm },
  bubbleAnchorIn: { borderBottomLeftRadius: radius.sm },
  bubbleText: { fontSize: font.md },
  messageFooter: { flexDirection: 'row', alignItems: 'center', marginTop: 4, minHeight: 16 },
  messageFooterOut: { justifyContent: 'flex-end' },
  messageFooterIn: { justifyContent: 'flex-start' },
  // Без цвета: он приходит от поверхности (см. footerInk). Оставленный здесь
  // «запасной» цвет и есть та ловушка, из-за которой оба этих текста годами
  // рисовались одним серым на четырёх разных фонах.
  messageTime: { fontSize: font.xs, marginRight: 4, fontVariant: ['tabular-nums'] },
  editedLabel: { fontSize: font.xs, fontStyle: 'italic' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', paddingVertical: 6, paddingHorizontal: 6, gap: 4, borderTopWidth: StyleSheet.hairlineWidth },
  // v4.32.58: Telegram-style pill composer — TextInput в капсуле с inline emoji,
  // attach/mic/send — круглые кнопки снаружи (слева/справа).
  inputPill: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: radius.md, paddingLeft: spacing.md, paddingRight: 2, minHeight: TOUCH_TARGET_MIN },
  pillText: { flex: 1, paddingVertical: 10, paddingRight: 6, maxHeight: 100, fontSize: font.md },
  pillInlineBtn: { width: 36, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  roundIconBtn: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  // legacy (ещё используется в некоторых местах ChatScreen — оверлеях и т.п.)
  inputGrow: { flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, maxHeight: 100, fontSize: 15 },
  iconBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  sendBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  scrollToBottomBtn: {
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
  mediaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  typingRow: { paddingHorizontal: 16, paddingBottom: 4 },
  typingText: { fontSize: 12, fontStyle: 'italic' },
  pinnedBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  pinnedLabel: { fontSize: font.xs, fontWeight: '600', marginBottom: 1 },
  pinnedText: { fontSize: 13 },
  quotedBlock: { flexDirection: 'row', alignItems: 'stretch', borderRadius: radius.md, marginBottom: 6, overflow: 'hidden' },
  quotedBar: { width: 3 },
  quotedText: { flex: 1, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4, fontStyle: 'italic' },
  replyBar: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 6, marginHorizontal: 10, marginBottom: 4, borderLeftWidth: 3 },
  replyBarBody: { flex: 1 },
  replyLabel: { fontSize: font.xs, fontWeight: '600', marginBottom: 2 },
  replyPreview: { fontSize: 13 },
  replyClear: { padding: 4 },
  searchBar: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6, marginHorizontal: 10, marginBottom: 4, gap: 8 },
  searchInput: { flex: 1, fontSize: 14 },
  formatBar: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, gap: 4 },
  formatBtn: { width: 36, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1 },
  formatBtnText: { fontSize: 14 },
  emojiStrip: { borderTopWidth: StyleSheet.hairlineWidth, maxHeight: 52 },
  emojiSuggestBtn: { alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 2 },
  emojiSuggestEmoji: { fontSize: 20 },
  emojiSuggestKey: { fontSize: font.xs, marginTop: 1 },
});

// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: React.memo — предотвращает re-render при каждом setTab в App.tsx (v4.32.5).
export const ChatScreen = React.memo(ChatScreenImpl);
