/**
 * ChatListScreen — список диалогов в стиле Telegram.
 * Показывает все переписки с превью последнего сообщения, счётчиком непрочитанных,
 * временем, индикаторами закрепления и беззвучного режима.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TextInput,
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
  PanResponder,
  Vibration,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { AppModal as Modal } from '../components/AppModal';
import { SafeScreen } from '../components/SafeScreen';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AnimatedDots } from '../components/AnimatedDots';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { profileManager } from '../../core/identity/profileManager';
import { addContact, deleteContact, listContacts, parseContactId, subscribeContactsChanged, type Contact } from '../../core/social/contacts';
import { getMessagingService } from '../../core/social/messaging';
import { previewLabelForText } from '../../core/social/messagePreview';
import { UNREADABLE_DRAFT_TEXT, UNREADABLE_MESSAGE_TEXT, UNREADABLE_REACTIONS_TEXT } from '../../core/storage/unreadableText';
import { draftIsUnreadable, hasReadableDraft } from '../../core/social/draftGuard';
import { searchSkippedNotice, type SearchScan } from '../../core/storage/searchScan';
import { matchesSearch } from '../../core/social/searchableText';
import { searchReactionChip, UNREADABLE_REACTION_MARK } from '../../core/social/searchReactionChip';
import {
  listConversations,
  listArchivedConversations,
  setConversationPinned,
  setConversationArchived,
  setConversationMuted,
  setConversationMutedUntil,
  markConversationRead,
  markConversationUnread,
  markAllConversationsRead,
  searchMessages,
  setConversationColorTag,
  clearChatHistory,
  type ConversationRow,
  type MessageSearchResult,
} from '../../core/storage/local';
import { subscribeChatWrites } from '../../core/storage/local';
import {
  FOLDER_COLORS,
  FOLDER_NAME_MAX_LEN,
  loadFolderNames,
  removeFolderName,
  setFolderName,
  type FolderNames,
} from '../../core/storage/chatFolders';
// v4.32.168: зеркалим mute в muteStore (источник правды для FCM gate).
import { setMuted as muteSet, unmute as muteUnset } from '../../core/notifications/muteStore';
import { showError, showSuccess } from '../components/userFeedback';
import { useTheme } from '../ThemeContext';
import { StoriesRow } from '../components/StoriesRow';
import { GlassSurface } from '../components/GlassSurface';
import { useIpfsGateway, useResolvedMediaUrl } from './chat-components/useResolvedMediaUrls';
import { usePresence } from '../hooks/usePresence';
import NetInfo from '@react-native-community/netinfo';
import { initiateCall, getCurrentCall } from '../../core/social/callService';
import { contactLabel, nameInitial } from '../../core/social/contactLabel';
import { avatarShape, badgeDigit, contrastingInk, elevation, font, identityAvatar, inkOn, radius, scrim, spacing } from '../theme';
import { formatListTime, formatSearchTime } from '../time/listTime';
import { shortIdentity } from '../identity/shortId';
import { muteRemainingLabel } from '../time/durationLabel';
import { userErrorText } from '../components/userErrorText';

export const SAVED_MESSAGES_KEY = '__saved_messages__';

export type ChatListProps = {
  /** Keypair текущего профиля — нужен для addContact и Saved Messages. */
  pair?: KeyPairBytes;
  /** Открыть диалог с этим контактом. */
  onOpenChat: (peerPubB64: string, displayName: string) => void;
  /** Открыть диалог и перейти к конкретному сообщению (из поиска). */
  onOpenChatAt?: (peerPubB64: string, displayName: string, msgId: string) => void;
  /** Тик для принудительного обновления (новое сообщение снаружи). */
  refreshTick?: number;
};

type ConversationItem = ConversationRow & {
  displayName: string;
  /** v4.32.247: фото контакта из его же конверта профиля (см. profileSync). */
  avatarCid?: string;
};

/**
 * v4.32.247: кружок с буквой — только запасной вариант. Если контакт прислал
 * фото профиля (см. profileSync), показываем его: раньше фото собеседника не
 * было видно нигде, потому что профиль уходил только в выключенный IPFS.
 */
function AvatarCircle({ name, size = 48, avatarCid }: { name: string; size?: number; avatarCid?: string }): React.ReactElement {
  const gateway = useIpfsGateway();
  const uri = useResolvedMediaUrl(avatarCid, gateway);
  const letter = nameInitial(name);
  // v4.32.399: буква писалась цветом `colors.text`, подобранным под фон
  // страницы. В светлой теме это почти чёрный на кружке 40%-й светлоты —
  // 2.4:1, буквы в списке чатов там не видно. Чернила считаются из заливки.
  const { fill, ink } = identityAvatar(name || '?');
  const shape = avatarShape(size);
  if (uri) {
    return <Image source={{ uri }} style={[avatarStyles.tile, shape]} accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={[avatarStyles.tile, shape, { backgroundColor: fill }]}>
      <Text style={[avatarStyles.letter, { fontSize: size * 0.42, color: ink }]}>{letter}</Text>
    </View>
  );
}

const avatarStyles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { fontWeight: '600' },
});

// v4.32.238: подпись сообщения — одна на проект (см. messagePreview.ts).
const formatPreview = previewLabelForText;

interface ConvRowProps {
  item: ConversationItem;
  onPress: (item: ConversationItem) => void;
  onLongPress: (item: ConversationItem) => void;
  onSwipeArchive?: (item: ConversationItem) => void;
  onSwipeRead?: (item: ConversationItem) => void;
  onSwipePin?: (item: ConversationItem) => void;
}

function ConvRowImpl({
  item,
  onPress: onPressRaw,
  onLongPress: onLongPressRaw,
  onSwipeArchive: onSwipeArchiveRaw,
  onSwipeRead: onSwipeReadRaw,
  onSwipePin: onSwipePinRaw,
}: ConvRowProps): React.ReactElement {
  // Stage C.4: bind item once so inner PanResponder/AppPressable see stable
  // zero-arg callbacks. Parent passes stable (item) => void refs so memo holds.
  const onPress = useCallback(() => onPressRaw(item), [onPressRaw, item]);
  const onLongPress = useCallback(() => onLongPressRaw(item), [onLongPressRaw, item]);
  const onSwipeArchive = useMemo(
    () => (onSwipeArchiveRaw ? () => onSwipeArchiveRaw(item) : undefined),
    [onSwipeArchiveRaw, item],
  );
  const onSwipeRead = useMemo(
    () => (onSwipeReadRaw ? () => onSwipeReadRaw(item) : undefined),
    [onSwipeReadRaw, item],
  );
  const onSwipePin = useMemo(
    () => (onSwipePinRaw ? () => onSwipePinRaw(item) : undefined),
    [onSwipePinRaw, item],
  );
  const { colors } = useTheme();
  const presence = usePresence(item.contactPubB64 ?? '');
  const isOut = item.lastMessageDirection === 'out';
  /**
   * v4.32.583: черновик не открылся ключом данных. Пустая строка на его
   * месте выглядела как «черновика нет» — а он есть, и его нельзя ни
   * показать, ни молча затереть. См. draftGuard.
   */
  const draftReadable = hasReadableDraft(item.draftText, item.draftUnreadable);
  const draftUnreadable = draftIsUnreadable(item.draftUnreadable);
  const preview = draftReadable
    ? `Черновик: ${item.draftText}`
    : formatPreview(item.lastMessagePreview ?? '');
  /**
   * v4.32.580: подпись последней реплики не открылась ключом данных. Без
   * пометки такая строка выглядела как переписка, в которой ничего не писали,
   * — и «в сети» вместо подписи только укрепляло эту ложь. Черновик свой и
   * читается отдельно, поэтому он пометку перебивает.
   */
  const previewUnreadable = !item.draftText && item.lastMessagePreviewUnreadable === true;
  const isOnline = presence.bucket === 'online';
  const [isTyping, setIsTyping] = React.useState(false);
  const typingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    const svc = getMessagingService();
    if (!svc || !item.contactPubB64) return;
    const unsub = svc.onTyping(item.contactPubB64, () => {
      setIsTyping(true);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => setIsTyping(false), 3000);
    });
    return () => {
      unsub();
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [item.contactPubB64]);
  const swipeAnim = useRef(new Animated.Value(0)).current;
  const swipedRef = useRef(false);

  // Thresholds: short right (55-90) = archive, long right (>90) = pin; left = read/unread
  const ARCHIVE_THRESH = 55;
  const PIN_THRESH = 90;
  const READ_THRESH = 55;

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.8,
    onPanResponderMove: (_, g) => {
      if (swipedRef.current) return;
      const clamped = Math.max(-100, Math.min(120, g.dx));
      swipeAnim.setValue(clamped);
    },
    onPanResponderRelease: (_, g) => {
      if (swipedRef.current) return;
      if (g.dx >= PIN_THRESH && onSwipePin) {
        Vibration.vibrate(30);
        swipedRef.current = true;
        Animated.timing(swipeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => { swipedRef.current = false; });
        onSwipePin();
      } else if (g.dx >= ARCHIVE_THRESH && onSwipeArchive) {
        Vibration.vibrate(20);
        swipedRef.current = true;
        Animated.timing(swipeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => { swipedRef.current = false; });
        onSwipeArchive();
      } else if (g.dx <= -READ_THRESH && onSwipeRead) {
        Vibration.vibrate(20);
        swipedRef.current = true;
        Animated.timing(swipeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => { swipedRef.current = false; });
        onSwipeRead();
      } else {
        Animated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
      }
    },
    onPanResponderTerminate: () => {
      Animated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
    },
  })).current;

  // Swipe hint: green (archive) at 55+, blue (pin) at 90+ on right; gray (read) on left
  const rightHintColor = swipeAnim.interpolate({
    inputRange: [0, PIN_THRESH, 120],
    outputRange: [colors.successFill, colors.successFill, colors.primary],
    extrapolate: 'clamp',
  });

  // Icons for swipe hints
  const archiveIconOpacity = swipeAnim.interpolate({ inputRange: [0, ARCHIVE_THRESH, PIN_THRESH], outputRange: [0, 1, 0], extrapolate: 'clamp' });
  const pinIconOpacity = swipeAnim.interpolate({ inputRange: [ARCHIVE_THRESH, PIN_THRESH, 120], outputRange: [0, 0.4, 1], extrapolate: 'clamp' });
  const readIconOpacity = swipeAnim.interpolate({ inputRange: [-100, -READ_THRESH, 0], outputRange: [1, 1, 0], extrapolate: 'clamp' });
  const leftHintWidth = swipeAnim.interpolate({ inputRange: [-100, 0], outputRange: [100, 0], extrapolate: 'clamp' });

  return (
    <View style={{ overflow: 'hidden' }}>
      {/* Right swipe hints (archive → pin) */}
      <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: swipeAnim, overflow: 'hidden', justifyContent: 'center', alignItems: 'flex-start', paddingLeft: 16 }}>
        <Animated.View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: rightHintColor }} />
        {/* v4.32.402: цвет у эмодзи не задаётся — глиф цветной сам по себе, и
            вписанное здесь '#fff' ни на что не влияло; оно лишь выглядело
            гарантией читаемости, которой не было. */}
        <Animated.Text style={{ fontSize: 22, zIndex: 1, position: 'absolute', left: 16, opacity: archiveIconOpacity }}>📁</Animated.Text>
        <Animated.Text style={{ fontSize: 22, zIndex: 1, position: 'absolute', left: 16, opacity: pinIconOpacity }}>📌</Animated.Text>
      </Animated.View>
      {/* Left swipe hint (mark read/unread) */}
      <Animated.View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: leftHintWidth, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 16 }}>
        {/* «✓» — обычный текстовый глиф, он красится. Заливка стала непрозрачной:
            прежнее `colors.primary + 'cc'` смешивалось с фоном списка, а такой
            цвет уже не посчитать — значит, и читаемость галочки не гарантировать. */}
        <Animated.Text style={{ color: contrastingInk(colors.primary), fontSize: 22, opacity: readIconOpacity }}>
          {item.unreadCount > 0 ? '✓' : '📩'}
        </Animated.Text>
      </Animated.View>
    <Animated.View style={{ transform: [{ translateX: swipeAnim }] }} {...panResponder.panHandlers}>
    <AppPressable
      style={({ pressed }) => [
        rowStyles.row,
        { backgroundColor: pressed ? colors.surfaceHigh : colors.background },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
    >
      {item.colorTag ? (
        <View style={{ width: 3, alignSelf: 'stretch', backgroundColor: item.colorTag, borderRadius: radius.sm, marginRight: 8, marginLeft: -4 }} />
      ) : null}
      <View style={rowStyles.avatarWrap}>
        <AvatarCircle name={item.displayName} avatarCid={item.avatarCid} />
        {isOnline ? <View style={[rowStyles.onlineDot, { backgroundColor: colors.success, borderColor: colors.background }]} /> : null}
      </View>
      <View style={rowStyles.body}>
        <View style={rowStyles.top}>
          <View style={rowStyles.nameRow}>
            {item.pinned ? (
              <Ionicons name="pin" size={13} color={colors.textMuted} style={{ marginRight: 3 }} />
            ) : null}
            <Text style={[rowStyles.name, { color: colors.text }]} numberOfLines={1}>
              {item.displayName}
            </Text>
          </View>
          <View style={rowStyles.timeRow}>
            {isOut ? (
              <Ionicons
                name={item.unreadCount === 0 ? 'checkmark-done' : 'checkmark'}
                size={14}
                color={colors.accent}
                style={{ marginRight: 2 }}
              />
            ) : null}
            <Text style={[rowStyles.time, { color: colors.textMuted }]}>
              {formatListTime(item.lastMessageAt)}
            </Text>
          </View>
        </View>
        <View style={rowStyles.bottom}>
          <View style={rowStyles.previewWrap}>
            {!isTyping && isOut && !draftReadable && !draftUnreadable ? (
              <Text style={[rowStyles.outArrow, { color: colors.textMuted }]}>Вы: </Text>
            ) : null}
            {isTyping ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}>
                <AnimatedDots dotColor={colors.primary} dotSize={4} dotSpacing={5} stepDurationMs={200} />
                <Text style={[rowStyles.preview, { color: colors.accent, fontStyle: 'italic' }]} numberOfLines={1}>
                  набирает текст
                </Text>
              </View>
            ) : draftReadable ? (
              <Text style={[rowStyles.preview, { color: colors.error }]} numberOfLines={1}>
                {`Черновик: ${item.draftText}`}
              </Text>
            ) : draftUnreadable ? (
              <Text style={[rowStyles.preview, { color: colors.warning, fontStyle: 'italic' }]} numberOfLines={1}>
                {UNREADABLE_DRAFT_TEXT}
              </Text>
            ) : previewUnreadable ? (
              <Text style={[rowStyles.preview, { color: colors.textMuted, fontStyle: 'italic' }]} numberOfLines={1}>
                {UNREADABLE_MESSAGE_TEXT}
              </Text>
            ) : (
              <Text style={[rowStyles.preview, { color: colors.textSecondary }]} numberOfLines={1}>
                {presence.bucket === 'online' && !preview ? 'в сети' : preview}
              </Text>
            )}
          </View>
          <View style={rowStyles.badgeRow}>
            {item.muted ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 4 }}>
                <Ionicons name="notifications-off-outline" size={14} color={colors.textMuted} />
                {item.mutedUntil != null ? (
                  <Text style={{ fontSize: font.xs, color: colors.textMuted, marginLeft: 2 }}>
                    {muteRemainingLabel(item.mutedUntil)}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {item.unreadCount > 0 ? (() => {
              // v4.32.402: заливок у счётчика две, а цифра была одна и белая.
              // Чернила считаются от той заливки, которая выпала.
              const badgeFill = item.muted ? colors.mutedFill : colors.primary;
              return (
              <View style={[rowStyles.badge, { backgroundColor: badgeFill }]}>
                <Text style={[rowStyles.badgeText, { color: contrastingInk(badgeFill) }]}>
                  {item.unreadCount > 99 ? '99+' : String(item.unreadCount)}
                </Text>
              </View>
              );
            })() : null}
          </View>
        </View>
      </View>
    </AppPressable>
    </Animated.View>
    </View>
  );
}

const ConvRow = memo(ConvRowImpl);

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  avatarWrap: { position: 'relative' },
  onlineDot: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 13,
    height: 13,
    borderRadius: radius.full,
    borderWidth: 2,
  },
  body: { flex: 1, gap: 3 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nameRow: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  name: { fontSize: font.md, fontWeight: '600', flex: 1, letterSpacing: -0.1 },
  timeRow: { flexDirection: 'row', alignItems: 'center' },
  time: { fontSize: font.xs, fontVariant: ['tabular-nums'] },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  previewWrap: { flexDirection: 'row', flex: 1, alignItems: 'center' },
  outArrow: { fontSize: 13 },
  preview: { fontSize: font.sm, flex: 1 },
  badgeRow: { flexDirection: 'row', alignItems: 'center' },
  // v4.32.394: заливка — на месте вызова, из палитры. В StyleSheet её быть не
  // может: пользователь выбирает акцент в настройках, а StyleSheet считается
  // один раз при загрузке модуля.
  badge: {
    borderRadius: radius.sm,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Цвет — на месте вызова: он зависит от заливки, а та бывает разной (см. 394).
  badgeText: { fontSize: badgeDigit, fontWeight: '700', fontVariant: ['tabular-nums'] },
});

const savedStyles = StyleSheet.create({
  iconCircle: {
    ...avatarShape(48),
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// ─── Add Contact Modal ────────────────────────────────────────────────────────
function AddContactModal({
  visible,
  pair,
  onClose,
  onAdded,
}: {
  visible: boolean;
  pair?: KeyPairBytes;
  onClose: () => void;
  onAdded: (peerPubB64: string, displayName: string) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [keyInput, setKeyInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [profileCid, setProfileCid] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setKeyInput(''); setNameInput(''); setProfileCid(''); };

  const submit = async () => {
    const key = keyInput.trim();
    if (!key) { Alert.alert('AirChat', 'Введите ID (did:key:… или base64)'); return; }
    if (!pair) { Alert.alert('AirChat', 'Пара ключей не готова'); return; }
    // v4.32.31: универсальный парсер — теперь AddContactModal принимает и DID, и base64.
    const pk = parseContactId(key);
    if (!pk) { Alert.alert('AirChat', 'Не удалось распознать ID. Ожидается did:key:… или base64 открытого ключа.'); return; }
    const pkB64 = Buffer.from(pk).toString('base64');
    const minePk = Buffer.from(pair.publicKey).toString('base64');
    if (pkB64 === minePk) { Alert.alert('AirChat', 'Нельзя добавить самого себя как контакт'); return; }
    // v4.32.44: жёсткая защита от дубликатов — один адрес не может быть в списке дважды.
    // Ранее addContact молча перезаписывал displayName у уже существующего контакта,
    // что приводило к «фантомному» повторному добавлению. Теперь показываем явный отказ
    // и даём возможность открыть чат или удалить старую запись.
    try {
      const existing = (await listContacts()).find((c) => c.peerPublicKey === pkB64);
      if (existing) {
        Alert.alert(
          'Контакт уже добавлен',
          `«${existing.displayName}» уже в списке контактов. Открыть чат или удалить его?`,
          [
            { text: 'Отмена', style: 'cancel' },
            {
              text: 'Открыть чат',
              onPress: () => { onAdded(pkB64, existing.displayName); onClose(); },
            },
            {
              text: 'Удалить',
              style: 'destructive',
              onPress: () => {
                void (async () => {
                  try {
                    await deleteContact(pkB64);
                    showSuccess('Контакт удалён');
                  } catch (e) {
                    showError(userErrorText(e, 'Не удалось удалить контакт'));
                  }
                })();
              },
            },
          ]
        );
        return;
      }
    } catch {
      /* list failure — fall through to addContact */
    }
    setBusy(true);
    try {
      const name = nameInput.trim() || 'Новый контакт';
      await addContact(pair, pk, name, profileCid.trim() || undefined);
      await getMessagingService()?.refreshSubscriptions();
      await getMessagingService()?.syncHistoryFromPeer(pkB64, 100);
      showSuccess('Контакт добавлен');
      onAdded(pkB64, name);
      reset();
      onClose();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось добавить контакт'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {/* v4.32.42: SafeScreen — header не должен уходить под статус-бар. */}
      <SafeScreen edges={['top', 'left', 'right']} style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[acStyles.root, { backgroundColor: colors.background }]}>
          <View style={[acStyles.header, { borderBottomColor: colors.border }]}>
            <AppPressable onPress={() => { reset(); onClose(); }} style={acStyles.cancelBtn}>
              <Text style={{ color: colors.accent, fontSize: 16 }}>Отмена</Text>
            </AppPressable>
            <Text style={[acStyles.title, { color: colors.text }]}>Новый чат</Text>
            <AppPressable onPress={() => void submit()} style={acStyles.doneBtn} disabled={busy}>
              {busy ? <ActivityIndicator color={colors.accent} /> : (
                <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>Готово</Text>
              )}
            </AppPressable>
          </View>
          <View style={acStyles.body}>
            <Text style={[acStyles.label, { color: colors.textSecondary }]}>ID собеседника (did:key:… или base64)</Text>
            <TextInput
              style={[acStyles.input, { color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
              value={keyInput}
              onChangeText={setKeyInput}
              placeholder="did:key:z6Mk… или base64…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <Text style={[acStyles.label, { color: colors.textSecondary }]}>Имя (необязательно)</Text>
            <TextInput
              style={[acStyles.input, { color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
              value={nameInput}
              onChangeText={setNameInput}
              placeholder="Как отображать имя"
              placeholderTextColor={colors.textMuted}
            />
            <Text style={[acStyles.label, { color: colors.textSecondary }]}>CID профиля в облаке (необязательно)</Text>
            <TextInput
              style={[acStyles.input, { color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
              value={profileCid}
              onChangeText={setProfileCid}
              placeholder="Qm… или baf…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
      </SafeScreen>
    </Modal>
  );
}

const acStyles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cancelBtn: { minWidth: 70 },
  doneBtn: { minWidth: 70, alignItems: 'flex-end' },
  title: { fontSize: 17, fontWeight: '600' },
  body: { padding: 20, gap: 8 },
  label: { fontSize: 13, marginBottom: 2, marginTop: 12 },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
});

export function ChatListScreen({ pair, onOpenChat, onOpenChatAt, refreshTick }: ChatListProps): React.ReactElement {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [globalSearchResults, setGlobalSearchResults] = useState<MessageSearchResult[]>([]);
  /**
   * v4.32.581: сколько сообщений поиск не смог прочитать. Без этого числа
   * «ничего не найдено» звучало одинаково и когда искомого правда нет, и
   * когда ключ данных не открыл всю переписку целиком.
   */
  const [globalSearchScan, setGlobalSearchScan] = useState<SearchScan | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // v4.32.532: шапка ушла в оверлей, поэтому её высоту больше не занимает
  // поток — список обязан знать, сколько сверху отступить, чтобы первая строка
  // не оказалась навсегда под стеклом.
  const [topInset, setTopInset] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0);
  const [addContactVisible, setAddContactVisible] = useState(false);
  const [broadcastVisible, setBroadcastVisible] = useState(false);
  const [broadcastSelected, setBroadcastSelected] = useState<Set<string>>(new Set());
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [broadcastSending, setBroadcastSending] = useState(false);
  const [filterTab, setFilterTab] = useState<string>('all');
  const [colorPickerItem, setColorPickerItem] = useState<ConversationItem | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  // Папки чатов: цвет метки → название. Хранение, разбор и границы —
  // в core/storage/chatFolders (v4.32.294).
  const [folderNames, setFolderNames] = useState<FolderNames>({});
  const [renameFolderColor, setRenameFolderColor] = useState<string | null>(null);
  const [renameFolderInput, setRenameFolderInput] = useState('');

  const myPubB64 = useMemo(
    () => (pair ? Buffer.from(pair.publicKey).toString('base64') : null),
    [pair]
  );

  const searchAnim = useRef(new Animated.Value(0)).current;

  const activeProfileId = useCallback(
    () => profileManager.getActiveProfile()?.id ?? 1,
    []
  );

  const loadData = useCallback(async () => {
    const pid = activeProfileId();
    const [convsRaw, ctactsRaw] = await Promise.all([
      showArchived ? listArchivedConversations(pid) : listConversations(pid),
      listContacts(),
    ]);
    if (!showArchived) {
      const archived = await listArchivedConversations(pid);
      setArchivedCount(archived.length);
    }

    // v4.32.31: self-chat «Сохранённые сообщения» показывается ТОЛЬКО в закреплённом
    // заголовке (ListHeaderComponent), а в обычном списке чатов и в списке контактов
    // — фильтруется. Критерий: peerPublicKey === myPubB64.
    const mine = pair ? Buffer.from(pair.publicKey).toString('base64') : null;
    const convs = mine ? convsRaw.filter((c) => c.contactPubB64 !== mine) : convsRaw;
    const ctacts = mine ? ctactsRaw.filter((c) => c.peerPublicKey !== mine) : ctactsRaw;

    const contactMap = new Map<string, Contact>();
    for (const c of ctacts) contactMap.set(c.peerPublicKey, c);
    setContacts(ctacts);

    // Merge: include conversations that have messages + contacts with no history
    const convMap = new Map<string, ConversationRow>();
    for (const c of convs) convMap.set(c.contactPubB64, c);

    // Build display list: conversations first (sorted by lastMessageAt), then contacts with no conv
    const convItems: ConversationItem[] = convs.map((c) => ({
      ...c,
      displayName: contactMap.get(c.contactPubB64)?.displayName || shortIdentity(c.contactPubB64),
      avatarCid: contactMap.get(c.contactPubB64)?.avatarCid,
    }));

    // Contacts with no conversation yet
    for (const ct of ctacts) {
      if (!convMap.has(ct.peerPublicKey)) {
        convItems.push({
          contactPubB64: ct.peerPublicKey,
          ownerProfileId: pid,
          unreadCount: 0,
          draftText: null,
          pinned: false,
          archived: false,
          muted: false,
          mutedUntil: null,
          lastMessageAt: 0,
          lastMessagePreview: null,
          lastMessageDirection: null,
          pinnedMessageId: null,
          disappearAfterMs: null,
          colorTag: null,
          displayName: ct.displayName,
          avatarCid: ct.avatarCid,
        });
      }
    }

    setConversations(convItems);
  }, [activeProfileId, showArchived, pair]);

  useEffect(() => {
    void loadData();
  }, [loadData, refreshTick]);

  // Названия папок принадлежат профилю, поэтому перечитываются вместе со
  // списком: до v4.32.294 запись была общей, и смена аккаунта вкладки не меняла.
  useEffect(() => {
    let alive = true;
    void loadFolderNames().then((names) => {
      if (alive) setFolderNames(names);
    });
    return () => { alive = false; };
  }, [refreshTick]);

  /**
   * Одна дорога записи для всех трёх случаев — переименовать, сохранить с
   * пустым полем, удалить папку. До v4.32.294 это были три ветки в двух
   * обработчиках JSX, и ни одна не смотрела, легла ли запись: вкладка исчезала
   * с экрана и возвращалась после перезапуска.
   */
  const applyFolderName = useCallback(async (color: string, name: string) => {
    const next = name.trim() ? await setFolderName(color, name) : await removeFolderName(color);
    setFolderNames(next);
    // Вкладку удалённой папки нужно отпустить, иначе список останется
    // отфильтрованным по метке, которой в шапке уже нет.
    if (!next[color]) setFilterTab((t) => (t === color ? 'all' : t));
    setRenameFolderColor(null);
  }, []);

  useEffect(() => {
    const unsub = subscribeChatWrites(() => void loadData());
    const unsubContacts = subscribeContactsChanged(() => void loadData());
    return () => { unsub(); unsubContacts(); };
  }, [loadData]);

  // Network connectivity status
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setIsOffline(state.isConnected === false);
    });
    return () => unsub();
  }, []);

  const toggleSearch = useCallback(() => {
    const toVisible = !searchVisible;
    setSearchVisible(toVisible);
    Animated.timing(searchAnim, {
      toValue: toVisible ? 1 : 0,
      duration: 200,
      easing: Easing.ease,
      useNativeDriver: false,
    }).start();
    if (!toVisible) setSearchQuery('');
  }, [searchVisible, searchAnim]);

  const filtered = useMemo(() => {
    let list = conversations;
    if (filterTab === 'unread') list = list.filter((c) => c.unreadCount > 0);
    else if (filterTab === 'pinned') list = list.filter((c) => c.pinned);
    else if (filterTab === 'muted') list = list.filter((c) => c.muted);
    else if (filterTab !== 'all' && filterTab.startsWith('#')) {
      // Custom folder tab — filter by color tag
      list = list.filter((c) => c.colorTag === filterTab);
    }
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        // Превью хранится сырым конвертом — сравнивать надо с видимой частью,
        // иначе запрос «cid»/«http» поднимал каждый диалог с вложением.
        matchesSearch(c.lastMessagePreview ?? '', q)
    );
  }, [conversations, searchQuery, filterTab]);

  // Stage C.4: stable per-item callbacks for ConvRow so its memo holds.
  const convKeyExtractor = useCallback((item: ConversationItem) => item.contactPubB64, []);
  const handleConvPress = useCallback(
    (item: ConversationItem) => onOpenChat(item.contactPubB64, item.displayName),
    [onOpenChat],
  );
  const handleConvSwipeArchive = useCallback(
    (item: ConversationItem) => {
      void setConversationArchived(item.contactPubB64, activeProfileId(), !item.archived).then(loadData);
    },
    [activeProfileId, loadData],
  );
  const handleConvSwipePin = useCallback(
    (item: ConversationItem) => {
      void setConversationPinned(item.contactPubB64, activeProfileId(), !item.pinned).then(loadData);
    },
    [activeProfileId, loadData],
  );
  const handleConvSwipeRead = useCallback(
    (item: ConversationItem) => {
      if (item.unreadCount > 0) {
        void markConversationRead(item.contactPubB64, activeProfileId()).then(loadData);
      } else {
        void import('../../core/storage/local')
          .then((m) => m.markConversationUnread(item.contactPubB64, activeProfileId()))
          .then(loadData);
      }
    },
    [activeProfileId, loadData],
  );

  // Global message search with debounce
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setGlobalSearchResults([]);
      setGlobalSearchScan(null);
      return;
    }
    const pid = activeProfileId();
    // v4.32.184 (Round-14 #11): bail when unmounted or query changed so stale
    // CPU-heavy scan results don't clobber the current state.
    let alive = true;
    const timer = setTimeout(() => {
      void searchMessages(searchQuery, pid, 30).then((r) => {
        if (!alive) return;
        setGlobalSearchResults(r.items);
        setGlobalSearchScan(r.scan);
      });
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [searchQuery, activeProfileId]);

  const showConvMenu = useCallback(
    (item: ConversationItem) => {
      const pid = activeProfileId();
      Alert.alert(item.displayName, '', [
        {
          text: '📞 Позвонить',
          onPress: () => {
            if (getCurrentCall()) { showError('Уже активен звонок'); return; }
            void initiateCall(item.contactPubB64, item.displayName, false)
              .then((ok) => { if (!ok) showError('Не удалось начать звонок'); })
              .catch(() => showError('Не удалось начать звонок'));
          },
        },
        {
          text: '🎥 Видеозвонок',
          onPress: () => {
            if (getCurrentCall()) { showError('Уже активен звонок'); return; }
            void initiateCall(item.contactPubB64, item.displayName, true)
              .then((ok) => { if (!ok) showError('Не удалось начать видеозвонок'); })
              .catch(() => showError('Не удалось начать видеозвонок'));
          },
        },
        {
          text: item.pinned ? 'Открепить' : 'Закрепить',
          onPress: () => {
            void setConversationPinned(item.contactPubB64, pid, !item.pinned).then(loadData);
          },
        },
        {
          text: item.muted ? 'Включить звук' : 'Беззвучно…',
          onPress: () => {
            if (item.muted) {
              void setConversationMuted(item.contactPubB64, pid, false)
                .then(() => muteUnset('chat', item.contactPubB64))
                .then(loadData);
            } else {
              const snooze = (ms: number | null) => async () => {
                const u = ms === null ? null : Date.now() + ms;
                await setConversationMutedUntil(item.contactPubB64, pid, u);
                await muteSet('chat', item.contactPubB64, u !== null ? { untilMs: u } : undefined);
                loadData();
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
          text: item.archived ? 'Разархивировать' : 'Архивировать',
          onPress: () => {
            void setConversationArchived(item.contactPubB64, pid, !item.archived).then(loadData);
          },
        },
        {
          text: item.unreadCount > 0 ? 'Отметить прочитанным' : 'Отметить непрочитанным',
          onPress: () => {
            if (item.unreadCount > 0) {
              void markConversationRead(item.contactPubB64, pid).then(loadData);
            } else {
              void markConversationUnread(item.contactPubB64, pid).then(loadData);
            }
          },
        },
        {
          text: item.colorTag ? 'Изменить метку' : 'Добавить метку',
          onPress: () => setColorPickerItem(item),
        },
        {
          text: 'Очистить историю',
          onPress: () => {
            Alert.alert('Очистить историю?', 'Все сообщения в этом диалоге будут удалены с вашего устройства.', [
              { text: 'Отмена', style: 'cancel' },
              {
                text: 'Очистить',
                style: 'destructive',
                onPress: () => {
                  void clearChatHistory(item.contactPubB64, pid).then(loadData);
                },
              },
            ]);
          },
        },
        { text: 'Отмена', style: 'cancel' },
      ]);
    },
    [activeProfileId, loadData]
  );

  const renderConv = useCallback(
    ({ item }: { item: ConversationItem }) => (
      <ConvRow
        item={item}
        onPress={handleConvPress}
        onLongPress={showConvMenu}
        onSwipeArchive={handleConvSwipeArchive}
        onSwipePin={handleConvSwipePin}
        onSwipeRead={handleConvSwipeRead}
      />
    ),
    [handleConvPress, showConvMenu, handleConvSwipeArchive, handleConvSwipePin, handleConvSwipeRead],
  );

  const searchBarHeight = searchAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 44],
  });

  // v4.32.402: кнопка отправки рассылки в отключённом состоянии заливалась
  // `colors.border` — токеном ВОЛОСЯНОЙ ЛИНИИ (та же подмена, что у дорожки
  // переключателя в 400-м): в светлой теме это давало почти невидимый кружок
  // с белой стрелкой поверх. Заливка взята из токена заливок, стрелка — из неё.
  const broadcastReady = broadcastMsg.trim().length > 0 && broadcastSelected.size > 0;
  const broadcastFill = broadcastReady ? colors.primary : colors.mutedFill;
  const broadcastInk = contrastingInk(broadcastFill);

  const s = makeStyles(colors);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <Modal visible={!!colorPickerItem} transparent animationType="fade" onRequestClose={() => setColorPickerItem(null)}>
        <AppPressable
          style={{ flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', padding: 24 }}
          onPress={() => setColorPickerItem(null)}
        >
          <AppPressable
            style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: 16 }}
            onPress={() => {}}
          >
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: 12 }}>
              Цветовая метка
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
              {FOLDER_COLORS.map((ct) => (
                <AppPressable
                  key={ct.value}
                  onPress={() => {
                    if (colorPickerItem) {
                      const pid = activeProfileId();
                      void setConversationColorTag(colorPickerItem.contactPubB64, pid, ct.value).then(loadData);
                    }
                    setColorPickerItem(null);
                  }}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: ct.value,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: colorPickerItem?.colorTag === ct.value ? 3 : 0,
                    borderColor: contrastingInk(ct.value),
                  }}
                >
                  {colorPickerItem?.colorTag === ct.value ? (
                    <Ionicons name="checkmark" size={20} color={contrastingInk(ct.value)} />
                  ) : null}
                </AppPressable>
              ))}
            </View>
            {colorPickerItem?.colorTag && !folderNames[colorPickerItem.colorTag] ? (
              <AppPressable
                onPress={() => {
                  const color = colorPickerItem?.colorTag;
                  setColorPickerItem(null);
                  if (color) {
                    setRenameFolderColor(color);
                    setRenameFolderInput('');
                  }
                }}
                style={{ paddingVertical: 6, alignItems: 'center' }}
              >
                <Text style={{ color: colors.accent, fontSize: 14 }}>Создать папку с этой меткой</Text>
              </AppPressable>
            ) : null}
            {colorPickerItem?.colorTag && folderNames[colorPickerItem.colorTag] ? (
              <AppPressable
                onPress={() => {
                  const color = colorPickerItem?.colorTag;
                  const name = color ? (folderNames[color] ?? '') : '';
                  setColorPickerItem(null);
                  if (color) {
                    setRenameFolderColor(color);
                    setRenameFolderInput(name);
                  }
                }}
                style={{ paddingVertical: 6, alignItems: 'center' }}
              >
                <Text style={{ color: colors.accent, fontSize: 14 }}>Переименовать папку «{colorPickerItem?.colorTag ? folderNames[colorPickerItem.colorTag] : ''}»</Text>
              </AppPressable>
            ) : null}
            {colorPickerItem?.colorTag ? (
              <AppPressable
                onPress={() => {
                  if (colorPickerItem) {
                    const pid = activeProfileId();
                    void setConversationColorTag(colorPickerItem.contactPubB64, pid, null).then(loadData);
                  }
                  setColorPickerItem(null);
                }}
                style={{ paddingVertical: 6, alignItems: 'center' }}
              >
                <Text style={{ color: colors.error, fontSize: 15 }}>Убрать метку</Text>
              </AppPressable>
            ) : null}
          </AppPressable>
        </AppPressable>
      </Modal>
      <AddContactModal
        visible={addContactVisible}
        pair={pair}
        onClose={() => setAddContactVisible(false)}
        onAdded={(pubB64, displayName) => {
          void loadData();
          onOpenChat(pubB64, displayName);
        }}
      />

      {/* Broadcast modal */}
      <Modal visible={broadcastVisible} transparent animationType="slide" onRequestClose={() => setBroadcastVisible(false)}>
        <View style={{ flex: 1, backgroundColor: scrim.modal }}>
          <View style={{ flex: 1, marginTop: 60, backgroundColor: colors.background, borderTopLeftRadius: 18, borderTopRightRadius: 18 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
              <AppPressable onPress={() => setBroadcastVisible(false)} style={{ marginRight: 12 }}>
                <Ionicons name="close" size={22} color={colors.text} />
              </AppPressable>
              <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: colors.text }}>Рассылка</Text>
              <Text style={{ fontSize: 13, color: colors.textMuted }}>{broadcastSelected.size} выбрано</Text>
            </View>
            <FlatList
              data={contacts}
              keyExtractor={(c) => c.peerPublicKey}
              style={{ flex: 1 }}
              renderItem={({ item: c }) => {
                const selected = broadcastSelected.has(c.peerPublicKey);
                return (
                  <AppPressable
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}
                    onPress={() => {
                      setBroadcastSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.peerPublicKey)) next.delete(c.peerPublicKey);
                        else next.add(c.peerPublicKey);
                        return next;
                      });
                    }}
                  >
                    <View style={{ ...avatarShape(36), alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? colors.primary : colors.surfaceHigh }}>
                      {selected
                        ? <Ionicons name="checkmark" size={18} color={contrastingInk(colors.primary)} />
                        : <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{nameInitial(c.displayName)}</Text>
                      }
                    </View>
                    <Text style={{ flex: 1, fontSize: 16, color: colors.text }}>{c.displayName}</Text>
                  </AppPressable>
                );
              }}
              ListEmptyComponent={<Text style={{ color: colors.textMuted, textAlign: 'center', padding: 24 }}>Нет контактов</Text>}
            />
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                <TextInput
                  style={{ flex: 1, borderWidth: 1, borderRadius: radius.xl, paddingHorizontal: 14, paddingVertical: 8, fontSize: 15, maxHeight: 100, color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }}
                  value={broadcastMsg}
                  onChangeText={setBroadcastMsg}
                  placeholder="Сообщение для рассылки…"
                  placeholderTextColor={colors.textMuted}
                  multiline
                />
                <AppPressable
                  style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: broadcastFill, alignItems: 'center', justifyContent: 'center' }}
                  disabled={!broadcastMsg.trim() || broadcastSelected.size === 0 || broadcastSending}
                  onPress={() => {
                    if (!broadcastMsg.trim() || broadcastSelected.size === 0) return;
                    setBroadcastSending(true);
                    void (async () => {
                      try {
                        // v4.32.335: раньше окно закрывалось и текст стирался по
                        // факту прохода по списку. sendMessage отвечает null,
                        // когда отправки не было (контакт заблокирован, часовой
                        // лимит), а сервис мог и вовсе не подняться — тогда цикл
                        // не выполнялся ни разу. Человек в обоих случаях видел
                        // закрывшееся окно и считал рассылку выполненной.
                        const svc = getMessagingService();
                        const text = broadcastMsg.trim();
                        let sent = 0;
                        for (const pubB64 of broadcastSelected) {
                          if (svc && (await svc.sendMessage(pubB64, text))) sent += 1;
                        }
                        const total = broadcastSelected.size;
                        if (sent === 0) {
                          // Текст и выбор не стираем: иначе набранное придётся
                          // вводить заново, а получателей — отмечать заново.
                          showError('Не удалось отправить ни одному контакту');
                          return;
                        }
                        if (sent < total) showError(`Отправлено ${sent} из ${total}`);
                        else showSuccess(`Отправлено: ${sent}`);
                        setBroadcastVisible(false);
                        setBroadcastMsg('');
                        setBroadcastSelected(new Set());
                        void loadData();
                      } finally {
                        setBroadcastSending(false);
                      }
                    })();
                  }}
                >
                  {broadcastSending
                    ? <ActivityIndicator size="small" color={broadcastInk} />
                    : <Ionicons name="send" size={18} color={broadcastInk} />
                  }
                </AppPressable>
              </View>
            </KeyboardAvoidingView>
          </View>
        </View>
      </Modal>

      {/* Header */}
      <View
        style={s.topOverlay}
        onLayout={(e) => setTopInset(e.nativeEvent.layout.height)}
      >
      {isOffline ? (() => {
        // v4.32.402: полоса заливалась '#616161' — серым мимо палитры, одним и
        // тем же в обеих темах. Заливка взята из токена, чернила — из заливки.
        const offlineInk = inkOn(colors, colors.mutedFill);
        return (
        <View style={{ backgroundColor: colors.mutedFill, paddingVertical: 6, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 }}>
          <Ionicons name="cloud-offline-outline" size={14} color={offlineInk.secondary} />
          <Text style={{ color: offlineInk.text, fontSize: 13, fontWeight: '500' }}>Нет соединения</Text>
        </View>
        );
      })() : null}
      <GlassSurface style={s.topChrome} variant="regular">
        <View style={s.header}>
          <Text style={s.title}>{showArchived ? 'Архив' : 'Чаты'}</Text>
          <View style={s.headerActions}>
            {showArchived ? (
              <AppPressable style={s.headerBtn} onPress={() => setShowArchived(false)} accessibilityLabel="Назад">
                <Ionicons name="arrow-back" size={22} color={colors.text} />
              </AppPressable>
            ) : null}
            <AppPressable style={s.headerBtn} onPress={toggleSearch} accessibilityLabel={searchVisible ? 'Закрыть поиск' : 'Поиск'}>
              <Ionicons name={searchVisible ? 'close' : 'search'} size={22} color={colors.text} />
            </AppPressable>
            {!showArchived && conversations.some((c) => c.unreadCount > 0) ? (
              <AppPressable
                style={s.headerBtn}
                onPress={() => {
                  const pid = activeProfileId();
                  void markAllConversationsRead(pid).then(loadData);
                }}
                onLongPress={() => {
                  Alert.alert('Архивировать прочитанные?', 'Все переписки без непрочитанных сообщений будут архивированы.', [
                    { text: 'Отмена', style: 'cancel' },
                    { text: 'Архивировать', onPress: () => {
                      const pid = activeProfileId();
                      const readConvs = conversations.filter((c) => c.unreadCount === 0 && !c.pinned && !c.archived);
                      void Promise.all(readConvs.map((c) => setConversationArchived(c.contactPubB64, pid, true))).then(() => void loadData());
                    }},
                  ]);
                }}
                delayLongPress={600}
                accessibilityLabel="Отметить всё прочитанным"
              >
                <Ionicons name="checkmark-done-outline" size={22} color={colors.text} />
              </AppPressable>
            ) : null}
            {!showArchived ? (
              <AppPressable
                style={s.headerBtn}
                onPress={() => setAddContactVisible(true)}
                onLongPress={() => { setBroadcastSelected(new Set()); setBroadcastMsg(''); setBroadcastVisible(true); }}
                delayLongPress={500}
                accessibilityLabel="Новый чат"
              >
                <Ionicons name="create-outline" size={22} color={colors.text} />
              </AppPressable>
            ) : null}
          </View>
        </View>

        {/* Search bar */}
        <Animated.View style={[s.searchWrap, { height: searchBarHeight, overflow: 'hidden' }]}>
          <View style={s.searchField}>
            <Ionicons name="search" size={18} color={colors.textMuted} />
            <TextInput
              style={s.searchInput}
              placeholder="Поиск"
              placeholderTextColor={colors.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              returnKeyType="search"
            />
          </View>
        </Animated.View>

        {/* Filter tabs */}
        {!showArchived && !searchVisible ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterContent}>
            {([
            { id: 'all', label: 'Все', badge: conversations.reduce((n, c) => n + (c.unreadCount > 0 ? 1 : 0), 0), color: null as string | null },
            { id: 'unread', label: 'Непрочит.', badge: conversations.filter((c) => c.unreadCount > 0).length, color: null },
            { id: 'pinned', label: 'Закреп.', badge: conversations.filter((c) => c.pinned && c.unreadCount > 0).length, color: null },
            { id: 'muted', label: 'Без звука', badge: conversations.filter((c) => c.muted && c.unreadCount > 0).length, color: null },
            // Custom folder tabs
            ...Object.entries(folderNames).map(([color, name]) => ({
              id: color,
              label: name,
              badge: conversations.filter((c) => c.colorTag === color && c.unreadCount > 0).length,
              color,
            })),
          ]).map((tab) => {
            const active = filterTab === tab.id;
            const showBadge = tab.badge > 0 && !active;
            return (
              <AppPressable
                key={tab.id}
                style={[s.filterTab, active && s.filterTabActive]}
                onPress={() => setFilterTab(tab.id)}
                onLongPress={() => {
                  if (tab.color) {
                    setRenameFolderColor(tab.color);
                    setRenameFolderInput(tab.label);
                  }
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {tab.color ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tab.color }} /> : null}
                  <Text style={[s.filterTabText, { color: active ? (tab.color ?? colors.accent) : colors.textMuted }]}>
                    {tab.label}
                  </Text>
                  {showBadge ? (
                    <View style={{ backgroundColor: tab.color ?? colors.primary, borderRadius: radius.md, minWidth: 16, paddingHorizontal: 4, alignItems: 'center' }}>
                      <Text style={{ color: contrastingInk(tab.color ?? colors.primary), fontSize: badgeDigit, fontWeight: '700' }}>{tab.badge > 99 ? '99+' : tab.badge}</Text>
                    </View>
                  ) : null}
                </View>
              </AppPressable>
            );
          })}
          </ScrollView>
        ) : null}
      </GlassSurface>
      </View>

      {/* Rename/delete folder modal */}
      <Modal visible={!!renameFolderColor} transparent animationType="fade" onRequestClose={() => setRenameFolderColor(null)}>
        <AppPressable style={{ flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', padding: 24 }} onPress={() => setRenameFolderColor(null)}>
          <AppPressable style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: 20, gap: 12 }} onPress={() => {}}>
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>Папка</Text>
            <TextInput
              value={renameFolderInput}
              onChangeText={setRenameFolderInput}
              placeholder="Название папки"
              placeholderTextColor={colors.textMuted}
              maxLength={FOLDER_NAME_MAX_LEN}
              style={{ backgroundColor: colors.surfaceHigh, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, color: colors.text, fontSize: 15 }}
            />
            <AppPressable
              style={{ backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}
              onPress={() => {
                if (!renameFolderColor) return;
                void applyFolderName(renameFolderColor, renameFolderInput);
              }}
            >
              <Text style={{ color: contrastingInk(colors.primary), fontWeight: '600' }}>Сохранить</Text>
            </AppPressable>
            <AppPressable
              onPress={() => {
                if (!renameFolderColor) return;
                void applyFolderName(renameFolderColor, '');
              }}
            >
              <Text style={{ color: colors.error, textAlign: 'center', fontSize: 15 }}>Удалить папку</Text>
            </AppPressable>
            <AppPressable onPress={() => setRenameFolderColor(null)}>
              <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 15 }}>Отмена</Text>
            </AppPressable>
          </AppPressable>
        </AppPressable>
      </Modal>

      <View style={{ flex: 1, paddingTop: topInset }}>
      {/* Conversation list */}
      {/* Global message search results */}
      {/* v4.32.581: строка о непрочитанном стоит ВЫШЕ выдачи и вне её условия —
          именно при нуле совпадений она и нужна. */}
      {searchQuery.length >= 2 && globalSearchScan && searchSkippedNotice(globalSearchScan) ? (
        <Text style={[s.globalSearchSkipped, { color: colors.warning }]}>
          {searchSkippedNotice(globalSearchScan)}
        </Text>
      ) : null}
      {searchQuery.length >= 2 && globalSearchResults.length > 0 ? (
        <View style={[s.globalSearchSection, { borderBottomColor: colors.border }]}>
          <Text style={[s.globalSearchTitle, { color: colors.textMuted }]}>Сообщения</Text>
          {globalSearchResults.map((r) => {
            const convItem = conversations.find((c) => c.contactPubB64 === r.contactPubB64);
            const name = contactLabel(convItem?.displayName, shortIdentity(r.contactPubB64));
            const isOut = r.message.direction === 'out';
            const preview = formatPreview(r.message.text).slice(0, 120);
            const qLower = searchQuery.toLowerCase();
            const matchIdx = preview.toLowerCase().indexOf(qLower);
            // v4.32.184 (Round-14 #2): reject null/primitive so Object.entries does not throw.
            // v4.32.509: правило разбора одно на все экраны — reactionMapPolicy.
            // v4.32.605: непрочитанный столбец больше не выдаёт себя за «реакций нет».
            const reactChip = searchReactionChip(r.message.reactions, r.message.reactionsUnreadable);
            const timeStr = formatSearchTime(r.message.createdAt);
            return (
              <AppPressable
                key={r.message.id}
                style={[s.globalSearchRow, { borderBottomColor: colors.border }]}
                onPress={() => onOpenChatAt ? onOpenChatAt(r.contactPubB64, name, r.message.id) : onOpenChat(r.contactPubB64, name)}
              >
                <Ionicons name="chatbubble-outline" size={20} color={colors.accent} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 1 }}>
                    <Text style={[s.globalSearchName, { color: colors.text, flex: 1 }]} numberOfLines={1}>{name}</Text>
                    {reactChip.kind === 'emoji' ? <Text style={{ fontSize: font.xs }}>{reactChip.text}</Text> : null}
                    {reactChip.kind === 'unreadable' ? (
                      <Text
                        style={{ fontSize: font.xs, color: colors.warning }}
                        accessibilityLabel={UNREADABLE_REACTIONS_TEXT}
                      >{UNREADABLE_REACTION_MARK}</Text>
                    ) : null}
                    <Text style={[s.globalSearchTime, { color: colors.textMuted }]}>{timeStr}</Text>
                  </View>
                  <Text style={[s.globalSearchPreview, { color: colors.textSecondary }]} numberOfLines={1}>
                    {isOut ? <Text style={{ color: colors.textMuted }}>{'Вы: '}</Text> : null}
                    {matchIdx >= 0 ? (
                      <>
                        <Text>{preview.slice(0, matchIdx)}</Text>
                        <Text style={{ color: colors.accent, fontWeight: '700' }}>{preview.slice(matchIdx, matchIdx + searchQuery.length)}</Text>
                        <Text>{preview.slice(matchIdx + searchQuery.length)}</Text>
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
        style={{ flex: 1 }}
        data={filtered}
        keyExtractor={convKeyExtractor}
        renderItem={renderConv}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={10}
        removeClippedSubviews={Platform.OS === 'android'}
        ItemSeparatorComponent={() => (
          <View style={[s.separator, { marginLeft: 76 }]} />
        )}
        ListHeaderComponent={
          !showArchived && !searchQuery && myPubB64 ? (
            <>
              <StoriesRow myPubB64={myPubB64} pair={pair} refreshTick={refreshTick} />
              <AppPressable
                style={({ pressed }) => [
                  rowStyles.row,
                  { backgroundColor: pressed ? colors.surfaceHigh : colors.background },
                ]}
                onPress={() => onOpenChat(myPubB64, 'Сохранённые сообщения')}
              >
                <View style={[savedStyles.iconCircle, { backgroundColor: colors.primary }]}>
                  <Ionicons name="bookmark" size={24} color={contrastingInk(colors.primary)} />
                </View>
                <View style={rowStyles.body}>
                  <View style={rowStyles.top}>
                    <View style={rowStyles.nameRow}>
                      <Ionicons name="pin" size={13} color={colors.textMuted} style={{ marginRight: 3 }} />
                      <Text style={[rowStyles.name, { color: colors.text }]}>Сохранённые сообщения</Text>
                    </View>
                  </View>
                  <Text style={[rowStyles.preview, { color: colors.textSecondary }]} numberOfLines={1}>
                    Заметки для себя
                  </Text>
                </View>
              </AppPressable>
              <View style={[s.separator, { marginLeft: 76 }]} />
            </>
          ) : null
        }
        ListEmptyComponent={
          searchQuery ? (
            <View style={s.empty}>
              <Text style={[s.emptyText, { color: colors.textMuted }]}>
                Ничего не найдено
              </Text>
            </View>
          ) : (
            <View style={s.empty}>
              <Ionicons name="chatbubbles-outline" size={52} color={colors.textMuted} />
              <Text style={[s.emptyText, { color: colors.textMuted }]}>
                {showArchived
                  ? 'Нет архивированных чатов'
                  : filterTab === 'unread'
                  ? 'Нет непрочитанных чатов'
                  : 'Нет переписок'}
              </Text>
              {!showArchived && filterTab === 'all' ? (
                <Text style={[s.emptyHint, { color: colors.textMuted }]}>
                  Нажмите ✎ вверху и вставьте ID собеседника — или откройте «Профиль» → «Контакты»
                </Text>
              ) : null}
            </View>
          )
        }
        ListFooterComponent={
          !showArchived && archivedCount > 0 ? (
            <AppPressable style={s.archiveRow} onPress={() => setShowArchived(true)}>
              <View style={[s.archiveIcon, { backgroundColor: colors.surfaceHigh }]}>
                <Ionicons name="archive-outline" size={22} color={colors.textSecondary} />
              </View>
              <Text style={[s.archiveName, { color: colors.text }]}>
                Архив
              </Text>
              <Text style={[s.archiveCount, { color: colors.textMuted }]}>
                {archivedCount}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </AppPressable>
          ) : null
        }
      />
      </View>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof import('../theme').resolveColors>) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    // v4.32.532: шапка снова плавающая капсула со стеклом. В 4.32.530 её
    // распластали по ширине ради «прибора»; направление сменилось — список
    // должен проезжать ПОД шапкой, иначе размывать нечего и стекло врёт.
    topOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
    },
    topChrome: {
      marginHorizontal: spacing.sm,
      marginTop: spacing.sm,
      borderRadius: radius.xl,
      paddingBottom: spacing.sm,
      ...elevation.card,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    title: { fontSize: font.xxl, fontWeight: '700', color: colors.text, letterSpacing: -0.5 },
    headerActions: { flexDirection: 'row', gap: 2 },
    headerBtn: {
      width: 40,
      height: 40,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchWrap: {
      paddingHorizontal: 12,
      justifyContent: 'center',
    },
    searchField: {
      minHeight: 38,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 13,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceHigh,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 7,
      color: colors.text,
      fontSize: font.md,
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
    emptyText: { fontSize: 16, fontWeight: '500' },
    emptyHint: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32 },
    archiveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      gap: spacing.md,
    },
    archiveIcon: {
      ...avatarShape(48),
      alignItems: 'center',
      justifyContent: 'center',
    },
    archiveName: { flex: 1, fontSize: font.md, fontWeight: '500' },
    archiveCount: { fontSize: font.sm, fontVariant: ['tabular-nums'] },
    // v4.32.530: пилюля в пилюле — вкладка-капсула внутри капсулы-полосы —
    // повторяла форму поиска и счётчиков и ничем от них не отличалась.
    // Подчёркивание занимает ту же высоту, но состояние «выбрано» читается
    // формой, а не ещё одной заливкой.
    filterRow: {
      flexShrink: 0,
      flexGrow: 0,
      height: 40,
    },
    filterContent: { paddingHorizontal: spacing.lg, alignItems: 'center', gap: spacing.lg },
    filterTab: {
      alignItems: 'center',
      justifyContent: 'center',
      height: 40,
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    filterTabActive: { borderBottomColor: colors.accent },
    filterTabText: { fontSize: font.sm, fontWeight: '600', letterSpacing: 0.2 },
    globalSearchSection: { borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 4 },
    globalSearchTitle: { fontSize: 12, fontWeight: '600', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, textTransform: 'uppercase' },
    globalSearchSkipped: { fontSize: 12, fontStyle: 'italic', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
    globalSearchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
    globalSearchName: { fontSize: 14, fontWeight: '600' },
    globalSearchPreview: { fontSize: 13, marginTop: 1 },
    globalSearchTime: { fontSize: font.xs, marginLeft: 8 },
  });
}
