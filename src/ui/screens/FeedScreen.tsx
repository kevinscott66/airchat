import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAsyncButton, useKeyedAsyncAction } from '../../core/hooks/useAsyncButton';
import { useTabRef } from '../TabRefContext';
import { useBackHandler } from '../../core/hooks/useBackHandler';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  RefreshControl,
  Modal,
  Image,
  ScrollView,
  Alert,
  Share,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Dimensions,
  Keyboard,
  Vibration,
  AppState,
  InteractionManager,
  type KeyboardEvent,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { AppPressable } from '../components/AppPressable';
import {
  feedCommentIsUnreadable,
  feedPostIsUnreadable,
  mayRepublishFeedPost,
  mayReuseFeedText,
  UNREADABLE_POST_ACTION_TEXT,
} from '../../core/social/feedPostGuard';
import { UNREADABLE_COMMENT_TEXT, UNREADABLE_NAME_TEXT, UNREADABLE_POST_TEXT } from '../../core/storage/unreadableText';
import { outwardName, shownName } from '../../core/social/unreadableName';
import { KeyboardHost } from '../components/KeyboardHost';
import { UserProfilePeek } from '../components/UserProfilePeek';
import { showPermissionDeniedAlert } from '../permissionAlert';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Network from 'expo-network';
import { Ionicons } from '@expo/vector-icons';
import { appleColorEmojiTextStyle } from '../emojiStyles';
import * as ImagePicker from 'expo-image-picker';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { loadConfig } from '../../core/config';
import { contactLabel, nameInitial } from '../../core/social/contactLabel';
import {
  loadFeedPosts,
  publishFeedPost,
  publishRepost,
  getUnreadFeedCount,
  markFeedPostRead,
  flushFeedPublishQueue,
  getFeedPublishQueueLength,
  flushFeedQueueNow,
  toggleAndBroadcastReaction,
  broadcastPollVote,
  resolveFeedMediaUris,
  addAndBroadcastComment,
  getFeedComments,
  deleteFeedComment,
  getFeedCommentCounts,
  setFeedPostBookmarked,
  listBookmarkedFeedPosts,
  setFeedPostArchived,
  listArchivedFeedPosts,
  deleteFeedPost,
  deleteFeedPostLocal,
  editFeedPost,
  getFeedPost,
  toggleCommentReaction,
  notifyFeedPostViewed,
  getFeedPostViewCountsMap,
  listFeedPostViewers,
  receiveFeedEnvelope,
  type FeedCommentRow,
} from '../../core/social/feedService';
import { subscribeToPostCommentsTopic } from '../../core/social/feedTransport';
import type { FeedViewerRow } from '../../core/storage/feedStorage';
import { profileManager } from '../../core/identity/profileManager';
import { getOwnDisplayName } from '../../core/identity/ownProfile';
import { listContacts, type Contact } from '../../core/social/contacts';
import { getMessagingService } from '../../core/social/messaging';
import type { FeedPostRow } from '../../core/storage/feedStorage';
import { log, measurePerformance } from '../../core/logger';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { SafeScreen } from '../components/SafeScreen';
import { showError, showSuccess } from '../components/userFeedback';
import { createReceiptClaims } from '../../core/social/receiptClaim';
import { readPlaceOnce } from '../../core/social/deviceLocation';
import { locationFailureText } from '../../core/social/locationFailure';
import { commentCountFromThread } from '../../core/social/commentCount';
import { RichText } from '../components/RichText';
import { LocationMessage } from '../components/LocationMessage';
import { FeedPostSkeleton } from '../components/SkeletonLoader';
import { type AppColors, badgeTint, contrastingInk, identityAvatar, inkOn, mediaScrim, nestedFill, reactionInk, readableInk, scrim } from '../theme';
import { GroupAvatar } from './groups-components/GroupAvatar';
import { useTheme } from '../ThemeContext';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { StoriesRow } from '../components/StoriesRow';
import { useMediaViewer } from '../components/MediaViewer';
import { makePollText, parsePollText, POLL_PREFIX, setPollVote, deletePollVote, getPollVotes, listGroups, insertGroupMessage, touchGroupConversation, type GroupRow } from '../../core/storage/local';
import { scopedKvGet } from '../../core/storage/profileScopedKv';
import { TRANSLATION_TARGET_LANG_KEY } from '../../core/storage/kvKeys';
import { fanoutGroupMessage } from '../../core/social/groupMessaging';
import { announceGroupSend } from '../groupSendAnnounce';
import {
  FEED_MAX_DOCS,
  FEED_MAX_IMAGES,
  clearComposeDraft as clearPersistedComposeDraft,
  loadComposeDraft,
  planComposeRestore,
  saveComposeDraft,
  selectComposeDocs,
} from '../../core/social/composeDraft';
import { getMutedAuthors, toggleMutedAuthor } from '../../core/social/mutedAuthors';
import { atTimestamp, hasMoreAfterRefresh, mergeByRowId, mergeListHead } from '../../core/storage/listHeadMerge';
import { decidePage, shouldApplyRows, type DbRead } from '../../core/storage/readResult';
import {
  acceptCommentList,
  appendOwnComment,
  commentListGrew,
  commentListUnchanged,
} from '../../core/social/commentThread';
import {
  buildTranslateUrl,
  parseTranslation,
  translateBlockMessage,
  translateBlockReason,
  translateFailureMessage,
} from '../../core/social/cloudTranslate';
import { cloudTranslateAllowed, setCloudTranslateAllowed } from '../../core/social/translateConsent';
import { LinkPreview, extractFirstUrl } from './ChatScreen';
import { calendarDaysAgo, isSameCalendarDay } from '../../core/time/calendarTime';
import { formatByteSize } from '../../core/media/byteSize';
import { Buffer } from 'buffer';
import { v4 as uuidv4 } from 'uuid';
import { shortIdentity } from '../identity/shortId';
import { clockTime, dayMonthShort, dayMonthShortTime } from '../../core/time/ruDateTime';
import { rawErrorText, userErrorText } from '../components/userErrorText';
import { GlassSurface } from '../components/GlassSurface';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const MODAL_HEIGHT_COLLAPSED = SCREEN_HEIGHT * 0.72;
const MODAL_HEIGHT_KEYBOARD = SCREEN_HEIGHT * 0.92;
const THUMB = 88;
// v4.32.54: Telegram/WhatsApp-style лимит прикрепляемых фото к одной публикации.
// Больше — превью теряет смысл (узкие квадраты, неудобный скролл), envelope раздувается.
// v4.32.292: живёт в core/social/composeDraft рядом со снимком черновика — он
// хранит те же пути к фото и обязан ограничивать их так же.

const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '👏', '🎉', '💯'];

// v4.32.52: геометка в ленте.
// Публикация через «Место» подшивает в хвост текста `\n\n📍 <lat>, <lng>` (см. onPublish).
// Раньше это отображалось просто строкой с координатами — юзер видел «59.9342, 30.3351»
// вместо карты. Helper вытаскивает координаты и очищенный текст, чтобы renderItem мог
// отрисовать <LocationMessage/> (карточка с OSM-tile и пином) вместо координат.
// Аддитивно к формату поста — старые клиенты по-прежнему увидят `📍 …` текстом.
const FEED_LOCATION_REGEX = /\n\n📍\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
function extractFeedLocationTag(
  text: string,
): { lat: number; lng: number; textWithout: string } | null {
  const m = text.match(FEED_LOCATION_REGEX);
  if (!m || m.index === undefined) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, textWithout: text.slice(0, m.index).replace(/\s+$/, '') };
}

// ─── Emoji shortcode autocomplete ────────────────────────────────────────────
const FEED_EMOJI_MAP: Record<string, string> = {
  smile: '😊', happy: '😄', laugh: '😂', joy: '😂', grin: '😁', lol: '🤣',
  sad: '😢', cry: '😭', sob: '😭', angry: '😠', rage: '😡', mad: '😤',
  heart: '❤️', love: '❤️', hearts: '💕', heartbeat: '💓', sparkling_heart: '💖',
  fire: '🔥', hot: '🔥', flame: '🔥', cool: '😎', sunglasses: '😎',
  thumbsup: '👍', thumbup: '👍', up: '👍', thumbsdown: '👎', down: '👎',
  clap: '👏', tada: '🎉', party: '🎉', celebrate: '🥳', congrats: '🎊',
  ok: '👌', yes: '✅', no: '❌', check: '✔️', x: '❌',
  star: '⭐', stars: '✨', sparkles: '✨', boom: '💥', explosion: '💥',
  wave: '👋', hi: '👋', bye: '👋', hello: '👋', hand: '✋',
  think: '🤔', thinking: '🤔', hmm: '🤔', facepalm: '🤦', shrug: '🤷',
  eyes: '👀', eye: '👁️', see: '👀', look: '👀', watch: '👀',
  sun: '☀️', moon: '🌙', cloud: '☁️', rain: '🌧️', snow: '❄️',
  dog: '🐶', cat: '🐱', bear: '🐻', panda: '🐼', fox: '🦊',
  pizza: '🍕', burger: '🍔', sushi: '🍣', cake: '🎂', coffee: '☕',
  beer: '🍺', wine: '🍷', cocktail: '🍸', drink: '🥤', water: '💧',
  music: '🎵', note: '🎵', guitar: '🎸', dance: '💃', microphone: '🎤',
  car: '🚗', plane: '✈️', rocket: '🚀', train: '🚂', bike: '🚲',
  money: '💰', cash: '💵', coin: '🪙', gem: '💎',
  book: '📚', read: '📖', write: '✏️', pencil: '✏️',
  phone: '📱', computer: '💻', laptop: '💻', camera: '📷', video: '🎥',
  gift: '🎁', balloon: '🎈', trophy: '🏆', medal: '🥇',
  lock: '🔒', key: '🔑', unlock: '🔓', secret: '🤫',
  muscle: '💪', strong: '💪', power: '⚡', energy: '⚡', lightning: '⚡',
  target: '🎯', goal: '⚽', soccer: '⚽', basketball: '🏀',
  100: '💯', hundred: '💯', perfect: '💯', poop: '💩',
  skull: '💀', ghost: '👻', alien: '👽', robot: '🤖',
  rainbow: '🌈', unicorn: '🦄', dragon: '🐉',
  pray: '🙏', bless: '🙏', wish: '🌠', luck: '🍀',
  clover: '🍀', flower: '🌸', rose: '🌹',
  ocean: '🌊', beach: '🏖️', mountain: '⛰️',
  world: '🌍', earth: '🌍', globe: '🌐',
  warning: '⚠️', danger: '🚨', stop: '🛑', info: 'ℹ️',
};
function getFeedEmojiSuggestions(text: string): { key: string; emoji: string }[] {
  const m = /:([a-z0-9_]{2,})$/.exec(text.toLowerCase());
  if (!m) return [];
  const q = m[1];
  const results: { key: string; emoji: string }[] = [];
  for (const [k, v] of Object.entries(FEED_EMOJI_MAP)) {
    if (k.startsWith(q)) results.push({ key: k, emoji: v });
    if (results.length >= 16) break;
  }
  return results;
}

// ─── Feed Poll Bubble ─────────────────────────────────────────────────────────

function FeedPollBubble({
  postId,
  pollText,
  myPubB64,
  ownerProfileId,
  pair,
  feedTick,
}: {
  postId: string;
  pollText: string;
  myPubB64: string;
  ownerProfileId: number;
  /** v4.32.51: ключ голосующего — для подписи feed_poll_vote envelope. */
  pair: KeyPairBytes;
  /** v4.32.51: бампается при входящем envelope (см. App.tsx/startFeedInboxListener callback).
   *  Добавлен в deps reload → счётчики голосов пересчитываются, когда голос контакта пришёл по сети. */
  feedTick: number;
}): React.ReactElement {
  const { t } = useTranslation();
  // v4.32.492: разбор опроса ЗАПОМИНАЕТСЯ. parsePollText собирает новый объект
  // на каждый вызов, а `poll` стоит в зависимостях `reload`, который дёргает
  // эффект ниже. Значит, круг замыкался: рендер → новый `poll` → новый
  // `reload` → эффект → setState новым массивом (по Object.is он никогда не
  // равен прежнему) → рендер. Пост-опрос в ленте держал JS-поток занятым
  // непрерывным чтением голосов из базы: телефон грелся, нажатия «залипали»,
  // батарея садилась — без единой видимой причины на экране.
  const poll = useMemo(() => parsePollText(pollText), [pollText]);
  const [voteCounts, setVoteCounts] = useState<number[]>([]);
  const [myVotes, setMyVotes] = useState<Set<number>>(new Set());
  const [totalVotes, setTotalVotes] = useState(0);

  // v4.32.130 (AUDIT P2): guard setState after unmount. `reload` is chained
  // from `vote()` after broadcastPollVote finishes — if user navigates away
  // during that await, reload would setState on a dead component.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const reload = useCallback(async () => {
    if (!poll) return;
    const votes = await getPollVotes(postId, ownerProfileId);
    if (!isMountedRef.current) return;
    const counts = poll.options.map((_, i) => votes.filter((v) => v.optionIndex === i).length);
    setVoteCounts(counts);
    // For total: count unique voters (not unique votes) for single-choice; for multi, count total votes
    setTotalVotes(poll.allowMultiple
      ? new Set(votes.map((v) => v.voterPubB64)).size
      : votes.length);
    const mine = new Set(votes.filter((v) => v.voterPubB64 === myPubB64).map((v) => v.optionIndex));
    setMyVotes(mine);
  }, [postId, ownerProfileId, myPubB64, poll]);

  // v4.32.51: feedTick в deps — при входящем feed_poll_vote envelope App.tsx бампает
  // feedTick → reload пересчитает голоса из обновлённой БД.
  useEffect(() => { void reload(); }, [reload, feedTick]);

  const vote = useCallback(async (optIdx: number) => {
    // v4.32.51: локальная запись голоса + broadcast по сети всем контактам.
    // До этого голос оставался только локально у голосующего → другие пиры видели "Всего: 1".
    // v4.32.534: запись голоса могла не пройти — база занята, транзакция
    // сорвана. Отказ уходил в неперехваченное отклонение обещания: галочка не
    // появлялась, ошибки не было, конверт не уходил — тап выглядел как
    // несработавший. Рассылаем только после того, как голос лёг в базу: иначе
    // контакты увидели бы голос, которого у нас нет.
    let remove = false;
    try {
      if (poll?.allowMultiple) {
        // Toggle: if already selected, remove; otherwise add
        if (myVotes.has(optIdx)) {
          await deletePollVote(postId, myPubB64, optIdx, ownerProfileId);
          remove = true;
        } else {
          await setPollVote(postId, myPubB64, optIdx, ownerProfileId, true);
        }
      } else {
        if (myVotes.size > 0) return; // single-choice: already voted
        // v4.32.48: allowMultiple=false → внутри setPollVote удалятся любые другие голоса этого voter.
        await setPollVote(postId, myPubB64, optIdx, ownerProfileId, false);
      }
    } catch (e) {
      log.warn('feed_poll_vote_save_failed', { err: rawErrorText(e) });
      showError(userErrorText(e, 'Не удалось сохранить голос'));
      return;
    }
    // Пересчёт отделён от записи: голос уже сохранён, и говорить «не удалось
    // сохранить» из-за неудавшегося перечитывания было бы неправдой.
    try {
      await reload();
    } catch (e) {
      log.warn('feed_poll_reload_failed', { err: rawErrorText(e) });
    }
    // Fire-and-forget broadcast. Если оффлайн — пост-опрос уже у получателей локально,
    // голос "догонит" позже через следующий online-цикл (envelope идентичен, idempotent).
    try {
      await broadcastPollVote(pair, postId, optIdx, remove);
    } catch (e) {
      // v4.32.91: голос уже локально записан; показываем warning, а не error — при
      // оффлайне голос догонит через следующий online-cycle (idempotent envelope).
      log.warn('feed_poll_vote_broadcast_failed', { err: rawErrorText(e) });
      showError(t('feed.pollVoteSavedOffline'));
    }
  }, [myVotes, poll, postId, myPubB64, ownerProfileId, reload, pair, t]);

  // v4.32.92: цвета из темы вместо хардкода. Primary (#3d5afe → colors.primary),
  // error text (#e53935 → colors.error), muted footer (#888 → colors.textMuted).
  const { colors } = useTheme();
  // v4.32.408: подложка пузыря и полоса результата были подмешаны
  // прозрачностью на месте вызова (`colors.primary + '0A'` и `+ '1F'`), а
  // текст варианта лежит НА полосе. Значит, порядок тот же, что у вложенного
  // блока (395): сначала подложка от карточки, потом полоса от подложки, и
  // только потом чернила — от того, на чём они в самом деле лежат.
  const bubble = badgeTint(colors, 'accent', colors.surface);
  const bubbleInkOn = inkOn(colors, bubble.fill);
  const bar = nestedFill(bubble.fill);
  const barInk = inkOn(colors, bar);
  const barAccent = readableInk(colors.accent, bar, 4.5);

  if (!poll) return <Text style={{ color: colors.error, fontSize: 13 }}>{t('feed.pollError')}</Text>;

  const voted = myVotes.size > 0;
  return (
    <View style={[pollBubbleStyles.container, { borderColor: colors.accent, backgroundColor: bubble.fill }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
        <Ionicons name="bar-chart-outline" size={16} color={bubble.ink} style={{ marginRight: 6 }} />
        <Text style={[pollBubbleStyles.question, { color: bubbleInkOn.text }]}>{poll.question}</Text>
      </View>
      {poll.options.map((opt, i) => {
        const count = voteCounts[i] ?? 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const isMyVote = myVotes.has(i);
        return (
          <AppPressable
            key={i}
            style={[pollBubbleStyles.option, { borderColor: colors.border }, isMyVote && { borderColor: colors.primary, borderWidth: 2 }]}
            onPress={() => { void vote(i); }}
            disabled={!poll.allowMultiple && voted}
            accessibilityRole={poll.allowMultiple ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: isMyVote, disabled: !poll.allowMultiple && voted }}
            accessibilityLabel={`${opt}${voted ? `, ${pct}%` : ''}`}
          >
            {voted ? (
              <View style={[pollBubbleStyles.optBar, { width: `${pct}%` as unknown as number, backgroundColor: bar }]} />
            ) : null}
            <View style={pollBubbleStyles.optRow}>
              {poll.allowMultiple ? (
                <View style={{
                  width: 18, height: 18, borderRadius: 4, borderWidth: 2,
                  borderColor: isMyVote ? colors.primary : colors.border,
                  backgroundColor: isMyVote ? colors.primary : 'transparent',
                  marginRight: 8, alignItems: 'center', justifyContent: 'center',
                }}>
                  {isMyVote ? <Ionicons name="checkmark" size={12} color={contrastingInk(colors.primary)} /> : null}
                </View>
              ) : null}
              {/* Надпись лежит на полосе результата, когда голос уже отдан, и на
                  подложке пузыря, пока не отдан: чернила проверены на обеих. */}
              <Text style={[pollBubbleStyles.optText, { color: barInk.text }, isMyVote && { fontWeight: '700', color: barAccent }]} numberOfLines={2}>{opt}</Text>
              {voted ? <Text style={[pollBubbleStyles.optPct, { color: barAccent }]}>{pct}%</Text> : null}
            </View>
          </AppPressable>
        );
      })}
      <Text style={[pollBubbleStyles.footer, { color: bubbleInkOn.secondary }]}>
        {voted ? t('feed.pollTotal', { count: totalVotes }) : (poll.allowMultiple ? t('feed.pollHintMulti') : t('feed.pollHintSingle'))}
        {poll.anonymous ? ` · ${t('feed.pollAnonymous')}` : ''}
        {poll.allowMultiple ? ` · ${t('feed.pollMulti')}` : ''}
      </Text>
    </View>
  );
}

const pollBubbleStyles = StyleSheet.create({
  container: { marginHorizontal: 12, marginBottom: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  question: { fontSize: 15, fontWeight: '600', flex: 1 },
  option: { borderRadius: 8, borderWidth: 1.5, marginBottom: 7, overflow: 'hidden' },
  optBar: { position: 'absolute', top: 0, left: 0, bottom: 0 },
  optRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 9 },
  optText: { fontSize: 14, flex: 1 },
  optPct: { fontSize: 13, fontWeight: '600', marginLeft: 8 },
  footer: { fontSize: 12, marginTop: 4 },
});

/**
 * Применяет оптимистичную реакцию к посту без ожидания сети/IPFS.
 */
function applyOptimisticReaction(post: FeedPostRow, emoji: string, myDid: string): FeedPostRow {
  const current = post.reactions ? { ...post.reactions } : {};
  const existing = current[emoji] ? [...current[emoji]] : [];
  if (!existing.includes(myDid)) {
    existing.push(myDid);
  }
  return { ...post, reactions: { ...current, [emoji]: existing } };
}

/**
 * Откатывает оптимистичную реакцию при ошибке сети/IPFS.
 */
function revertOptimisticReaction(post: FeedPostRow, emoji: string, myDid: string): FeedPostRow {
  if (!post.reactions) return post;
  const current = { ...post.reactions };
  const existing = current[emoji] ? current[emoji].filter((d) => d !== myDid) : [];
  if (existing.length === 0) {
    const { [emoji]: _removed, ...rest } = current;
    return { ...post, reactions: Object.keys(rest).length > 0 ? rest : null };
  }
  return { ...post, reactions: { ...current, [emoji]: existing } };
}

// v4.32.227 (PERF): the 60s feed tick reloads posts from SQLite into FRESH
// object refs every time. setPosts(list) then replaces the array, so FeedPostItem
// (memoized by reference) sees a new `post` prop and ALL rows re-render — observed
// as a recurring ~2.6s js_thread_blocked spike (9 cards ≈ 255ms each) that froze
// every tab tap landing in that window. Guarding each setState with a content
// equality check lets React bail out when nothing actually changed.
function jsonEq(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ─── FeedPostItem — memoized post row (Stage C.3) ────────────────────────────
// Extracted from renderItem so each post row only re-renders when its own
// item/slice props change, not on every parent setState (keyboard input,
// feed tick, comment count updates on other posts).
//
// Stability contract: parent must pass stable useCallback refs for every
// on*Press prop. Per-item slices (mediaUrls, commentCount, viewCount,
// translatedText) let the memo skip rows whose slice is unchanged.
interface FeedPostItemProps {
  item: FeedPostRow;
  isSelf: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: AppColors;
  mediaUrls: string[];
  commentCount: number;
  viewCount: number;
  translatedText: string | undefined;
  feedSearch: string;
  pair: KeyPairBytes;
  myPubB64: string;
  feedTick: number;
  onMarkRead: (item: FeedPostRow) => void;
  onLongPressPost: (item: FeedPostRow) => void;
  onPeekAuthor: (authorDid: string) => void;
  onHashtagPress: (tag: string) => void;
  onMediaPress: (urls: string[], idx: number) => void;
  onDocumentPress: (postId: string, idx: number, name: string, mime: string) => void | Promise<void>;
  onReactionPress: (postId: string, emoji: string) => void;
  onReactionLongPress: (emoji: string, dids: string[]) => void;
  onAddReactionPress: (postId: string) => void;
  onRepostPress: (item: FeedPostRow) => void;
  onRepostLongPress: (item: FeedPostRow) => void;
  onCommentsPress: (item: FeedPostRow) => void;
  onViewersPress: (postId: string) => void;
  onBookmarkToggle: (item: FeedPostRow) => void;
  onShareToChat: (item: FeedPostRow) => void;
  onNativeShare: (item: FeedPostRow) => void;
}

function FeedPostItemImpl(props: FeedPostItemProps): React.ReactElement {
  const {
    item, isSelf, styles, colors,
    mediaUrls, commentCount, viewCount, translatedText, feedSearch,
    pair, myPubB64, feedTick,
    onMarkRead, onLongPressPost, onPeekAuthor, onHashtagPress,
    onMediaPress, onDocumentPress, onReactionPress, onReactionLongPress,
    onAddReactionPress, onRepostPress, onRepostLongPress, onCommentsPress,
    onViewersPress, onBookmarkToggle, onShareToChat, onNativeShare,
  } = props;
  const { t } = useTranslation();

  // v4.32.589: имя автора могло не открыться ключом — тогда оно приходит
  // пустой строкой, и `?? 'Контакт'` её не ловит. Пометка вместо пустоты.
  const label = isSelf ? t('common.you') : shownName(item.authorName, item.nameUnreadable, t('common.contact'));
  const repostLabel = shownName(item.repostAuthorName, item.repostNameUnreadable, t('common.contact'));
  const repostSuffix = item.repostNameUnreadable
    ? ` · ${UNREADABLE_NAME_TEXT}`
    : item.repostAuthorName ? ` · @${item.repostAuthorName}` : '';
  const isPending = item.id.startsWith('opt_') || item.id.startsWith('temp-');
  const reactions = item.reactions;
  const hasReactions = reactions && Object.keys(reactions).length > 0;
  const isRepost = !!item.repostOf;

  return (
    <AppPressable
      style={[styles.card, item.read === 0 && styles.cardUnread]}
      onPress={() => { if (!isPending) onMarkRead(item); }}
      onLongPress={() => { if (!isPending) onLongPressPost(item); }}
      delayLongPress={400}
      accessibilityRole="button"
      accessibilityLabel={`${t('feed.a11yPostFrom', { name: label })}${
        feedPostIsUnreadable(item) ? `: ${UNREADABLE_POST_TEXT}` : item.text ? `: ${item.text.slice(0, 80)}` : ''
      }`}
      accessibilityHint={t('feed.a11yPostHint')}
    >
      {isRepost ? (
        <View style={styles.repostBanner}>
          <Ionicons name="repeat" size={14} color={colors.textSecondary} />
          <Text style={styles.repostBannerText}>
            {label} репостнул(а){repostSuffix}
          </Text>
        </View>
      ) : null}
      <View style={styles.postHeader}>
        <AppPressable
          onPress={() => onPeekAuthor(item.authorDid)}
          hitSlop={4}
          style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
        >
          <Ionicons name="person-circle" size={40} color={colors.accent} />
          <View style={styles.postHeaderText}>
            <Text style={styles.author}>{isRepost ? repostLabel : label}</Text>
            <View style={styles.timeRow}>
              <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
              {item.editedAt ? (
                <Text style={[styles.time, { fontStyle: 'italic', color: colors.textMuted }]}>{t('feed.edited')}</Text>
              ) : null}
              {isPending ? (
                <>
                  <ActivityIndicator size="small" color={colors.accent} style={styles.pendingSpinner} />
                  <Text style={styles.pendingLabel}>{t('feed.sendingPending')}</Text>
                </>
              ) : null}
            </View>
          </View>
        </AppPressable>
      </View>
      {/* v4.32.587: столбец, который ключ не открыл, приходил пустотой, и
          запись рисовалась карточкой с именем автора и ничем внутри. */}
      {feedPostIsUnreadable(item) ? (
        <View style={styles.unreadableRow}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.warning} />
          <Text style={styles.unreadableText}>{UNREADABLE_POST_TEXT}</Text>
        </View>
      ) : item.text?.startsWith(POLL_PREFIX) ? (
        <FeedPollBubble
          postId={item.id}
          pollText={item.text}
          myPubB64={myPubB64}
          ownerProfileId={profileManager.getActiveProfile()?.id ?? 1}
          pair={pair}
          feedTick={feedTick}
        />
      ) : item.text ? (() => {
        const geo = extractFeedLocationTag(item.text);
        const bodyText = geo ? geo.textWithout : item.text;
        return (
          <>
            {bodyText.length > 0 ? (
              <RichText text={bodyText} style={styles.body} onHashtagPress={onHashtagPress} searchTerm={feedSearch.trim() || undefined} host={item.read === 0 ? colors.surfaceHigh : colors.surface} />
            ) : null}
            {geo ? (
              <View style={{ marginTop: 8 }}>
                <LocationMessage lat={geo.lat} lng={geo.lng} />
              </View>
            ) : null}
            {translatedText ? (
              <View style={{ marginTop: 4, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 2 }}>{t('feed.translationLabel')}</Text>
                <Text style={[styles.body, { color: colors.textSecondary }]}>{translatedText}</Text>
              </View>
            ) : null}
          </>
        );
      })() : null}
      {(() => {
        const u = item.text && !item.text.startsWith('\x04') ? extractFirstUrl(item.text) : null;
        return u ? <LinkPreview url={u} isOutgoing={false} fromPeer={!isSelf} /> : null;
      })()}
      {item.mediaCids && item.mediaCids.length > 0 && mediaUrls.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.mediaRow}>
          {mediaUrls.map((url, idx) => (
            <AppPressable
              key={`${item.id}_${idx}`}
              onPress={() => onMediaPress(mediaUrls, idx)}
              hitSlop={4}
              accessibilityRole="imagebutton"
              accessibilityLabel={t('feed.a11yImageN', { n: idx + 1, total: mediaUrls.length })}
            >
              <Image source={{ uri: url }} style={styles.thumb} />
            </AppPressable>
          ))}
        </ScrollView>
      ) : null}

      {item.documents && item.documents.length > 0 ? (
        <View style={{ marginTop: 8, gap: 6 }}>
          {item.documents.map((doc, idx) => (
            <AppPressable
              key={`${item.id}_doc_${idx}`}
              onPress={() => onDocumentPress(item.id, idx, doc.name, doc.mime)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 10,
                borderRadius: 10,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
                backgroundColor: colors.surface,
                gap: 10,
              }}
            >
              <Ionicons name="document-outline" size={22} color={colors.accent} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: 14, color: colors.text, fontWeight: '500' }}>
                  {doc.name}
                </Text>
                <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                  {formatByteSize(doc.size) || '—'}
                  {doc.mime ? ` · ${doc.mime}` : ''}
                </Text>
              </View>
              <Ionicons name="share-outline" size={20} color={colors.textMuted} />
            </AppPressable>
          ))}
        </View>
      ) : null}

      <View style={styles.reactionsRow}>
        {hasReactions
          ? Object.entries(reactions!).map(([emoji, dids]) => (
              <AppPressable
                key={emoji}
                style={styles.reactionBubble}
                onPress={() => { if (!isPending) onReactionPress(item.id, emoji); }}
                onLongPress={() => onReactionLongPress(emoji, dids as string[])}
                delayLongPress={400}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('feed.a11yReaction', { emoji, count: (dids as string[]).length })}
              >
                <Text style={styles.reactionEmoji}>{emoji}</Text>
                <Text style={styles.reactionCount}>{dids.length}</Text>
              </AppPressable>
            ))
          : null}
        {!isPending ? (
          <>
            <AppPressable
              style={styles.reactionAddBtn}
              onPress={() => onAddReactionPress(item.id)}
              hitSlop={8}
              testID={`btn_react_${item.id}`}
              accessibilityLabel={t('feed.a11yAddReaction')}
            >
              <Text style={styles.reactionAddIcon}>＋</Text>
            </AppPressable>
            {!isSelf ? (
              <AppPressable
                style={styles.reactionAddBtn}
                onPress={() => onRepostPress(item)}
                onLongPress={() => onRepostLongPress(item)}
                delayLongPress={400}
                hitSlop={8}
                accessibilityLabel={t('feed.a11yRepost')}
              >
                <Ionicons name="repeat" size={16} color={colors.textSecondary} />
              </AppPressable>
            ) : null}
            <AppPressable
              style={[styles.reactionAddBtn, { flexDirection: 'row', width: 'auto', paddingHorizontal: 8, gap: 4 }]}
              onPress={() => onCommentsPress(item)}
              hitSlop={8}
              accessibilityLabel={t('feed.a11yComments')}
            >
              <Ionicons name="chatbubble-outline" size={15} color={colors.textSecondary} />
              {commentCount > 0 ? (
                <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '600' }}>{commentCount}</Text>
              ) : null}
            </AppPressable>
            {isSelf ? (
              <AppPressable
                style={[styles.reactionAddBtn, { flexDirection: 'row', width: 'auto', paddingHorizontal: 8, gap: 4 }]}
                onPress={() => onViewersPress(item.id)}
                hitSlop={8}
                accessibilityLabel={t('feed.a11yViews')}
              >
                <Ionicons name="eye-outline" size={15} color={colors.textSecondary} />
                <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '600' }}>
                  {viewCount}
                </Text>
              </AppPressable>
            ) : null}
            <AppPressable
              style={styles.reactionAddBtn}
              onPress={() => onBookmarkToggle(item)}
              hitSlop={8}
              accessibilityLabel={t('feed.a11yBookmark')}
            >
              <Ionicons name={item.bookmarked ? 'bookmark' : 'bookmark-outline'} size={15} color={item.bookmarked ? colors.accent : colors.textSecondary} />
            </AppPressable>
            <AppPressable
              style={styles.reactionAddBtn}
              onPress={() => onShareToChat(item)}
              hitSlop={8}
              accessibilityLabel={t('feed.a11yForwardToChat')}
            >
              <Ionicons name="paper-plane-outline" size={15} color={colors.textSecondary} />
            </AppPressable>
            <AppPressable
              style={styles.reactionAddBtn}
              onPress={() => onNativeShare(item)}
              hitSlop={8}
              accessibilityLabel={t('feed.a11yShare')}
            >
              <Ionicons name="share-outline" size={15} color={colors.textSecondary} />
            </AppPressable>
          </>
        ) : null}
      </View>
    </AppPressable>
  );
}

const FeedPostItem = memo(FeedPostItemImpl);

type Props = {
  pair: KeyPairBytes;
  did: string;
  /** Увеличивается при входящем посте (pubsub) — перезагрузка ленты. */
  feedTick?: number;
};

function formatTime(ts: number): string {
  return dayMonthShortTime(ts);
}

/**
 * v4.32.528: применить прочитанный список, если чтение удалось.
 *
 * Раньше результат чтения уходил прямо в сеттер состояния, а пустой массив
 * приходил и на сбое базы, и на честно пустом архиве — в первом случае экран
 * молча стирал то, что человек уже видел. Теперь сбой до состояния не доходит.
 */
function applyIfRead(
  set: (rows: FeedPostRow[]) => void,
  where: string,
): (rows: DbRead<FeedPostRow>) => void {
  return (rows) => {
    if (shouldApplyRows(rows)) set([...rows]);
    else log.warn('ui_feed_list_read_failed', { where });
  };
}

/**
 * Запустить операцию с базой так, чтобы отказ дошёл до человека.
 *
 * v4.32.534: пункты меню публикации висели в коде как `void doSomething(...)`
 * без `.catch` — скрыть автора, отключить уведомления, удалить запись. Функции
 * хранилища бросают: занятая база, сорванная транзакция, пропавший профиль.
 * Отказ уходил в неперехваченное отклонение обещания: список не менялся,
 * ошибка не показывалась, и пункт меню выглядел как иногда не срабатывающий.
 * Тот же вход, что у списка групп (v4.32.531), — один на все действия ленты.
 */
function runGuardedOp(op: () => Promise<unknown>, fallback: string): void {
  void (async () => {
    try {
      await op();
    } catch (e) {
      showError(userErrorText(e, fallback));
    }
  })();
}

function FeedScreenImpl({ pair, did, feedTick = 0 }: Props): React.ReactElement {
  const { t } = useTranslation();
  // v4.32.16: `isActive` больше НЕ prop — читаем `tabRef.current === 'feed'` из Context.
  // React.memo видит стабильные props при setTab → bail-out → нет re-render'а тяжёлого
  // JSX tree (это и давало 2.2с блок). Все useEffect-подписки создаются 1 раз при mount,
  // gate в колбэках читает tabRef.current.
  const tabRef = useTabRef();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const cmStyles = useMemo(() => makeCmStyles(colors), [colors]);
  // v4.32.408: «этот режим включён» рисовалось плашкой `colors.primary + '22'`
  // — прозрачностью, подмешанной на месте вызова, — а надпись на плашке
  // бралась из палитры, где она проверена на ФОНЕ. В светлой теме `accent` на
  // такой плашке даёт 4.42:1, а на её более плотной версии ('33') — 3.99:1.
  // Заливка теперь считается от поверхности под ней, чернила — от заливки.
  const activeTint = useMemo(() => badgeTint(colors, 'accent', colors.background), [colors]);
  const activeInk = useMemo(() => inkOn(colors, activeTint.fill), [colors, activeTint.fill]);
  const commentTint = useMemo(() => badgeTint(colors, 'accent', colors.surface), [colors]);
  // Приглушённая плашка: `colors.border + 'aa'` под `textMuted` давало 2.80:1
  // в светлой теме и 3.09:1 в тёмной — «Скрыто авторов: N» не читалось.
  const quietTint = useMemo(() => badgeTint(colors, 'muted', colors.background), [colors]);
  const insets = useSafeAreaInsets();
  const [posts, setPosts] = useState<FeedPostRow[]>([]);
  // v4.32.503: обновлению нужен текущий список, но брать его из зависимостей
  // нельзя — loadFeed пересобирался бы на каждое изменение ленты и перезапускал
  // эффекты, которые на него подписаны.
  const postsRef = useRef<FeedPostRow[]>(posts);
  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);
  const [gateway, setGateway] = useState('');
  /** v4.32.29: resolved URIs for feed media. Ключ = post.id, значение = список
   *  либо `data:<mime>;base64,...` (inline) либо `https://<gateway>/ipfs/<cid>` (legacy). */
  const [mediaUrlsMap, setMediaUrlsMap] = useState<Record<string, string[]>>({});
  const [refreshing, setRefreshing] = useState(false);
  /** Публикация в фоне после закрытия модалки — не блокирует UI. */
  const [publishing, setPublishing] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [optimisticPosts, setOptimisticPosts] = useState<FeedPostRow[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftSelection, setDraftSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const draftInputRef = useRef<TextInput>(null);
  const [uris, setUris] = useState<string[]>([]);
  // v4.32.48: документы, прикреплённые к посту (PDF/DOC/…). Лимит: 3 файла,
  //          каждый ≤1.2 MB (FEED_DOC_MAX_RAW_BYTES в feedService).
  const [pickedDocs, setPickedDocs] = useState<
    { uri: string; name: string; mime: string; size?: number }[]
  >([]);
  // Poll compose
  const [isPollMode, setIsPollMode] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [pollAnonymous, setPollAnonymous] = useState(false);
  const [pollMultiSelect, setPollMultiSelect] = useState(false);
  const [unread, setUnread] = useState(0);
  const publishLockRef = useRef(false);
  /** Per-post защита от двойного клика: реакции. */
  const reactionAction = useKeyedAsyncAction();
  /** Per-post защита от двойного клика: репосты. */
  const repostAction = useKeyedAsyncAction();
  /** Per-post защита от двойного tap: отметка прочитанного. */
  const markReadAction = useKeyedAsyncAction();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const modalScrollRef = useRef<ScrollView>(null);
  const [reactionTarget, setReactionTarget] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [feedSearch, setFeedSearch] = useState('');
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null);
  const [feedEmojiSuggestions, setFeedEmojiSuggestions] = useState<{ key: string; emoji: string }[]>([]);
  const [hashtagSuggestions, setHashtagSuggestions] = useState<string[]>([]);
  const [mentionSuggestions, setMentionSuggestions] = useState<{ name: string; did: string }[]>([]);
  const [bookmarkFilter, setBookmarkFilter] = useState(false);
  const [bookmarkedPosts, setBookmarkedPosts] = useState<FeedPostRow[]>([]);
  // v4.32.34: режим «Архив» — показывает только archived-посты, скрытые из основной ленты.
  const [archiveFilter, setArchiveFilter] = useState(false);
  const [archivedPosts, setArchivedPosts] = useState<FeedPostRow[]>([]);
  // v4.32.34: post action sheet (вместо Alert.alert — на Android Alert capped at 3 buttons).
  const [actionSheetPost, setActionSheetPost] = useState<FeedPostRow | null>(null);
  // v4.32.50: профиль автора поста/комментария — открывается при тапе по имени/аватару.
  const [peekAuthorDid, setPeekAuthorDid] = useState<string | null>(null);
  const myPubB64 = useMemo(() => Buffer.from(pair.publicKey).toString('base64'), [pair]);
  // ─── Post translation ─────────────────────────────────────────────────────
  const [translatedPosts, setTranslatedPosts] = useState<Record<string, string>>({});
  const [feedTranslateLang, setFeedTranslateLang] = useState('ru');
  // ─── Compose: location tag ────────────────────────────────────────────────
  const [postLocationTag, setPostLocationTag] = useState<string | null>(null);
  // ─── Edit existing post ───────────────────────────────────────────────────
  const [editingPost, setEditingPost] = useState<FeedPostRow | null>(null);
  const [feedOffset, setFeedOffset] = useState(0);
  const [feedHasMore, setFeedHasMore] = useState(true);
  // v4.32.528: последнее чтение ленты не удалось. Отдельно от «лента пуста»:
  // пустой экран без единого слова об ошибке — это молчаливая потеря данных.
  const [feedReadFailed, setFeedReadFailed] = useState(false);
  const feedLoadingMore = useRef(false);
  const isMountedRef = useRef(true);
  // v4.32.69: просмотр считается когда пост попал в viewport на >=800мс (как в TG/VK).
  // Session-dedup кеш — чтобы один и тот же пост не слал envelope несколько раз за сессию
  // (kvStore-guard `feed_view_sent:<postId>` в notifyFeedPostViewed — персистентный бэкап).
  //
  // v4.32.537: было `Set<string>`, куда запись вносилась ДО отправки и не
  // убиралась никогда. Два следствия. Первое: отправка, которая не удалась
  // (автор оффлайн — обычное дело), больше не повторялась до перезапуска
  // экрана, хотя ровно на повтор и был расчёт. Второе: множество росло без
  // границы — за долгую прокрутку ленты оно набирало идентификатор каждой
  // виденной записи и не отдавало память. Теперь заявка снимается, если
  // отправка не прошла, а размер ограничен сверху.
  const sentViewRef = useRef(createReceiptClaims());

  // v4.32.61: системная кнопка «Назад» (Android) на вкладке «Новости».
  // Порядок: composer-Modal (modalOpen) → comment thread (commentPostId) →
  // action-sheet (actionSheetPost) → фильтры bookmark/archive → поиск /
  // хэштег → false (App.tsx top-level решит — feed это домашний таб, значит
  // выход из приложения). Composer-Modal имеет onRequestClose — обработает
  // нативно; здесь явный guard нужен только для inline-overlays.
  useBackHandler(true, () => {
    if (tabRef.current !== 'feed') return false;
    if (actionSheetPost) {
      setActionSheetPost(null);
      return true;
    }
    if (editingPost) {
      setEditingPost(null);
      setDraft('');
      setUris([]);
      setPostLocationTag(null);
      return true;
    }
    if (isPollMode) {
      setIsPollMode(false);
      return true;
    }
    if (uris.length > 0) {
      setUris([]);
      return true;
    }
    if (activeHashtag) {
      setActiveHashtag(null);
      return true;
    }
    if (feedSearch.trim().length > 0) {
      setFeedSearch('');
      return true;
    }
    if (bookmarkFilter) {
      setBookmarkFilter(false);
      return true;
    }
    if (archiveFilter) {
      setArchiveFilter(false);
      return true;
    }
    return false;
  });
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);
  // v4.32.73: persist compose draft перед запуском picker — на realme/Android 15
  // host activity может быть recreated под memory pressure во время picker-flow,
  // тогда launchImageLibraryAsync резолвится `canceled:true, assetCount:0` даже
  // если юзер реально выбрал фото. ImagePicker.getPendingResultAsync() возвращает
  // актуальный результат при следующем mount'е, а persisted draft восстанавливает
  // текст/URIs/docs/geo — без этого юзер видит «опубликовал только текст, фото
  // пропали» (симптоматически читается как «текст пропадает при фото+тексте»).
  // v4.32.292: сам снимок (шифрование, namespace профиля, разбор и границы)
  // живёт в core/social/composeDraft — экран только применяет его к state.
  //
  // v4.32.73: recovery после recreation host-activity во время picker-flow.
  // expo-image-picker.getPendingResultAsync() возвращает результат picker'а,
  // который отдался пока приложение было убито. Параллельно восстанавливаем
  // текст/URIs/docs/geo из persisted snapshot'а — иначе юзер теряет и фото
  // (активити умерла до того как setUris применился) и текст (React state стёрт).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await loadComposeDraft(did);
        if (!snap || cancelled) return;

        // v4.32.333: режим правки тоже восстанавливается — см. planComposeRestore.
        const restoredEditing = snap.editingPostId ? await getFeedPost(snap.editingPostId) : null;
        if (cancelled) return;
        const plan = planComposeRestore({
          editingPostId: snap.editingPostId,
          editTargetExists: !!restoredEditing,
        });
        if (plan.kind === 'discard') {
          log.warn('ui_feed_compose_recover_discarded', { reason: plan.reason });
          await clearPersistedComposeDraft(did);
          showError(t('feed.editTargetGone'));
          return;
        }

        let pendingResult: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null = null;
        try {
          pendingResult = await ImagePicker.getPendingResultAsync();
        } catch (e) {
          log.warn('ui_feed_picker_pending_failed', { err: rawErrorText(e) });
        }
        if (cancelled) return;
        log.info('ui_feed_compose_recover', {
          hasDraft: !!snap.draft,
          urisLen: snap.uris.length,
          docsLen: snap.pickedDocs.length,
          restore: plan.kind,
          pendingResultKind: pendingResult
            ? ('canceled' in pendingResult ? (pendingResult.canceled ? 'canceled' : 'ok') : 'error')
            : 'none',
        });
        // Восстанавливаем composer-state.
        setDraft(snap.draft);
        if (plan.kind === 'edit' && restoredEditing) {
          // Правка меняет только текст: кнопок фото, документа и опроса в этом
          // режиме на экране нет, и подставлять их значило бы показать вложения,
          // которых у поста нет и добавить которые всё равно нельзя.
          setEditingPost(restoredEditing);
        } else {
          setUris(snap.uris);
          setPickedDocs(snap.pickedDocs);
          setPostLocationTag(snap.postLocationTag);
          if (snap.isPollMode) {
            setIsPollMode(true);
            setPollQuestion(snap.pollQuestion);
            setPollOptions(snap.pollOptions);
          }
        }
        setModalOpen(true);
        // Добавляем фото из pending picker result, если он успешный.
        if (plan.kind === 'new' && pendingResult && 'canceled' in pendingResult && !pendingResult.canceled && pendingResult.assets?.length) {
          const newUris = pendingResult.assets.map((a) => a.uri);
          const remaining = FEED_MAX_IMAGES - snap.uris.length;
          const toAdd = newUris.slice(0, Math.max(0, remaining));
          if (toAdd.length) {
            setUris([...snap.uris, ...toAdd]);
            showSuccess(
              toAdd.length === 1 ? t('feed.photoRestored') : t('feed.photoRestoredN', { count: toAdd.length })
            );
          }
        }
        await clearPersistedComposeDraft(did);
      } catch (e) {
        log.warn('ui_feed_compose_recover_failed', { err: rawErrorText(e) });
      }
    })();
    return () => { cancelled = true; };
    // Зависит только от профиля — один запуск при mount'е / смене профиля.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` намеренно не в deps: эффект одноразовый (восстановление черновика), добавление `t` перезапускало бы его и заново открывало модалку при смене языка
  }, [did]);
  // ─── Full-screen image viewer ─────────────────────────────────────────────
  const { open: openFeedMedia, element: feedMediaViewerElement } = useMediaViewer();

  // v4.32.48: открыть документ поста — пишем base64 из kvStore в cacheDirectory,
  //            затем expo-sharing.shareAsync → пользователь выбирает «Сохранить»/«Открыть в…».
  const openFeedDocument = useCallback(
    async (postId: string, index: number, name: string, mime: string) => {
      try {
        const { saveFeedDocumentToCache } = await import('../../core/social/feedService');
        const uri = await saveFeedDocumentToCache(postId, index, name);
        if (!uri) {
          Alert.alert(t('feed.docTitle'), t('feed.docOpenFailed'));
          return;
        }
        const Sharing = await import('expo-sharing');
        const available = await Sharing.isAvailableAsync();
        if (!available) {
          Alert.alert(t('feed.docTitle'), t('feed.docSavedTo', { uri }));
          return;
        }
        await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: name });
      } catch (e) {
        const msg = rawErrorText(e);
        log.warn('ui_feed_doc_open_failed', { err: msg });
        showError(t('feed.docOpenError'));
      }
    },
    [t],
  );

  useEffect(() => {
    void scopedKvGet(TRANSLATION_TARGET_LANG_KEY).then((lang) => { if (lang) setFeedTranslateLang(lang); });
  }, []);

  const translatePost = useCallback(async (post: FeedPostRow) => {
    // v4.32.366: проверка была одна — префикс \x04. Служебных префиксов 22, и
    // решение теперь общее для всех мест перевода (core/social/cloudTranslate).
    const blocked = translateBlockReason(post.text ?? '');
    if (blocked) {
      if (blocked !== 'empty') showError(translateBlockMessage(blocked));
      return;
    }
    const target = feedTranslateLang;
    // v4.32.29: отправка текста поста стороннему сервису — только с согласия.
    // v4.32.486: согласие то же самое, что и у переписки, и своё у каждого
    // аккаунта (social/translateConsent). Прежде их было два: здесь — диалог
    // на один тап, в переписке — выключатель, которого не существовало.
    // Диалог остался как короткий путь к тому же решению: согласие включает
    // его насовсем, и его видно в настройках приватности.
    if (!(await cloudTranslateAllowed())) {
      const accepted = await new Promise<boolean>((resolve) => {
        Alert.alert(
          t('feed.translateConfirmTitle'),
          t('feed.translateConfirmMsg'),
          [
            { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('common.agree'), onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
      if (!accepted) return;
      await setCloudTranslateAllowed(true);
    }
    const url = buildTranslateUrl(post.text, target);
    if (!url) { showError('Не выбран язык перевода'); return; }
    // v4.32.29: 8s timeout — раньше fetch висел индефинитно на мёртвой сети.
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const out = parseTranslation(await res.json(), post.text);
      if (out.ok) {
        setTranslatedPosts((prev) => ({ ...prev, [post.id]: out.text }));
      } else {
        // Раньше отказ сервиса (исчерпанная квота) показывался как перевод:
        // он приходит HTTP 200 в том же поле translatedText.
        showError(translateFailureMessage(out.reason));
      }
    } catch (e) {
      // v4.32.534: чат и группы об отказе перевода говорили, лента молчала —
      // «Перевести» выглядело как пункт меню, который иногда ничего не делает.
      log.warn('feed_translate_failed', { err: rawErrorText(e) });
      showError(t('feed.translateFailed'));
    } finally {
      clearTimeout(tid);
    }
  }, [feedTranslateLang, t]);

  // ─── Muted authors ─────────────────────────────────────────────────────────
  const [mutedAuthors, setMutedAuthors] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void getMutedAuthors().then((set) => { if (alive) setMutedAuthors(set); });
    return () => { alive = false; };
  }, []);

  // v4.32.167: per-post comment mute (muteStore 'post'). Отключает баннер/
  // system-notification новых комментов к этому посту; сам пост и лента
  // обновляются нормально.
  const [mutedPosts, setMutedPosts] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { listMuted } = await import('../../core/notifications/muteStore');
      const entries = await listMuted('post');
      if (!alive) return;
      setMutedPosts(new Set(entries.map((e) => e.id)));
    })();
    return () => { alive = false; };
  }, []);
  const toggleMutePost = useCallback(async (postId: string) => {
    const { isMuted, setMuted, unmute } = await import('../../core/notifications/muteStore');
    const currently = await isMuted('post', postId);
    if (currently) {
      await unmute('post', postId);
      setMutedPosts((prev) => { const n = new Set(prev); n.delete(postId); return n; });
    } else {
      await setMuted('post', postId);
      setMutedPosts((prev) => { const n = new Set(prev); n.add(postId); return n; });
    }
  }, []);

  // v4.32.293: показываем то, что записалось. Запись шла side-effect'ом внутри
  // setState-updater'а — React вправе вызвать его дважды, и провал записи
  // интерфейс всё равно не замечал.
  const toggleMuteAuthor = useCallback(async (authorDid: string) => {
    setMutedAuthors(await toggleMutedAuthor(authorDid));
  }, []);

  // ─── Share to chat ──────────────────────────────────────────────────────────
  const [shareToTarget, setShareToTarget] = useState<FeedPostRow | null>(null);
  const [shareContacts, setShareContacts] = useState<Contact[]>([]);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [shareGroups, setShareGroups] = useState<GroupRow[]>([]);
  // v4.32.534: у чтения списка получателей три исхода, а не два. Пустой список
  // приходил и на сбое базы, и у человека без единого контакта — и в обоих
  // случаях лист навсегда показывал «Загрузка…».
  const [shareTargets, setShareTargets] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [shareQuery, setShareQuery] = useState('');
  const [shareSending, setShareSending] = useState(false);

  useEffect(() => {
    if (!shareToTarget) return;
    let alive = true;
    const pid = profileManager.getActiveProfile()?.id ?? 1;
    setShareTargets('loading');
    setShareQuery('');
    void Promise.all([listContacts(), listGroups(pid)])
      .then(([ctacts, grps]) => {
        if (!alive) return;
        setShareContacts(ctacts);
        setShareGroups(grps.filter((g) => !g.archived));
        setShareTargets('ready');
      })
      .catch((e: unknown) => {
        log.warn('feed_share_targets_failed', { err: rawErrorText(e) });
        if (alive) setShareTargets('failed');
      });
    return () => { alive = false; };
  }, [shareToTarget]);

  const handleShareToContact = useCallback(async (contact: Contact) => {
    if (!shareToTarget || shareSending) return;
    const svc = getMessagingService();
    if (!svc) { showError(t('feed.serviceUnavailable')); return; }
    // v4.32.182 (Round-12 #9): append ellipsis + prefer word boundary when truncating.
    const text = shareToTarget.text
      ? (shareToTarget.text.length > 300
          ? shareToTarget.text.slice(0, 300).replace(/\s+\S*$/, '') + '…'
          : shareToTarget.text)
      : t('feed.mediaFallback');
    const msg = `📤 ${outwardName(shareToTarget.authorName, shareToTarget.nameUnreadable, t('feed.publicationTitle'))}:\n${text}`;
    setShareSending(true);
    try {
      // v4.32.335: sendMessage возвращает null, когда отправки не было —
      // контакт заблокирован или сработал часовой лимит. Раньше «Переслано»
      // печаталось в любом случае, и человек был уверен, что публикация ушла.
      const sentId = await svc.sendMessage(contact.peerPublicKey, msg);
      if (!sentId) {
        showError(t('feed.sendFailed'));
        return;
      }
      showSuccess(t('feed.forwardedTo', { name: contactLabel(contact.displayName, t('common.contact')) }));
      setShareToTarget(null);
    } catch {
      showError(t('feed.sendFailed'));
    } finally {
      setShareSending(false);
    }
  }, [shareToTarget, shareSending, t]);

  const handleShareToGroup = useCallback(async (grp: GroupRow) => {
    if (!shareToTarget || shareSending) return;
    const pid = profileManager.getActiveProfile()?.id ?? 1;
    const myName = (await getOwnDisplayName()) ?? t('common.you');
    // v4.32.182 (Round-12 #9): append ellipsis + prefer word boundary when truncating.
    const text = shareToTarget.text
      ? (shareToTarget.text.length > 300
          ? shareToTarget.text.slice(0, 300).replace(/\s+\S*$/, '') + '…'
          : shareToTarget.text)
      : t('feed.mediaFallback');
    const msg = `📤 ${outwardName(shareToTarget.authorName, shareToTarget.nameUnreadable, t('feed.publicationTitle'))}:\n${text}`;
    setShareSending(true);
    try {
      // v4.32.270: группа выбирается из общего списка, и права на отправку в
      // ней могли не разрешать вообще ничего — канал, «только для админов»,
      // restricted, бан. Раньше публикация писалась себе в историю, показывался
      // «Переслано», а рассылка через void молча отказывала.
      const { groupSendVerdict } = await import('../../core/social/groupMessaging');
      const verdict = await groupSendVerdict(grp.id, myPubB64, msg);
      if (!verdict.allowed) {
        showError(verdict.reason);
        return;
      }
      const row = {
        id: uuidv4(),
        groupId: grp.id,
        senderPubB64: myPubB64,
        senderName: myName,
        text: msg,
        mediaCids: null,
        replyToId: null,
        replyToPreview: null,
        reactions: null,
        createdAt: Date.now(),
        ownerProfileId: pid,
      };
      await insertGroupMessage(row);
      await touchGroupConversation(grp.id, pid, msg.slice(0, 60), false, myName, false, myPubB64);
      announceGroupSend(fanoutGroupMessage(grp.id, msg, myName, myPubB64, row.id));
      showSuccess(t('feed.forwardedToGroup', { name: grp.name }));
      setShareToTarget(null);
    } catch {
      showError(t('feed.sendFailed'));
    } finally {
      setShareSending(false);
    }
  }, [shareToTarget, shareSending, myPubB64, t]);

  const shareFilteredContacts = useMemo(() => {
    if (!shareQuery.trim()) return shareContacts;
    const q = shareQuery.toLowerCase();
    return shareContacts.filter((c) => c.displayName?.toLowerCase().includes(q) || c.peerPublicKey.includes(q));
  }, [shareContacts, shareQuery]);

  const shareFilteredGroups = useMemo(() => {
    if (!shareQuery.trim()) return shareGroups;
    const q = shareQuery.toLowerCase();
    return shareGroups.filter((g) => g.name.toLowerCase().includes(q));
  }, [shareGroups, shareQuery]);

  // ─── Comments ───────────────────────────────────────────────────────────────
  const [commentPostId, setCommentPostId] = useState<string | null>(null);
  // v4.32.159: держим ссылку на сам пост, чтобы отрисовать его pinned-шапкой в
  // полноэкранной CommentsScreen'е (раньше модалка не показывала исходный пост,
  // пользователь терял контекст треда). Всегда идёт в паре с commentPostId.
  const [commentPost, setCommentPost] = useState<FeedPostRow | null>(null);
  const [comments, setComments] = useState<FeedCommentRow[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [commentSending, setCommentSending] = useState(false);
  // v4.32.91: лоадинг-стейт для модалки комментариев — раньше открывалась пустая,
  // пользователь не понимал есть ли вообще ответы или ещё грузится.
  const [commentsLoading, setCommentsLoading] = useState(false);
  // v4.32.538: чей тред прочитан прямо сейчас. «Список пуст» и «прочитать не
  // удалось» выглядят на экране одинаково, а для счётчика под записью это
  // противоположные вещи: первое значит «ноль», второе — «мы не знаем».
  const [commentsLoadedFor, setCommentsLoadedFor] = useState<string | null>(null);
  // v4.32.68: карта {postId → количество просмотров} для своих постов.
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});
  // v4.32.68: модалка «Кто просмотрел» — список viewer'ов для конкретного поста.
  const [viewersPostId, setViewersPostId] = useState<string | null>(null);
  const [viewersList, setViewersList] = useState<FeedViewerRow[]>([]);
  const [viewersLoading, setViewersLoading] = useState(false);
  const commentInputRef = useRef<TextInput>(null);
  // v4.32.51: автоскролл комментариев в конец — при открытии модалки + после submit + при
  // входящих комментариях (feedTick). Без этого новые комментарии оказывались ниже viewport'а,
  // юзер видел "пусто" вместо "Я только что ответил".
  // v4.32.92: FlatList вместо ScrollView в комментариях — при длинных тредах
  // ScrollView рендерил всё разом и лагал. FlatList поддерживает scrollToEnd()
  // через scrollToOffset при пустом списке + getItemLayout нам не нужен (comments
  // короткие, autosize ок).
  const commentScrollRef = useRef<FlatList<FeedCommentRow>>(null);
  const scrollCommentsToEnd = useCallback((animated: boolean) => {
    try { commentScrollRef.current?.scrollToEnd({ animated }); } catch { /* ignore */ }
  }, []);
  // v4.32.114 T2: подписка на pubsub-топик поста пока открыта модалка комментариев.
  // Любой, кто опубликовал коммент в этом топике (даже не наш контакт), долетит.
  const commentTopicUnsubRef = useRef<(() => void) | null>(null);
  // v4.32.115: tracks the currently-open post so the async subscribe .then()
  // can tell if the user has since switched to another post (race guard).
  const commentPostIdRef = useRef<string | null>(null);
  // v4.32.504: то же правило для «Кто просмотрел» — список тоже читается
  // асинхронно и тоже подписан конкретным постом.
  const viewersPostIdRef = useRef<string | null>(null);
  useEffect(() => {
    commentPostIdRef.current = commentPostId;
  }, [commentPostId]);
  useEffect(() => {
    return () => {
      try { commentTopicUnsubRef.current?.(); } catch { /* ignore */ }
      commentTopicUnsubRef.current = null;
    };
  }, []);

  useEffect(() => {
    void loadConfig().then((c) => setGateway(c.ipfs.gatewayUrl.replace(/\/$/, '')));
  }, []);

  const FEED_PAGE = 40;
  // v4.32.47: loadVersionRef — защита от race loadFeed (tick) vs loadMoreFeed
  // (user scroll). Каждый loadFeed инкрементирует; loadMoreFeed запоминает версию
  // на старте, если на финише она изменилась — результат дропается.
  const loadVersionRef = useRef(0);
  const loadFeed = useCallback(async () => {
    loadVersionRef.current += 1;
    const myVersion = loadVersionRef.current;
    const t0 = Date.now();
    log.info('ui_feed_load_start', { ts: t0, version: myVersion });
    try {
      const tA = Date.now();
      const read = await loadFeedPosts(FEED_PAGE, 0);
      log.info('ui_feed_load_posts_done', { ms: Date.now() - tA, n: read ? read.length : -1 });
      if (!isMountedRef.current) return;
      if (loadVersionRef.current !== myVersion) {
        log.info('ui_feed_load_superseded', { myVersion, current: loadVersionRef.current });
        return;
      }
      // v4.32.528: чтение не удалось — ни список, ни offset, ни «есть ещё» не
      // трогаем. Прежде пустота от блокировки базы шла дальше как факт:
      // склейка головы выбрасывала хвост, подгрузка гасла, экран писал
      // «Лента пуста». Теперь человек видит, что обновить не вышло.
      if (!shouldApplyRows(read)) {
        log.warn('ui_feed_load_read_failed', { version: myVersion });
        setFeedReadFailed(true);
        return;
      }
      const list = read;
      setFeedReadFailed(false);
      // v4.32.227 (PERF): keep the previous array ref when content is unchanged
      // → memoized rows bail out, no 2.6s re-render storm on the 60s tick.
      // v4.32.503: свежая голова + сохранённый хвост. Раньше здесь стоял
      // список головы целиком, и любое обновление — минутный тик, реакция,
      // закладка — схлопывало долистанную ленту до первых сорока постов.
      const merged = mergeListHead(postsRef.current, list, FEED_PAGE, atTimestamp);
      setPosts((prev) => (jsonEq(prev, merged) ? prev : merged));
      setFeedOffset(merged.length);
      setFeedHasMore((prevHas) => hasMoreAfterRefresh(list.length, merged.length, FEED_PAGE, prevHas));
      const keepIds = merged.map((p) => p.id);
      // v4.32.128 perf: yield to UI between phases so FlatList can render the
      // first page before we start media/counts/view SQL work. Without these
      // yields the whole sequence ran as one microtask-chain and showed up as
      // a 2+ сек js_thread_blocked spike on the 60-сек feed tick.
      await new Promise<void>((r) => setTimeout(r, 0));
      if (!isMountedRef.current || loadVersionRef.current !== myVersion) return;
      const tB = Date.now();
      setUnread(await getUnreadFeedCount());
      log.info('ui_feed_load_unread_done', { ms: Date.now() - tB });
      // v4.32.29: resolve media URIs (inline:* → data:, остальные → gateway).
      if (list.length > 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
        if (!isMountedRef.current || loadVersionRef.current !== myVersion) return;
        const tM = Date.now();
        const map = await resolveFeedMediaUris(
          list.map((p) => ({ id: p.id, mediaCids: p.mediaCids })),
          gateway || null,
        );
        log.info('ui_feed_load_media_done', { ms: Date.now() - tM, n: Object.keys(map).length });
        if (isMountedRef.current)
          setMediaUrlsMap((prev) => {
            const next = mergeByRowId(prev, map, keepIds);
            return jsonEq(prev, next) ? prev : next;
          });
      } else {
        setMediaUrlsMap((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      }
      // Load comment counts for all posts
      if (list.length > 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
        if (!isMountedRef.current || loadVersionRef.current !== myVersion) return;
        const tC = Date.now();
        const counts = await getFeedCommentCounts(list.map((p) => p.id));
        log.info('ui_feed_load_counts_done', { ms: Date.now() - tC, n: counts ? Object.keys(counts).length : 0 });
        if (isMountedRef.current)
          setCommentCounts((prev) => {
            const next = mergeByRowId(prev, counts ?? {}, keepIds);
            return jsonEq(prev, next) ? prev : next;
          });
      }
      // v4.32.68: счётчики просмотров — только для своих постов (у чужих всегда 0 в локальной БД).
      if (list.length > 0) {
        const ownIds = list.filter((p) => p.authorDid === did).map((p) => p.id);
        if (ownIds.length > 0) {
          await new Promise<void>((r) => setTimeout(r, 0));
          if (!isMountedRef.current || loadVersionRef.current !== myVersion) return;
          const vc = await getFeedPostViewCountsMap(ownIds);
          if (isMountedRef.current)
            setViewCounts((prev) => {
              const next = mergeByRowId(prev, vc, keepIds);
              return jsonEq(prev, next) ? prev : next;
            });
        }
      }
    } catch (e) {
      log.warn('feed_load_failed', { err: rawErrorText(e) });
    } finally {
      if (isMountedRef.current) setInitialLoading(false);
      log.info('ui_feed_load_end', { totalMs: Date.now() - t0 });
    }
  }, [gateway, did]);

  /**
   * Перечитать то, что показывает лента, после удавшейся правки.
   *
   * v4.32.534: хвост «перечитать ленту, а если открыт архив — ещё и его» стоял
   * дословно в четырёх местах и в одном из них уже разъехался. Один источник
   * правды вместо четырёх копий.
   */
  const reloadFeedLists = useCallback(async () => {
    await loadFeed();
    if (archiveFilter) {
      await listArchivedFeedPosts().then(applyIfRead(setArchivedPosts, 'archive_reload'));
    }
  }, [loadFeed, archiveFilter]);

  /**
   * Действие над публикацией: сначала записать, потом показать записанное.
   *
   * Ошибку самой операции отделяем от ошибки перечитывания: запись уже прошла,
   * и говорить «не удалось удалить» из-за неудавшегося перечитывания было бы
   * неправдой. Так же устроен список групп (v4.32.531).
   */
  const runFeedOp = useCallback((op: () => Promise<unknown>, fallback: string): void => {
    void (async () => {
      try {
        await op();
      } catch (e) {
        showError(userErrorText(e, fallback));
        return;
      }
      try {
        await reloadFeedLists();
      } catch (e) {
        log.warn('feed_reload_after_op_failed', { err: rawErrorText(e) });
      }
    })();
  }, [reloadFeedLists]);

  const loadMoreFeed = useCallback(async () => {
    if (feedLoadingMore.current || !feedHasMore || feedSearch.trim() || activeHashtag || bookmarkFilter || archiveFilter) return;
    feedLoadingMore.current = true;
    // v4.32.47: race-guard — фиксируем версию loadFeed на старте подгрузки.
    const startVersion = loadVersionRef.current;
    try {
      const page = await loadFeedPosts(FEED_PAGE, feedOffset);
      if (!isMountedRef.current) return;
      if (loadVersionRef.current !== startVersion) {
        log.info('ui_feed_load_more_superseded', { startVersion, current: loadVersionRef.current });
        return;
      }
      // v4.32.528: про конец ленты неудавшееся чтение не знает ничего, поэтому
      // гасить подгрузку из-за него нельзя — иначе одна блокировка базы
      // навсегда обрезает ленту до уже показанного.
      const decision = decidePage(page, FEED_PAGE);
      if (decision.endOfList) setFeedHasMore(false);
      if (!decision.apply || page === null) {
        if (!decision.apply && !decision.endOfList) log.warn('ui_feed_load_more_read_failed', { offset: feedOffset });
        return;
      }
      const more = page;
      setPosts((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        const newPosts = more.filter((p) => !existingIds.has(p.id));
        return [...prev, ...newPosts];
      });
      setFeedOffset((prev) => prev + more.length);
      // v4.32.29: подгрузить media URIs для новой страницы постов.
      // v4.32.538: версия проверялась ОДИН раз — сразу после чтения страницы, —
      // а дальше шли ещё три ожидания. Обновление ленты, начавшееся в это
      // время, успевало заменить список и подрезать карты по видимым записям
      // (`mergeByRowId`), после чего строчки ниже возвращали в них сведения о
      // записях, которых на экране уже нет: карты росли до конца сессии.
      // Сюда же попадала запись в состояние после ухода с экрана.
      const stillOurs = (): boolean => isMountedRef.current && loadVersionRef.current === startVersion;
      const moreMap = await resolveFeedMediaUris(
        more.map((p) => ({ id: p.id, mediaCids: p.mediaCids })),
        gateway || null,
      );
      if (!stillOurs()) return;
      if (Object.keys(moreMap).length > 0) {
        setMediaUrlsMap((prev) => ({ ...prev, ...moreMap }));
      }
      // Load comment counts for new posts
      const counts = await getFeedCommentCounts(more.map((p) => p.id));
      if (!stillOurs()) return;
      setCommentCounts((prev) => ({ ...prev, ...counts }));
      // v4.32.68: view counts для своих постов новой страницы.
      const ownIds = more.filter((p) => p.authorDid === did).map((p) => p.id);
      if (ownIds.length > 0) {
        const vc = await getFeedPostViewCountsMap(ownIds);
        if (!stillOurs()) return;
        setViewCounts((prev) => ({ ...prev, ...vc }));
      }
    } catch (e) {
      log.warn('feed_load_more_failed', { err: rawErrorText(e) });
    } finally {
      feedLoadingMore.current = false;
    }
  }, [feedOffset, feedHasMore, feedSearch, activeHashtag, bookmarkFilter, archiveFilter, gateway, did]);

  useEffect(() => {
    // v4.32.226: defer the (heavy, multi-phase) feed load until pending
    // interactions settle. The first load after launch fires several urgent
    // setState passes that each re-render the keep-alive screen tree and
    // saturate the JS thread; a bottom-tab tap landing in that window had its
    // touch-responder negotiation dropped — "загрузка ленты поглощала тапы".
    // runAfterInteractions lets an in-flight tap commit its navigation first.
    const handle = InteractionManager.runAfterInteractions(() => {
      void loadFeed();
    });
    return () => handle.cancel();
  }, [loadFeed, pair, did, feedTick]);

  useEffect(() => {
    void listContacts().then(setAllContacts);
  }, []);

  useEffect(() => {
    // v4.32.47: при смене профиля (did change) сбрасываем optimistic-список
    // И mediaUrlsMap (resolved inline/IPFS URI из прошлого профиля — могут показать
    // чужие data:base64 до первого loadFeed нового профиля).
    setOptimisticPosts([]);
    setMediaUrlsMap({});
    setArchivedPosts([]);
    setBookmarkedPosts([]);
    setCommentCounts({});
    setTranslatedPosts({});
    setViewCounts({});
  }, [did]);

  useEffect(() => {
    void flushFeedPublishQueue(pair);
  }, [pair]);

  // v4.32.15: effect создаётся один раз при mount; gate через isActiveRef внутри callback.
  useEffect(() => {
    const refreshQueue = (): void => {
      if (tabRef.current !== 'feed') return;
      // v4.32.128 perf: skip queue poll while app is backgrounded — OS timers
      // still fire but SQLite work adds latency on resume.
      if (AppState.currentState !== 'active') return;
      void getFeedPublishQueueLength(pair).then((len) => { if (isMountedRef.current) setQueueLen(len); });
    };
    refreshQueue();
    const qInterval = setInterval(refreshQueue, 12_000);
    return () => clearInterval(qInterval);
  }, [tabRef, pair]);

  // v4.32.15: 60-сек tick живёт всё время mount; работа внутри tick стартует только
  // если вкладка активна — но НЕ через cleanup/setup useEffect (которые давали 2.2с блок).
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (tabRef.current !== 'feed') return;
      // v4.32.128 perf: skip tick work while backgrounded — resume-path triggers
      // its own refresh via the AppState listener, so fires here are pure waste.
      if (AppState.currentState !== 'active') return;
      // v4.32.128 perf: defer the tick until gestures/animations settle; the
      // SQLite + media-resolve chain was showing up as a single ~2.2с block
      // every minute on cold-start, exactly when React was still rendering
      // the keep-alive sibling tabs.
      await new Promise<void>((r) => InteractionManager.runAfterInteractions(() => r()));
      if (tabRef.current !== 'feed' || AppState.currentState !== 'active') return;
      const t0 = Date.now();
      log.info('ui_feed_tick_start', { ts: t0 });
      try {
        const t1 = Date.now();
        await flushFeedPublishQueue(pair);
        log.info('ui_feed_tick_flush_done', { ms: Date.now() - t1 });
        await new Promise<void>((r) => setTimeout(r, 0));
        if (tabRef.current !== 'feed') return;
        const t2 = Date.now();
        const len = await getFeedPublishQueueLength(pair);
        if (isMountedRef.current) setQueueLen(len);
        log.info('ui_feed_tick_qlen_done', { ms: Date.now() - t2, len });
        await new Promise<void>((r) => setTimeout(r, 0));
        if (tabRef.current !== 'feed') return;
        const t3 = Date.now();
        await loadFeed();
        log.info('ui_feed_tick_load_done', { ms: Date.now() - t3 });
      } catch (e) {
        log.warn('ui_feed_tick_err', { err: rawErrorText(e) });
      } finally {
        log.info('ui_feed_tick_end', { totalMs: Date.now() - t0 });
      }
    };
    void tick();  // initial run (mount == first visit == isActive=true под lazy keep-alive)
    const id = setInterval(() => void tick(), 60_000);
    return () => clearInterval(id);
  }, [pair, loadFeed, tabRef]);

  useEffect(() => {
    const sub = Network.addNetworkStateListener((state) => {
      if (state.isConnected) {
        flushFeedQueueNow(pair);
        void getFeedPublishQueueLength(pair).then((len) => { if (isMountedRef.current) setQueueLen(len); });
      }
    });
    return () => sub.remove();
  }, [pair]);

  useEffect(() => {
    const onShow = (_e: KeyboardEvent) => {
      setKeyboardVisible(true);
      setTimeout(() => {
        modalScrollRef.current?.scrollToEnd({ animated: true });
      }, 120);
    };
    const onHide = () => {
      setKeyboardVisible(false);
    };
    const subShow = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      onShow
    );
    const subHide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      onHide
    );
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  // v4.32.130 (AUDIT P2): prevent concurrent pull-to-refresh from firing two
  // loadFeed() chains — second invocation used to race the first's
  // setRefreshing(false) and leave the spinner in an indeterminate state.
  const refreshLockRef = useRef(false);
  const onRefresh = useCallback(async () => {
    if (refreshLockRef.current) return;
    refreshLockRef.current = true;
    setRefreshing(true);
    try {
      await loadFeed();
    } finally {
      setRefreshing(false);
      refreshLockRef.current = false;
    }
  }, [loadFeed]);

  const handleCloseModal = useCallback(() => {
    setDraft('');
    setUris([]);
    setIsPollMode(false);
    setPollQuestion('');
    setPollOptions(['', '']);
    setPollAnonymous(false);
    setPollMultiSelect(false);
    setFeedEmojiSuggestions([]);
    setHashtagSuggestions([]);
    setMentionSuggestions([]);
    setPostLocationTag(null);
    setEditingPost(null);
    setModalOpen(false);
  }, []);

  // v4.32.91: Android-back / свайп по фону НЕ должен стирать черновик — только закрывает
  // модалку. Явный «Закрыть»/«Отмена» в header остаётся через handleCloseModal.
  const handleSoftDismissModal = useCallback(() => {
    setModalOpen(false);
  }, []);

  /** Wrap selected text (or insert at cursor) with markdown markers */
  const formatDraftText = useCallback((prefix: string, suffix: string) => {
    const { start, end } = draftSelection;
    const selected = draft.slice(start, end);
    const newText = draft.slice(0, start) + prefix + selected + suffix + draft.slice(end);
    setDraft(newText);
    // Move cursor after inserted text
    const newCursor = start + prefix.length + selected.length + suffix.length;
    setTimeout(() => {
      draftInputRef.current?.setNativeProps?.({ selection: { start: newCursor, end: newCursor } });
    }, 50);
  }, [draft, draftSelection]);

  const onPublish = useCallback(() => {
    // v4.32.25: smoke log — подтверждает что onPress ДОШЁЛ до колбэка. Если в adb-логах
    // после тапа «Опубликовать» нет `ui_feed_publish_clicked` — значит useAsyncButton /
    // AppPressable не вызвал handler (throttle-lock, модал закрыт, pair=null).
    log.info('ui_feed_publish_clicked', {
      hasEditingPost: !!editingPost,
      isPollMode,
      draftLen: draft.length,
      urisLen: uris.length,
      publishLocked: publishLockRef.current,
      hasPair: !!pair,
      did: did?.slice(0, 24),
    });
    // Edit existing post (text-only update, local)
    if (editingPost) {
      const newText = draft.trim();
      if (!newText) { showError(t('feed.textEmpty')); return; }
      if (publishLockRef.current) return;
      publishLockRef.current = true;
      void editFeedPost(pair, editingPost.id, newText).then(() => {
        publishLockRef.current = false;
        setDraft('');
        setEditingPost(null);
        setModalOpen(false);
        void loadFeed();
      }).catch((e: unknown) => {
        publishLockRef.current = false;
        showError(userErrorText(e, 'Не удалось изменить запись'));
      });
      return;
    }
    // Poll publish
    if (isPollMode) {
      const q = pollQuestion.trim();
      const opts = pollOptions.map((o) => o.trim()).filter(Boolean);
      if (!q) { showError(t('feed.pollQuestionEmpty')); return; }
      if (opts.length < 2) { showError(t('feed.pollNeedTwo')); return; }
      if (publishLockRef.current) return;
      publishLockRef.current = true;
      // v4.32.48: makePollText теперь бросает PollValidationError при превышении лимитов
      // (>12 вариантов, >256 символов в вопросе, >100 в варианте). Ловим и показываем UI.
      let pollText: string;
      try {
        pollText = makePollText(q, opts, undefined, pollAnonymous, pollMultiSelect);
      } catch (err) {
        publishLockRef.current = false;
        showError(userErrorText(err, 'Проверьте вопрос и варианты ответа'));
        return;
      }
      void profileManager.init().then(() => {
        const name = profileManager.getActiveProfile()?.name?.trim() || t('common.you');
        const optimisticId = `opt_${Date.now()}`;
        const opt: FeedPostRow = {
          id: optimisticId, authorDid: did, authorName: name, text: pollText,
          mediaCids: null, timestamp: Date.now(), read: 1, cid: null,
          reactions: null, repostOf: null, repostAuthorName: null, repostAuthorDid: null,
        };
        setOptimisticPosts((p) => [opt, ...p]);
        setModalOpen(false);
        setIsPollMode(false);
        setPollQuestion('');
        setPollOptions(['', '']);
        setPollAnonymous(false);
        setPollMultiSelect(false);
        void publishFeedPost(pair, { text: pollText }).then(() => {
          setOptimisticPosts((p) => p.filter((x) => x.id !== optimisticId));
          publishLockRef.current = false;
        }).catch((e: unknown) => {
          setOptimisticPosts((p) => p.filter((x) => x.id !== optimisticId));
          showError(userErrorText(e, 'Не удалось опубликовать опрос'));
          publishLockRef.current = false;
        });
      });
      return;
    }

    if (!draft.trim() && uris.length === 0 && pickedDocs.length === 0) {
      showError(t('feed.needContent'));
      return;
    }
    if (publishLockRef.current) return;
    publishLockRef.current = true;

    const locationSuffix = postLocationTag ? `\n\n📍 ${postLocationTag}` : '';
    const textSnap = (draft.trim() || ' ') + locationSuffix;
    const urisSnap = [...uris];
    // v4.32.48: snapshot документов (очищаем state СРАЗУ, чтобы повторный тап не
    //           отправил те же файлы дважды — это важно для retry UX).
    const docsSnap = pickedDocs.slice();

    setDraft('');
    setUris([]);
    setPickedDocs([]);
    setFeedEmojiSuggestions([]);
    setHashtagSuggestions([]);
    setPostLocationTag(null);
    setModalOpen(false);

    void profileManager.init().then(() => {
      const name = profileManager.getActiveProfile()?.name?.trim() || t('common.you');
      // v4.32.47: единый префикс `opt_` для оптимистических постов (до подтверждения
      // envelope). Проверка isPending в renderItem через startsWith('opt_').
      const tempId = `opt_${Date.now()}`;
      const optimistic: FeedPostRow = {
        id: tempId,
        authorDid: did,
        authorName: name,
        text: textSnap,
        mediaCids: null,
        timestamp: Date.now(),
        read: 1,
        cid: null,
        reactions: null,
        repostOf: null,
        repostAuthorName: null,
        repostAuthorDid: null,
      };
      setOptimisticPosts((prev) => [optimistic, ...prev]);
      setPublishing(true);

      /** Без `InteractionManager.runAfterInteractions`: очередь «после взаимодействий» откладывала работу при загруженном JS и ощущалась как лаг кнопок. Публикация асинхронная — не блокирует UI. */
      void (async () => {
        try {
          const result = await measurePerformance('feed_publish', () =>
            publishFeedPost(pair, {
              text: textSnap,
              imageUris: urisSnap.length ? urisSnap : undefined,
              authorName: name,
              documents: docsSnap.length ? docsSnap : undefined,
            })
          );
          setOptimisticPosts((prev) => prev.filter((p) => p.id !== tempId));
          if (result.ok) {
            if ('queued' in result && result.queued) {
              showSuccess(t('feed.publishedQueued'));
            } else {
              showSuccess(t('feed.published'));
            }
            // v4.32.48: предупреждение если часть фото была дропнута из-за размера,
            // но пост всё же опубликовался (текст + остальные фото).
            if (result.mediaDropped && result.mediaDropped > 0) {
              Alert.alert(
                t('feed.mediaPartialSkipped'),
                t('feed.mediaDroppedDetail', { count: result.mediaDropped })
              );
            }
            void getFeedPublishQueueLength(pair).then(setQueueLen);
            await loadFeed();
          } else if (result.reason === 'too_large') {
            // v4.32.48: явный Alert при отказе из-за размера — раньше показывался generic
            // «Не удалось опубликовать» и пост молча оставался в БД без ретрая (dead entry).
            Alert.alert(
              t('feed.postTooLarge'),
              t('feed.postTooLargeDetail')
            );
            // Возвращаем черновик и URIs, чтобы пользователь мог скорректировать.
            setDraft(textSnap);
            setUris(urisSnap);
            setPickedDocs(docsSnap);
          } else {
            // v4.32.91: retry с сохранением черновика — раньше юзер терял текст/медиа
            // при ошибке сети, приходилось перенабирать. Теперь драфт возвращается
            // и есть кнопка «Повторить» прямо из Alert.
            setDraft(textSnap);
            setUris(urisSnap);
            setPickedDocs(docsSnap);
            Alert.alert(
              t('feed.publishFailed'),
              t('feed.publishFailedDetail'),
              [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('common.retry'), onPress: () => { setModalOpen(true); } },
              ],
            );
          }
        } catch (e) {
          const msg = rawErrorText(e);
          log.error('feed_publish_ui_failed', { err: msg });
          // v4.32.91: возвращаем драфт и при throw — иначе контент теряется.
          setDraft(textSnap);
          setUris(urisSnap);
          setPickedDocs(docsSnap);
          showError(msg);
          setOptimisticPosts((prev) => prev.filter((p) => p.id !== tempId));
        } finally {
          setPublishing(false);
          publishLockRef.current = false;
          void getFeedPublishQueueLength(pair).then(setQueueLen);
        }
      })();
    });
  }, [pair, draft, uris, pickedDocs, did, loadFeed, editingPost, isPollMode, pollQuestion, pollOptions, pollAnonymous, pollMultiSelect, postLocationTag, t]);

  // Защита от двойного нажатия «Опубликовать»
  const { onPress: handlePublish } = useAsyncButton(
    useCallback(async () => { onPublish(); }, [onPublish]),
    { throttleMs: 500 },
  );

  const allPosts = useMemo(() => {
    const merged = [...optimisticPosts, ...posts];
    if (mutedAuthors.size === 0) return merged;
    return merged.filter((p) => !mutedAuthors.has(p.authorDid));
  }, [optimisticPosts, posts, mutedAuthors]);
  // ─── Trending hashtags ─────────────────────────────────────────────────────
  const trendingHashtags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of allPosts) {
      const matches = (p.text ?? '').match(/#([a-zа-яё0-9_]+)/gi) ?? [];
      for (const tag of matches) {
        const t = tag.toLowerCase();
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag]) => tag);
  }, [allPosts]);

  const listData = useMemo(() => {
    // v4.32.34: приоритет режимов — архив → закладки → основная лента.
    let result = archiveFilter ? archivedPosts : (bookmarkFilter ? bookmarkedPosts : allPosts);
    if (activeHashtag) {
      result = result.filter((p) => (p.text ?? '').toLowerCase().includes(activeHashtag.toLowerCase()));
    }
    if (feedSearch.trim()) {
      const q = feedSearch.toLowerCase();
      result = result.filter((p) => (p.text ?? '').toLowerCase().includes(q));
    }
    return result;
  }, [allPosts, feedSearch, activeHashtag, bookmarkFilter, bookmarkedPosts, archiveFilter, archivedPosts]);

  const persistComposeDraft = useCallback(async () => {
    await saveComposeDraft(did, {
      draft,
      uris,
      pickedDocs,
      postLocationTag,
      isPollMode,
      pollQuestion,
      pollOptions,
      editingPostId: editingPost?.id ?? null,
    });
  }, [did, draft, uris, pickedDocs, postLocationTag, isPollMode, pollQuestion, pollOptions, editingPost]);
  const clearComposeDraft = useCallback(async () => {
    await clearPersistedComposeDraft(did);
  }, [did]);

  // v4.32.48: прикрепить документ (PDF/DOC/XLSX/любой). Ограничения жёсткие,
  //           потому что envelope ≤2MB и должен влезать в broadcast всем контактам.
  // v4.32.321: снимок черновика перед запуском picker'а — ровно по той же
  // причине, что и у фото (см. pickImages). DocumentPicker открывает системную
  // активити, наша уходит в фон и может её не пережить; до сих пор из трёх
  // способов приложить что-нибудь к записи снимок делал только один, и человек,
  // выбиравший документ, терял весь набранный текст. Сам выбранный документ
  // так не вернуть — у DocumentPicker нет getPendingResultAsync, — но текст,
  // фото и гео-метка переживают перезапуск.
  const pickDocs = useCallback(async () => {
    if (pickedDocs.length >= FEED_MAX_DOCS) {
      Alert.alert(t('common.airchat'), t('feed.docTooMany', { max: FEED_MAX_DOCS }));
      return;
    }
    try {
      await persistComposeDraft();
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: '*/*',
      });
      await clearComposeDraft();
      if (res.canceled || !res.assets?.length) return;
      const { picked, tooBig, noRoom } = selectComposeDocs(res.assets, pickedDocs.length);
      if (picked.length) setPickedDocs((prev) => [...prev, ...picked].slice(0, FEED_MAX_DOCS));
      // Одним окном, а не двумя подряд: на Android второй Alert встаёт поверх
      // первого и первый человек не успевает прочитать.
      const skipped: string[] = [];
      if (tooBig > 0) skipped.push(t('feed.docSkippedTooBig', { count: tooBig }));
      if (noRoom > 0) skipped.push(t('feed.docSkippedNoRoom', { count: noRoom, max: FEED_MAX_DOCS }));
      if (skipped.length) {
        Alert.alert(
          picked.length ? t('feed.docPartialSkippedTitle') : t('feed.docNoneAddedTitle'),
          skipped.join('\n')
        );
      }
    } catch (e) {
      log.warn('ui_feed_pick_doc_failed', { err: rawErrorText(e) });
      showError(t('feed.docPickFailed'));
    }
  }, [pickedDocs.length, persistComposeDraft, clearComposeDraft, t]);

  /**
   * Снимок камеры (v4.32.321). Раньше жил прямо в обработчике долгого нажатия
   * и был единственным способом приложить фото без снимка черновика — притом
   * самым опасным: камера тяжелее галереи, и активити под ней перезапускается
   * чаще всего. Заодно исчезли две мелочи: необработанное исключение
   * (`launchCameraAsync` бросает — обещание в `void (async …)()` некому ловить)
   * и молчание в ответ на удачный снимок, хотя из галереи фото подтверждается.
   */
  const takePhoto = useCallback(async () => {
    if (uris.length >= FEED_MAX_IMAGES) {
      showError(t('feed.photoLimit', { max: FEED_MAX_IMAGES }));
      return;
    }
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        showPermissionDeniedAlert(t('feed.cameraPermTitle'), t('feed.cameraPermMsg'));
        return;
      }
      await persistComposeDraft();
      // v4.32.54: quality 1 — см. pickImages, избегаем CompressionImageExporter crash.
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 1,
        exif: false,
      });
      await clearComposeDraft();
      const uri = res.canceled ? null : res.assets?.[0]?.uri;
      if (!uri) return;
      setUris((prev) => [...prev, uri].slice(0, FEED_MAX_IMAGES));
      showSuccess(t('feed.photoAdded'));
    } catch (e) {
      log.warn('ui_feed_camera_failed', { err: rawErrorText(e) });
      showError(t('feed.photoPickFailed'));
    }
  }, [uris.length, persistComposeDraft, clearComposeDraft, t]);

  const pickImages = useCallback(async () => {
    // v4.32.54: Telegram-style multi-select с лимитом 10 + фикс NoSuchMethodError.
    //
    // Про лимит: в Telegram/WhatsApp/Instagram пользователи привыкли к лимиту ~10
    // фото на публикацию. Больше — становится тяжёлым для ленты, превью теряют смысл.
    // `selectionLimit: FEED_MAX_IMAGES` прокидывается в системный picker (MediaStore
    // photo picker на Android 13+ / ACTION_GET_CONTENT на старых версиях) — он сам
    // дизейблит выделение лишних. После возврата всё равно проверяем total (защита
    // на случай если picker проигнорировал лимит + юзер может добавить фото несколькими
    // вызовами).
    //
    // Про quality: 1 (было 0.6) — **критический фикс NoSuchMethodError в expo-image-picker
    // 16.1.4 vs expo-modules-core 55.0.17**. При quality<1 expo-image-picker выбирает
    // `CompressionImageExporter`, который зовёт `AppContext.imageLoader` (extension-
    // свойство из **отсутствующей** в 55.0.17 версии). Крэш:
    //   `NoSuchMethodError: getImageLoader()Lexpo/modules/interfaces/imageloader/...`
    // При quality === MAXIMUM_QUALITY (=1) MediaHandler выбирает `RawImageExporter` —
    // никакого `imageLoader` не вызывается, нет крэша. Размер фото контролирует
    // `readMediaAsBase64` (лимит в публикации сам отфильтрует слишком большие — юзер
    // увидит «Часть фото пропущена»).
    log.info('ui_feed_pick_images_enter', { existingUris: uris.length });
    const remainingSlots = FEED_MAX_IMAGES - uris.length;
    if (remainingSlots <= 0) {
      showError(t('feed.photoLimit', { max: FEED_MAX_IMAGES }));
      return;
    }
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        log.info('ui_feed_pick_images_perm_denied');
        showPermissionDeniedAlert(t('feed.photoPermTitle'), t('feed.photoPermMsg'));
        return;
      }
      // v4.32.73: persist draft до вызова picker'а — если host-activity будет
      // recreated (realme/Android 15), мы восстановим состояние на следующем mount'е.
      await persistComposeDraft();
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: remainingSlots,
        quality: 1,
        exif: false,
      });
      log.info('ui_feed_pick_images_result', {
        canceled: res.canceled,
        assetCount: res.assets?.length ?? 0,
      });
      // v4.32.73: штатный путь — picker вернулся в живую activity. Сбрасываем
      // persisted draft, чтобы recovery-effect на следующем mount'е не сработал
      // по устаревшему snapshot'у.
      await clearComposeDraft();
      if (res.canceled || !res.assets?.length) return;
      let rawUris = res.assets.map((a) => a.uri);
      // Жёсткая защита — даже если picker проигнорировал selectionLimit,
      // не добавляем больше чем помещается в лимит.
      let truncated = 0;
      if (rawUris.length > remainingSlots) {
        truncated = rawUris.length - remainingSlots;
        rawUris = rawUris.slice(0, remainingSlots);
      }
      // v4.32.55 hotfix: пропускаем ImageManipulator — expo-image-manipulator 14.0.8
      // несовместим с expo-modules-core 55.0.17 (NoSuchMethodError: getRuntimeContext),
      // каждый вызов падает. Raw URI → readMediaAsBase64 с 800KB лимитом сам фильтрует
      // крупные фото: picker уже дал quality:1, современные камеры шлют JPEG ~1-3MB —
      // только слишком тяжёлые дропаются с предупреждением.
      const processedUris: string[] = [...rawUris];
      setUris((prev) => [...prev, ...processedUris]);
      // Авто-скролл превью в видимую область (обычно в конце формы).
      requestAnimationFrame(() => {
        try { modalScrollRef.current?.scrollToEnd({ animated: true }); } catch { /* ignore */ }
      });
      // Визуальное подтверждение — юзер сразу видит что фото принято.
      if (truncated > 0) {
        showSuccess(t('feed.photoAddedLimit', { count: processedUris.length, max: FEED_MAX_IMAGES }));
      } else {
        showSuccess(processedUris.length === 1 ? t('feed.photoAdded') : t('feed.photoAddedN', { count: processedUris.length }));
      }
    } catch (e) {
      const msg = rawErrorText(e);
      log.warn('ui_feed_pick_images_failed', { err: msg });
      showError(t('feed.photoPickFailed'));
    }
  }, [uris.length, persistComposeDraft, clearComposeDraft, t]);

  // v4.32.69: сброс session-dedup'а просмотров при смене профиля.
  // v4.32.157: аналогичный dedup для локального markFeedPostRead — чтобы
  // не гонять UPDATE на каждом onViewableItemsChanged-тике.
  const markedReadRef = useRef(createReceiptClaims());
  useEffect(() => {
    sentViewRef.current = createReceiptClaims();
    markedReadRef.current = createReceiptClaims();
  }, [did]);

  // v4.32.69: ref со свежими pair/did — onViewableItemsChanged создаётся один раз
  // (см. requirement RN FlatList: ссылка должна быть стабильной), закрытая closure
  // захватит значения первого рендера. Через ref каждый вызов читает актуальные.
  const viewCtxRef = useRef({ pair, did });
  viewCtxRef.current = { pair, did };

  // v4.32.69: viewability config + handler. 60% площади поста на экране >=800мс =
  // это «просмотр». Срабатывает один раз за сессию per (postId, myDid) — повторные
  // всплытия не шлют envelope. notifyFeedPostViewed сам делает self-skip (мой пост
  // не считается) + kvStore-guard (персистентная защита между сессиями).
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 60,
    minimumViewTime: 800,
    waitForInteraction: false,
  }).current;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item: FeedPostRow; isViewable: boolean }> }) => {
      const ctx = viewCtxRef.current;
      const myName = profileManager.getActiveProfile()?.name?.trim() || t('common.contact');
      // v4.32.157: локальная отметка «прочитано» для каждого видимого поста —
      // до этого баннер «N непрочитанных — обновить» не исчезал после тапа,
      // потому что loadFeed() лишь перезагружал посты, а read=0 оставалось.
      // Теперь по мере прокрутки посты помечаются read=1, и баннер уходит.
      let markedCount = 0;
      for (const v of viewableItems) {
        if (!v.isViewable) continue;
        const post = v.item;
        if (!post || !post.id) continue;
        if (post.id.startsWith('opt_') || post.id.startsWith('temp-')) continue;
        if (markedReadRef.current.claim([post.id]).length === 0) continue;
        const readId = post.id;
        void markFeedPostRead(readId).then((ok) => {
          // Не легло в базу — снимаем заявку, чтобы следующее всплытие этой
          // записи попробовало снова. Иначе счётчик непрочитанного до конца
          // сессии расходился бы с тем, что человек уже прочитал.
          if (!ok) markedReadRef.current.release([readId]);
        });
        markedCount++;
      }
      if (markedCount > 0) {
        void getUnreadFeedCount().then((n) => {
          if (isMountedRef.current) setUnread(n);
        });
      }
      // v4.32.69: feed_view envelope — отправляется автору поста (не-своего, один раз).
      if (!ctx.pair) return;
      for (const v of viewableItems) {
        if (!v.isViewable) continue;
        const post = v.item;
        if (!post || !post.id || !post.authorDid) continue;
        if (post.id.startsWith('opt_') || post.id.startsWith('temp-')) continue;
        if (post.authorDid === ctx.did) continue;
        if (sentViewRef.current.claim([post.id]).length === 0) continue;
        const viewId = post.id;
        void notifyFeedPostViewed(ctx.pair, { id: viewId, authorDid: post.authorDid }, myName)
          .then((done) => {
            if (!done) sentViewRef.current.release([viewId]);
          })
          .catch(() => {
            sentViewRef.current.release([viewId]);
          });
      }
    }
  ).current;

  const handleReaction = useCallback(
    (postId: string, emoji: string) => {
      setReactionTarget(null);

      // v4.32.356: по этому посту реакция ещё в полёте. run() такой вызов
      // отбросит — значит, и оптимистичную правку применять нельзя: откатывать
      // её будет некому, и лента до перезагрузки показывала бы эмодзи, который
      // никуда не ушёл.
      if (reactionAction.isActive(postId)) return;

      Vibration.vibrate(40);

      // Optimistic update — UI реагирует мгновенно, не ждём сети/IPFS
      setPosts((prev) =>
        prev.map((p) => (p.id !== postId ? p : applyOptimisticReaction(p, emoji, did)))
      );
      setOptimisticPosts((prev) =>
        prev.map((p) => (p.id !== postId ? p : applyOptimisticReaction(p, emoji, did)))
      );

      // v4.32.29: toggle-реакция — повторный клик по уже поставленному эмодзи снимает её.
      // useKeyedAsyncAction: per-post защита + rAF-defer, тяжёлая работа не блокирует UI.
      reactionAction.run(postId, async () => {
        try {
          await toggleAndBroadcastReaction(pair, postId, emoji);
          void loadFeed();
        } catch (e) {
          // Откатываем optimistic update при ошибке сети
          setPosts((prev) =>
            prev.map((p) => (p.id !== postId ? p : revertOptimisticReaction(p, emoji, did)))
          );
          setOptimisticPosts((prev) =>
            prev.map((p) => (p.id !== postId ? p : revertOptimisticReaction(p, emoji, did)))
          );
          log.warn('feed_reaction_failed', { err: rawErrorText(e) });
        }
      });
    },
    [did, pair, loadFeed, reactionAction]
  );

  const handleRepost = useCallback(
    (post: FeedPostRow) => {
      // v4.32.587: репост публикует запись заново от своего имени. У
      // непрочитанной записи наружу ушла бы пустота, подписанная её автором.
      if (!mayRepublishFeedPost(post)) {
        showError(UNREADABLE_POST_ACTION_TEXT);
        return;
      }
      if (post.authorDid === did) {
        Alert.alert(t('common.airchat'), t('feed.repostNoSelf'));
        return;
      }
      Vibration.vibrate(40);

      // useKeyedAsyncAction: per-post защита (можно репостить разные посты параллельно)
      repostAction.run(post.id, async () => {
        await profileManager.init();
        const name = profileManager.getActiveProfile()?.name?.trim() || t('common.you');
        try {
          const result = await publishRepost(pair, { originalPost: post, authorName: name });
          if (result.ok) {
            // v4.32.554: репост без сети больше не теряется — он лежит в
            // очереди повторов. Показывать «опубликован» в этом случае было бы
            // неправдой: контакты его ещё не получили.
            showSuccess(t('queued' in result && result.queued ? 'feed.repostQueued' : 'feed.repostPublished'));
            void loadFeed();
          } else {
            showError(t('feed.repostFailed'));
          }
        } catch (e) {
          log.warn('feed_repost_failed', { err: rawErrorText(e) });
          showError(t('feed.repostFailed'));
        }
      });
    },
    [did, pair, loadFeed, repostAction, t]
  );

  const openComments = useCallback(async (post: FeedPostRow) => {
    const postId = post.id;
    setCommentPostId(postId);
    setCommentPost(post);
    // v4.32.116: sync ref immediately so subscribe .then() race-guard sees the
    // new postId even if it resolves before React commits the setState above.
    commentPostIdRef.current = postId;
    setCommentText('');
    setCommentsLoadedFor(null);
    setCommentsLoading(true);
    try {
      const list = await getFeedComments(postId);
      // v4.32.504: чтение из базы могло опоздать — человек уже открыл другой
      // пост. Раньше ответ ложился в состояние без вопросов, и под постом B
      // показывались комментарии поста A.
      setComments((prev) => acceptCommentList(commentPostIdRef.current, postId, list, prev));
      if (commentPostIdRef.current === postId) setCommentsLoadedFor(postId);
    } catch (e) {
      // v4.32.538: раньше сбой чтения подменялся пустым списком — человек
      // видел «комментариев нет» там, где их не смогли прочитать, и молча.
      log.warn('feed_comments_load_failed', { err: rawErrorText(e) });
      showError(t('feed.commentsLoadFailed'));
    } finally {
      if (commentPostIdRef.current === postId) setCommentsLoading(false);
    }
    setTimeout(() => commentInputRef.current?.focus(), 300);
    // v4.32.51: после загрузки комментариев прокручиваем к последнему (большинство
    // юзеров хотят видеть "что нового", а не читать с начала треда).
    setTimeout(() => {
      try { commentScrollRef.current?.scrollToEnd({ animated: false }); } catch { /* ignore */ }
    }, 150);
    // v4.32.114 T2: live-подписка на per-post топик. Любой коммент (даже от странgerа,
    // которого нет у нас в контактах) — после верификации подписи уйдёт в receiveFeedEnvelope,
    // который сохранит в SQL и бампнет feedTick → useEffect выше перезагрузит comments.
    try { commentTopicUnsubRef.current?.(); } catch { /* ignore */ }
    commentTopicUnsubRef.current = null;
    // v4.32.115: capture subscribedFor so if openComments(B) runs before A's
    // .then resolves, we drop A's stale unsub instead of overwriting B's.
    const subscribedFor = postId;
    void subscribeToPostCommentsTopic(postId, (frame, authorDid) => {
      void receiveFeedEnvelope(frame, authorDid).catch((e) => {
        log.warn('post_topic_dispatch_failed', { err: rawErrorText(e) });
      });
    }).then((unsub) => {
      if (!unsub) return;
      // If user already switched to another post (or closed), drop this unsub.
      if (commentPostIdRef.current !== subscribedFor) {
        try { unsub(); } catch { /* ignore */ }
        return;
      }
      commentTopicUnsubRef.current = unsub;
    });
  }, [t]);

  const closeComments = useCallback(() => {
    setCommentPostId(null);
    setCommentPost(null);
    // v4.32.116: sync ref immediately so a pending subscribe.then sees "closed".
    commentPostIdRef.current = null;
    setComments([]);
    setCommentsLoadedFor(null);
    setCommentText('');
    // v4.32.114 T2: закрываем pubsub-подписку чтобы не копить фоновые топики.
    try { commentTopicUnsubRef.current?.(); } catch { /* ignore */ }
    commentTopicUnsubRef.current = null;
  }, []);

  // v4.32.160 P2 audit #2: при смене профиля (did change) закрываем открытую
  // модалку комментариев. Иначе после логаута/свитча профиля комментарии от
  // прошлого did оставались видимыми, а pubsub-подписка (commentTopicUnsubRef)
  // держала топик старого поста.
  useEffect(() => {
    closeComments();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [did]);

  // v4.32.68: открыть модалку «Кто просмотрел» — грузит список viewer'ов для поста.
  const openViewers = useCallback(async (postId: string) => {
    setViewersPostId(postId);
    viewersPostIdRef.current = postId;
    setViewersList([]);
    setViewersLoading(true);
    try {
      const list = await listFeedPostViewers(postId);
      if (viewersPostIdRef.current !== postId) return;
      setViewersList(list);
    } catch {
      if (viewersPostIdRef.current === postId) setViewersList([]);
    } finally {
      if (viewersPostIdRef.current === postId) setViewersLoading(false);
    }
  }, []);

  const closeViewers = useCallback(() => {
    setViewersPostId(null);
    viewersPostIdRef.current = null;
    setViewersList([]);
  }, []);

  const submitComment = useCallback(async () => {
    if (!commentPostId || !commentText.trim() || commentSending) return;
    setCommentSending(true);
    try {
      const profile = await profileManager.getActiveProfile();
      const myName = profile?.name ?? t('common.anonymous');
      const row = await addAndBroadcastComment(pair, commentPostId, commentText.trim(), myName);
      // v4.32.161: dedup по id. addAndBroadcastComment внутри вызывает emitFeedUpdate()
      // → feedTick++ → live-reload useEffect (2003–2020) гонит getFeedComments из SQL,
      // который УЖЕ содержит row (save прошёл в ensureStorage перед emit). Если этот
      // reload успел отработать раньше строчки ниже — prev уже содержит row, и
      // безусловный append даёт визуальный дубль (видит юзер).
      setComments((prev) => appendOwnComment(commentPostIdRef.current, row, prev));
      // v4.32.538: счётчик под записью здесь больше не трогаем. Строчка выше
      // дописывает комментарий ТОЛЬКО если его ещё нет (перезагрузка треда по
      // тику ленты успевает положить его раньше — штатный случай), а единица
      // прибавлялась всегда: под записью «3», в треде два.
      setCommentText('');
      // v4.32.51: автоскролл к своему новому комментарию — юзер сразу видит его в ленте,
      // не нужно пролистывать вниз руками.
      requestAnimationFrame(() => {
        try { commentScrollRef.current?.scrollToEnd({ animated: true }); } catch { /* ignore */ }
      });
    } catch (e) {
      showError(userErrorText(e, t('common.error')));
    } finally {
      setCommentSending(false);
    }
  }, [commentPostId, commentText, commentSending, pair, t]);

  // v4.32.51: live-reload комментариев при входящем feed_comment envelope.
  // До этого юзер с открытой модалкой комментариев не видел новый ответ собеседника
  // пока не закроет и не откроет её заново. feedTick бампается в App.tsx/startFeedInboxListener.
  useEffect(() => {
    if (!commentPostId) return;
    let cancelled = false;
    const forPostId = commentPostId;
    void getFeedComments(forPostId)
      .then((list) => {
        if (cancelled) return;
        if (commentPostIdRef.current === forPostId) setCommentsLoadedFor(forPostId);
        setComments((prev) => {
          const next = acceptCommentList(commentPostIdRef.current, forPostId, list, prev);
          // Не пересоздаём массив, если смотреть не на что: пересозданный
          // список теряет позицию прокрутки в открытом треде.
          if (next === prev || commentListUnchanged(prev, next)) return prev;
          // Если пришёл новый комментарий — скроллим в конец.
          if (commentListGrew(prev, next)) {
            requestAnimationFrame(() => {
              try { commentScrollRef.current?.scrollToEnd({ animated: true }); } catch { /* ignore */ }
            });
          }
          return next;
        });
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [feedTick, commentPostId]);

  // v4.32.538: пока тред открыт и прочитан, число под записью равно длине
  // списка. Оба запроса ходят в одну таблицу с одним условием, так что это не
  // приближение, а то же самое число — в отличие от прежних «плюс один» и
  // «минус один», которые ставились независимо от того, изменился список или
  // нет. Одно правило вместо трёх: оно же покрывает удаление и чужой
  // комментарий, пришедший конвертом.
  useEffect(() => {
    if (!commentPostId || commentsLoadedFor !== commentPostId) return;
    setCommentCounts((prev) => commentCountFromThread(prev, commentPostId, comments.length));
  }, [commentPostId, commentsLoadedFor, comments]);

  // v4.32.538: номер записи здесь больше не нужен — счётчик под ней сходится
  // с длиной треда сам.
  const deleteComment = useCallback(async (commentId: string) => {
    try {
      await deleteFeedComment(pair, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (e) {
      log.warn('feed_comment_delete_failed', { err: rawErrorText(e) });
      showError(t('feed.deleteCommentFailed'));
    }
  }, [pair, t]);

  // v4.32.163 P2#5 fix: мемоизируем ListHeaderComponent — без этого он создаётся
  // новым JSX-элементом на каждый рендер FeedScreenImpl (каждый setCommentText,
  // каждый new message и т.д.), FlatList видит смену header ref и перерисовывает
  // pinned post + separator, вызывая мерцание в длинном треде.
  const commentsListHeader = useMemo(() => {
    if (!commentPost) return null;
    return (
      <View>
        <View style={cmStyles.pinnedPost}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Ionicons name="person-circle" size={36} color={colors.accent} />
            <View style={{ marginLeft: 8, flex: 1, minWidth: 0 }}>
              <Text style={cmStyles.pinnedAuthor} numberOfLines={1}>
                {commentPost.authorDid === did
                  ? t('common.you')
                  : shownName(commentPost.authorName, commentPost.nameUnreadable, t('common.contact'))}
              </Text>
              <Text style={cmStyles.pinnedTime}>{formatTime(commentPost.timestamp)}</Text>
            </View>
          </View>
          {commentPost.text ? (
            <Text style={cmStyles.pinnedBody}>{commentPost.text}</Text>
          ) : null}
          {commentPost.reactions && Object.keys(commentPost.reactions).length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {Object.entries(commentPost.reactions)
                .filter(([, ds]) => (ds as string[]).length > 0)
                .map(([emoji, ds]) => (
                  <View key={emoji} style={cmStyles.pinnedReactionPill}>
                    <Text style={{ fontSize: 13 }}>{emoji}</Text>
                    <Text style={cmStyles.pinnedReactionCount}>{(ds as string[]).length}</Text>
                  </View>
                ))}
            </View>
          ) : null}
        </View>
        <View style={cmStyles.separatorRow}>
          <View style={cmStyles.separatorLine} />
          <Text style={cmStyles.separatorText}>Начало обсуждения</Text>
          <View style={cmStyles.separatorLine} />
        </View>
      </View>
    );
  }, [commentPost, did, colors.accent, cmStyles, t]);

  useEffect(() => {
    if (bookmarkFilter) {
      void listBookmarkedFeedPosts().then(applyIfRead(setBookmarkedPosts, 'bookmarks_enter'));
    }
  }, [bookmarkFilter]);

  // v4.32.34/v4.32.47: при входе в режим «Архив» подгружаем первую страницу (40 постов),
  // дальше — пагинация через loadMoreArchive по onEndReached FlatList.
  const [archiveOffset, setArchiveOffset] = useState(0);
  const [archiveHasMore, setArchiveHasMore] = useState(true);
  const archiveLoadingMore = useRef(false);
  useEffect(() => {
    if (archiveFilter) {
      setArchiveOffset(0);
      setArchiveHasMore(true);
      void listArchivedFeedPosts(FEED_PAGE, 0).then((first) => {
        // v4.32.528: пустой архив применяем (он мог опустеть), сбой чтения — нет.
        if (!shouldApplyRows(first)) {
          log.warn('ui_feed_list_read_failed', { where: 'archive_enter' });
          return;
        }
        setArchivedPosts([...first]);
        setArchiveOffset(first.length);
        if (first.length < FEED_PAGE) setArchiveHasMore(false);
      });
    }
  }, [archiveFilter]);

  const loadMoreArchive = useCallback(async () => {
    if (!archiveFilter || archiveLoadingMore.current || !archiveHasMore) return;
    archiveLoadingMore.current = true;
    try {
      const page = await listArchivedFeedPosts(FEED_PAGE, archiveOffset);
      // v4.32.528: сбой чтения не выключает подгрузку — он про неё ничего не знает.
      const decision = decidePage(page, FEED_PAGE);
      if (decision.endOfList) setArchiveHasMore(false);
      if (!decision.apply || page === null) return;
      const more = page;
      setArchivedPosts((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        const newRows = more.filter((p) => !existingIds.has(p.id));
        return [...prev, ...newRows];
      });
      setArchiveOffset((prev) => prev + more.length);
    } catch (e) {
      log.warn('feed_archive_load_more_failed', { err: rawErrorText(e) });
    } finally {
      archiveLoadingMore.current = false;
    }
  }, [archiveFilter, archiveOffset, archiveHasMore]);

  const handleHashtagPress = useCallback((tag: string) => {
    setActiveHashtag((prev) => (prev === tag ? null : tag));
    setFeedSearch('');
  }, []);

  // Stage C.3: stable per-item callbacks so FeedPostItem's memo actually holds.
  // Each wrapper takes the item/id explicitly so useCallback deps reference
  // only parent hooks, not per-row closures that would flip identity every
  // parent render.
  const handleMarkRead = useCallback((item: FeedPostRow) => {
    const isSelf = item.authorDid === did;
    markReadAction.run(item.id, async () => {
      // v4.32.537: раньше исход отметки не проверялся. Человек тапал «отметить
      // прочитанной», запись оставалась непрочитанной, и он не узнавал об этом
      // ничего — лента просто перезагружалась в прежнем виде.
      const ok = await markFeedPostRead(item.id);
      if (!ok) {
        showError(t('feed.markReadFailed'));
        return;
      }
      markedReadRef.current.claim([item.id]);
      if (pair && !isSelf && sentViewRef.current.claim([item.id]).length > 0) {
        const myName = profileManager.getActiveProfile()?.name?.trim() || t('common.contact');
        void notifyFeedPostViewed(pair, { id: item.id, authorDid: item.authorDid }, myName)
          .then((done) => {
            if (!done) sentViewRef.current.release([item.id]);
          })
          .catch(() => {
            sentViewRef.current.release([item.id]);
          });
      }
      void loadFeed();
    });
  }, [did, pair, loadFeed, markReadAction, t]);

  const handleLongPressPost = useCallback((item: FeedPostRow) => {
    Vibration.vibrate(30);
    setActionSheetPost(item);
  }, []);

  const handleReactionLongPress = useCallback((emoji: string, dids: string[]) => {
    const names = dids.map((d) => {
      const c = allContacts.find((ct) => ct.peerPublicKey === d || ct.peerPublicKey === d.split(':').pop());
      return contactLabel(c?.displayName, shortIdentity(d));
    });
    Alert.alert(`${emoji} ${dids.length}`, names.join('\n') || t('feed.noData'), [{ text: t('common.ok') }]);
  }, [allContacts, t]);

  const handleRepostLongPress = useCallback((item: FeedPostRow) => {
    if (!mayRepublishFeedPost(item)) {
      showError(UNREADABLE_POST_ACTION_TEXT);
      return;
    }
    Vibration.vibrate(30);
    Alert.alert(t('feed.repostSheetTitle'), '', [
      { text: t('feed.repostQuick'), onPress: () => void handleRepost(item) },
      {
        text: t('feed.repostWithComment'),
        onPress: () => {
          const quotedText = (item.text ?? '').slice(0, 200);
          // v4.32.589: цитата уходит наружу, поэтому пометка сюда не идёт —
          // встаёт то же запасное имя, что и у безымянного автора.
          const authorLabel = outwardName(item.authorName, item.nameUnreadable, t('common.contact'));
          setDraft(`\n\n↩ ${authorLabel}:\n${quotedText}`);
          setUris([]);
          setIsPollMode(false);
          setModalOpen(true);
        },
      },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }, [handleRepost, t]);

  // v4.32.91: per-post lock от двойного тапа + error surface на случай сбоя SQL.
  const bookmarkLocksRef = useRef<Set<string>>(new Set());
  const handleBookmarkToggle = useCallback((item: FeedPostRow) => {
    if (bookmarkLocksRef.current.has(item.id)) return;
    bookmarkLocksRef.current.add(item.id);
    const newVal = !item.bookmarked;
    void setFeedPostBookmarked(item.id, newVal)
      .then(() => {
        if (bookmarkFilter) return listBookmarkedFeedPosts().then(applyIfRead(setBookmarkedPosts, 'bookmarks_toggle'));
        return loadFeed();
      })
      .catch((e) => {
        log.warn('feed_bookmark_failed', { err: rawErrorText(e) });
        showError(t('feed.bookmarkFailed'));
      })
      .finally(() => { bookmarkLocksRef.current.delete(item.id); });
  }, [bookmarkFilter, loadFeed, t]);

  const handleNativeShare = useCallback((item: FeedPostRow) => {
    if (!mayRepublishFeedPost(item)) {
      showError(UNREADABLE_POST_ACTION_TEXT);
      return;
    }
    const shareText = item.text ? item.text.slice(0, 200) : t('feed.mediaFallback');
    void Share.share({ message: `${outwardName(item.authorName, item.nameUnreadable, 'AirChat')}: ${shareText}` });
  }, [t]);

  // v4.32.92: стабилизация handlers через ref — renderItem теперь не пересоздаётся
  // при каждом изменении любого колбэка. FeedPostItem.memo реально держит строки:
  // перерендеривается только та строка, чьи данные (mediaUrls/commentCount/…) сменились.
  const handlersRef = useRef({
    onMarkRead: handleMarkRead,
    onLongPressPost: handleLongPressPost,
    onPeekAuthor: setPeekAuthorDid,
    onHashtagPress: handleHashtagPress,
    onMediaPress: openFeedMedia,
    onDocumentPress: openFeedDocument,
    onReactionPress: handleReaction,
    onReactionLongPress: handleReactionLongPress,
    onAddReactionPress: setReactionTarget,
    onRepostPress: handleRepost,
    onRepostLongPress: handleRepostLongPress,
    onCommentsPress: openComments,
    onViewersPress: openViewers,
    onBookmarkToggle: handleBookmarkToggle,
    onShareToChat: setShareToTarget,
    onNativeShare: handleNativeShare,
  });
  handlersRef.current = {
    onMarkRead: handleMarkRead,
    onLongPressPost: handleLongPressPost,
    onPeekAuthor: setPeekAuthorDid,
    onHashtagPress: handleHashtagPress,
    onMediaPress: openFeedMedia,
    onDocumentPress: openFeedDocument,
    onReactionPress: handleReaction,
    onReactionLongPress: handleReactionLongPress,
    onAddReactionPress: setReactionTarget,
    onRepostPress: handleRepost,
    onRepostLongPress: handleRepostLongPress,
    onCommentsPress: openComments,
    onViewersPress: openViewers,
    onBookmarkToggle: handleBookmarkToggle,
    onShareToChat: setShareToTarget,
    onNativeShare: handleNativeShare,
  };
  // Стабильные обёртки — читают актуальные хендлеры из ref.
  const stableHandlers = useMemo(() => ({
    onMarkRead: (it: FeedPostRow) => handlersRef.current.onMarkRead(it),
    onLongPressPost: (it: FeedPostRow) => handlersRef.current.onLongPressPost(it),
    onPeekAuthor: (d: string) => handlersRef.current.onPeekAuthor(d),
    onHashtagPress: (t: string) => handlersRef.current.onHashtagPress(t),
    onMediaPress: (urls: string[], idx: number) => handlersRef.current.onMediaPress(urls, idx),
    onDocumentPress: (id: string, idx: number, name: string, mime: string) => handlersRef.current.onDocumentPress(id, idx, name, mime),
    onReactionPress: (id: string, emoji: string) => handlersRef.current.onReactionPress(id, emoji),
    onReactionLongPress: (emoji: string, dids: string[]) => handlersRef.current.onReactionLongPress(emoji, dids),
    onAddReactionPress: (id: string) => handlersRef.current.onAddReactionPress(id),
    onRepostPress: (it: FeedPostRow) => handlersRef.current.onRepostPress(it),
    onRepostLongPress: (it: FeedPostRow) => handlersRef.current.onRepostLongPress(it),
    onCommentsPress: (it: FeedPostRow) => handlersRef.current.onCommentsPress(it),
    onViewersPress: (id: string) => handlersRef.current.onViewersPress(id),
    onBookmarkToggle: (it: FeedPostRow) => handlersRef.current.onBookmarkToggle(it),
    onShareToChat: (it: FeedPostRow) => handlersRef.current.onShareToChat(it),
    onNativeShare: (it: FeedPostRow) => handlersRef.current.onNativeShare(it),
  }), []);

  const renderItem = useCallback(
    ({ item }: { item: FeedPostRow }) => (
      <FeedPostItem
        item={item}
        isSelf={item.authorDid === did}
        styles={styles}
        colors={colors}
        mediaUrls={mediaUrlsMap[item.id] ?? []}
        commentCount={commentCounts[item.id] ?? 0}
        viewCount={viewCounts[item.id] ?? 0}
        translatedText={translatedPosts[item.id]}
        feedSearch={feedSearch}
        pair={pair}
        myPubB64={myPubB64}
        feedTick={feedTick}
        {...stableHandlers}
      />
    ),
    [
      did, styles, colors, mediaUrlsMap, commentCounts, viewCounts, translatedPosts,
      feedSearch, pair, myPubB64, feedTick, stableHandlers,
    ]
  );

  const onFlushQueueNow = useCallback(() => {
    flushFeedQueueNow(pair);
    void getFeedPublishQueueLength(pair).then(setQueueLen);
    void loadFeed();
  }, [pair, loadFeed]);

  return (
    <SafeScreen edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardHost>
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="feed_screen">
        {/* Полноэкранный оверлей только вне модалки — иначе дублируется с кнопкой «Публикация…». */}
        <LoadingOverlay visible={publishing} message={t('feed.sending')} />
        {/* v4.32.36: компактный header — убраны subtitle (лишние 2 строки) и idRow
            (DID дублируется в Профиле). Это поднимает первый пост ближе к верху
            экрана — раньше вертикальный оверхед ~250px прижимал посты к середине. */}
        <GlassSurface style={styles.feedChrome} intensity={34} variant="clear">
        <View style={styles.topRow}>
          <Text style={[styles.h1, { flex: 1 }]}>{t('feed.title')}</Text>
          <AppPressable
            onPress={() => { setBookmarkFilter((v) => !v); setArchiveFilter(false); setActiveHashtag(null); setFeedSearch(''); }}
            style={[styles.composeBtn, bookmarkFilter && { backgroundColor: activeTint.fill, borderRadius: 8 }]}
            hitSlop={8}
          >
            <Ionicons name={bookmarkFilter ? 'bookmark' : 'bookmark-outline'} size={22} color={bookmarkFilter ? activeTint.ink : colors.textSecondary} />
          </AppPressable>
          {/* v4.32.34: вход в Архив — иконка «archive», визуально подсвечена когда режим активен. */}
          <AppPressable
            onPress={() => { setArchiveFilter((v) => !v); setBookmarkFilter(false); setActiveHashtag(null); setFeedSearch(''); }}
            style={[styles.composeBtn, archiveFilter && { backgroundColor: activeTint.fill, borderRadius: 8 }]}
            hitSlop={8}
            testID="btn_archive_filter"
          >
            <Ionicons name={archiveFilter ? 'archive' : 'archive-outline'} size={22} color={archiveFilter ? activeTint.ink : colors.textSecondary} />
          </AppPressable>
          <AppPressable
            onPress={() => setModalOpen(true)}
            style={styles.composeBtn}
            testID="btn_new_post"
            hitSlop={8}
          >
            <Ionicons name="create-outline" size={26} color={colors.accent} />
          </AppPressable>
        </View>
        {/* Feed search bar */}
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceHigh, borderRadius: 10, marginBottom: 0, paddingHorizontal: 10, paddingVertical: 7 }}>
          <Ionicons name="search" size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
          <TextInput
            value={feedSearch}
            onChangeText={setFeedSearch}
            placeholder={t('feed.searchPlaceholder')}
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, color: colors.text, fontSize: 15 }}
          />
          {feedSearch ? (
            <AppPressable onPress={() => setFeedSearch('')}>
              <Ionicons name="close-circle" size={16} color={colors.textMuted} />
            </AppPressable>
          ) : null}
        </View>
        </GlassSurface>

        {/* Trending hashtags row */}
        {!feedSearch && !activeHashtag && trendingHashtags.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginBottom: 4 }}
            contentContainerStyle={{ paddingHorizontal: 12, gap: 6, paddingVertical: 2 }}
          >
            {trendingHashtags.map((tag) => (
              <AppPressable
                key={tag}
                onPress={() => setActiveHashtag(tag)}
                style={{ backgroundColor: colors.surfaceHigh, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
              >
                <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '500' }}>{tag}</Text>
              </AppPressable>
            ))}
          </ScrollView>
        ) : null}

        {/* Active hashtag filter chip */}
        {activeHashtag ? (
          <AppPressable
            onPress={() => setActiveHashtag(null)}
            style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginHorizontal: 16, marginBottom: 6, backgroundColor: activeTint.fill, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5 }}
          >
            <Text style={{ color: activeTint.ink, fontWeight: '600', fontSize: 14 }}>{activeHashtag}</Text>
            <Ionicons name="close-circle" size={15} color={activeTint.ink} style={{ marginLeft: 4 }} />
          </AppPressable>
        ) : null}

        {mutedAuthors.size > 0 ? (
          <AppPressable
            onPress={() => Alert.alert(t('feed.mutedAuthorsTitle'), t('feed.mutedAuthorsMsg', { count: mutedAuthors.size }), [{ text: t('common.ok') }])}
            style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginHorizontal: 16, marginBottom: 6, backgroundColor: quietTint.fill, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5 }}
          >
            <Ionicons name="eye-off-outline" size={14} color={quietTint.ink} style={{ marginRight: 4 }} />
            <Text style={{ color: quietTint.ink, fontSize: 13 }}>{t('feed.mutedCount', { count: mutedAuthors.size })}</Text>
          </AppPressable>
        ) : null}

        {/* Stories row */}
        {!feedSearch && !activeHashtag ? (
          <StoriesRow myPubB64={myPubB64} pair={pair} refreshTick={feedTick} />
        ) : null}

        {unread > 0 ? (
          <AppPressable style={styles.unreadBanner} onPress={() => void loadFeed()}>
            <Text style={styles.unreadText}>
              {unread} непрочитанных — обновить
            </Text>
          </AppPressable>
        ) : null}

        {queueLen > 0 ? (
          <AppPressable style={styles.queueBanner} onPress={onFlushQueueNow} testID="feed_queue_banner">
            <Ionicons name="time-outline" size={18} color={styles.queueText.color} style={{ marginRight: 8 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.queueText}>
                В очереди: {queueLen}. Отправится при интернете или связи с облаком
              </Text>
              <Text style={styles.queueHint}>Нажмите, чтобы отправить сейчас</Text>
            </View>
            <Ionicons name="refresh-outline" size={22} color={styles.queueText.color} />
          </AppPressable>
        ) : null}

        <FlatList
          style={styles.list}
          data={listData}
          extraData={{ mutedPosts, bookmarkFilter, colors }}
          keyExtractor={(item) => item.id}
          testID="feed_list"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          renderItem={renderItem}
          initialNumToRender={6}
          maxToRenderPerBatch={5}
          windowSize={9}
          removeClippedSubviews={Platform.OS === 'android'}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          onEndReached={() => {
            // v4.32.47: пагинация в архиве/ленте (разные источники, одни onEndReached).
            if (archiveFilter) void loadMoreArchive();
            else void loadMoreFeed();
          }}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            (archiveFilter && archiveHasMore) ||
            (!archiveFilter && feedHasMore && !feedSearch.trim() && !activeHashtag && !bookmarkFilter)
              ? (
                <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={colors.accent} />
                </View>
              ) : null}
          ListEmptyComponent={
            initialLoading ? (
              <View style={{ padding: 8 }}>
                {[1, 2, 3].map((i) => <FeedPostSkeleton key={i} />)}
              </View>
            ) : archiveFilter ? (
              // v4.32.34: пустое состояние режима «Архив».
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>📥</Text>
                <Text style={styles.emptyTitle}>Архив пуст</Text>
                <Text style={styles.empty}>
                  Долгое нажатие на публикации → «Архивировать», чтобы спрятать её из ленты, не удаляя.
                </Text>
              </View>
            ) : bookmarkFilter ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>🔖</Text>
                <Text style={styles.emptyTitle}>Нет закладок</Text>
                <Text style={styles.empty}>
                  Нажмите иконку закладки в карточке публикации, чтобы сохранить её.
                </Text>
              </View>
            ) : feedReadFailed ? (
              // v4.32.528: сбой чтения базы — это не пустая лента, и говорить
              // об этом надо прямо, иначе потеря выглядит как «у вас ничего нет».
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>⚠️</Text>
                <Text style={styles.emptyTitle}>Не удалось открыть ленту</Text>
                <Text style={styles.empty}>
                  База данных была занята. Потяните список вниз, чтобы повторить.
                </Text>
              </View>
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>📰</Text>
                <Text style={styles.emptyTitle}>Лента пуста</Text>
                <Text style={styles.empty}>
                  Когда ваши контакты что-то опубликуют или вы нажмёте{' '}
                  <Text style={[styles.empty, appleColorEmojiTextStyle()]}>✏️</Text>{' '}
                  — публикации появятся здесь.
                </Text>
              </View>
            )
          }
        />

        {/* Emoji reaction picker */}
        <Modal
          visible={reactionTarget !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setReactionTarget(null)}
        >
          {/* v4.32.25: GestureHandlerRootView обязателен для RNGH Pressable внутри Modal на Android. */}
          <GestureHandlerRootView style={styles.emojiOverlay}>
          <AppPressable style={styles.emojiOverlay} onPress={() => setReactionTarget(null)}>
            {/* v4.32.227 (BUG-03): stopPropagation so taps INSIDE the sheet don't
                close it, while taps on the backdrop (outer AppPressable) do. Plus a
                guaranteed «Отмена» escape — backdrop-tap dismissal was unreliable on
                some devices, leaving the user to hardware-BACK out (which then risked
                falling through and exiting the app from the feed root tab). */}
            <AppPressable style={styles.emojiSheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.emojiTitle}>Реакция</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4 }}>
                {REACTION_EMOJIS.map((emoji) => (
                  <AppPressable
                    key={emoji}
                    style={styles.emojiBtn}
                    onPress={() => {
                      if (reactionTarget) void handleReaction(reactionTarget, emoji);
                    }}
                    hitSlop={8}
                  >
                    <Text style={styles.emojiBtnText}>{emoji}</Text>
                  </AppPressable>
                ))}
              </View>
              <AppPressable
                onPress={() => setReactionTarget(null)}
                hitSlop={8}
                style={{ marginTop: 16, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 12, alignSelf: 'stretch', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
              >
                <Text style={{ color: colors.textSecondary, fontSize: 15, fontWeight: '600' }}>{t('common.cancel')}</Text>
              </AppPressable>
            </AppPressable>
          </AppPressable>
          </GestureHandlerRootView>
        </Modal>

        <Modal
          visible={modalOpen}
          transparent
          animationType="slide"
          onRequestClose={handleSoftDismissModal}
        >
          {/* v4.32.25: RNGH Pressable (через AppPressable) внутри Modal на Android НЕ работает
              без отдельного GestureHandlerRootView, т.к. Modal создаёт новое native-окно
              вне корневого жест-дерева из App.tsx. Без этого кнопки "Опубликовать"/"Отмена"
              выглядят как нажимаемые, но onPress не срабатывает — юзер видит "тишину".
              https://docs.swmansion.com/react-native-gesture-handler/docs/installation#js */}
          <GestureHandlerRootView style={styles.modalOverlay}>
          <View style={styles.modalOverlay}>
            {/* v4.32.122: на Android используем flex:1 + marginTop=insets.top+8 — модалка
                естественно заполняет доступную область (ресайзится вместе с окном когда
                softwareKeyboardLayoutMode="resize" убирает место под клавиатуру).
                Раньше фиксированная height от SCREEN_HEIGHT или windowHeight давала
                то перелёт (шапка выше экрана), то крошечный листок ~130px.
                На iOS сохраняем старое поведение с KeyboardAvoidingView + MODAL_HEIGHT_*. */}
            <KeyboardAvoidingView
              style={styles.modalKeyboardAvoid}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={0}
            >
              <View
                style={[
                  styles.modalSheet,
                  Platform.OS === 'ios'
                    ? {
                        height: keyboardVisible
                          ? MODAL_HEIGHT_KEYBOARD
                          : MODAL_HEIGHT_COLLAPSED,
                        paddingBottom: Math.max(insets.bottom, 12),
                      }
                    : {
                        flex: 1,
                        marginTop: insets.top + 8,
                        paddingBottom: Math.max(insets.bottom, 12),
                      },
                ]}
              >
                <View style={styles.modalTopBar}>
                  <View style={styles.modalTopBarSide}>
                    <AppPressable onPress={handleCloseModal} hitSlop={12} accessibilityRole="button">
                      <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
                    </AppPressable>
                  </View>
                  <Text style={styles.modalTitleCentered} numberOfLines={1}>
                    {editingPost ? t('feed.edit') : t('feed.newPost')}
                  </Text>
                  <View style={[styles.modalTopBarSide, styles.modalTopBarSideEnd]}>
                    <AppPressable
                      onPress={() => void handlePublish()}
                      disabled={isPollMode ? (!pollQuestion.trim() || pollOptions.filter(Boolean).length < 2) : (!draft.trim() && uris.length === 0)}
                      hitSlop={12}
                      testID="btn_publish_post"
                      accessibilityRole="button"
                    >
                      <Text
                        style={[
                          styles.modalHeaderPublish,
                          (isPollMode ? (!pollQuestion.trim() || pollOptions.filter(Boolean).length < 2) : (!draft.trim() && uris.length === 0)) && styles.modalHeaderPublishDisabled,
                        ]}
                      >
                        {editingPost ? t('feed.save') : t('feed.publish')}
                      </Text>
                    </AppPressable>
                  </View>
                </View>

                <ScrollView
                  ref={modalScrollRef}
                  style={styles.modalScrollArea}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                  nestedScrollEnabled
                  contentContainerStyle={styles.modalScrollBody}
                >
                  {isPollMode ? (
                    <View style={{ paddingHorizontal: 4 }}>
                      <TextInput
                        placeholder={t('feed.pollQuestionPlaceholder')}
                        placeholderTextColor={colors.textMuted}
                        value={pollQuestion}
                        onChangeText={setPollQuestion}
                        style={[styles.modalInput, { minHeight: 48 }]}
                        multiline
                        autoFocus
                        textAlignVertical="top"
                      />
                      <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 6, marginTop: 2 }}>{t('feed.pollOptionsLabel')}</Text>
                      {pollOptions.map((opt, i) => (
                        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                          <TextInput
                            placeholder={t('feed.pollOptionPlaceholder', { n: i + 1 })}
                            placeholderTextColor={colors.textMuted}
                            value={opt}
                            onChangeText={(v) => setPollOptions((prev) => prev.map((o, j) => j === i ? v : o))}
                            style={[styles.modalInput, { flex: 1, marginBottom: 0, minHeight: 40 }]}
                          />
                          {pollOptions.length > 2 ? (
                            <AppPressable
                              style={{ padding: 6 }}
                              onPress={() => setPollOptions((prev) => prev.filter((_, j) => j !== i))}
                            >
                              <Ionicons name="close-circle-outline" size={22} color={colors.error} />
                            </AppPressable>
                          ) : null}
                        </View>
                      ))}
                      {pollOptions.length < 4 ? (
                        <AppPressable
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 }}
                          onPress={() => setPollOptions((prev) => [...prev, ''])}
                        >
                          <Ionicons name="add-circle-outline" size={20} color={colors.accent} />
                          <Text style={{ color: colors.accent, fontSize: 14 }}>{t('feed.pollAddOption')}</Text>
                        </AppPressable>
                      ) : null}
                      <AppPressable
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, marginTop: 4 }}
                        onPress={() => setPollAnonymous((v) => !v)}
                      >
                        <Ionicons name={pollAnonymous ? 'checkbox' : 'square-outline'} size={20} color={colors.accent} />
                        <Text style={{ color: colors.text, fontSize: 14 }}>{t('feed.pollAnonymousLabel')}</Text>
                      </AppPressable>
                      <AppPressable
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}
                        onPress={() => setPollMultiSelect((v) => !v)}
                      >
                        <Ionicons name={pollMultiSelect ? 'checkbox' : 'square-outline'} size={20} color={colors.accent} />
                        <Text style={{ color: colors.text, fontSize: 14 }}>{t('feed.pollMultiLabel')}</Text>
                      </AppPressable>
                    </View>
                  ) : (
                    <>
                    <TextInput
                      ref={draftInputRef}
                      placeholder={t('feed.composerPlaceholder')}
                      placeholderTextColor={colors.textMuted}
                      value={draft}
                      onChangeText={(v) => {
                        setDraft(v);
                        setFeedEmojiSuggestions(getFeedEmojiSuggestions(v));
                        // Hashtag suggestions: detect trailing #prefix
                        const htMatch = /#([a-zа-яё0-9_]{1,})$/i.exec(v);
                        if (htMatch) {
                          const q = htMatch[1].toLowerCase();
                          const allTags = new Set<string>();
                          for (const p of allPosts) {
                            const matches = (p.text ?? '').match(/#([a-zа-яё0-9_]+)/gi) ?? [];
                            matches.forEach((t) => allTags.add(t.toLowerCase()));
                          }
                          const suggestions = [...allTags].filter((t) => t.slice(1).startsWith(q) && t.slice(1) !== q).slice(0, 12);
                          setHashtagSuggestions(suggestions);
                        } else {
                          setHashtagSuggestions([]);
                        }
                        // Mention suggestions: detect trailing @prefix
                        const mentionMatch = /@([a-zа-яё0-9_.]*)$/i.exec(v);
                        if (mentionMatch) {
                          const q = mentionMatch[1].toLowerCase();
                          const matches = allContacts
                            .filter((c) => c.displayName && c.displayName.toLowerCase().includes(q))
                            .map((c) => ({ name: c.displayName ?? '', did: c.peerPublicKey }))
                            .slice(0, 8);
                          setMentionSuggestions(matches);
                        } else {
                          setMentionSuggestions([]);
                        }
                      }}
                      onSelectionChange={(e) => setDraftSelection(e.nativeEvent.selection)}
                      style={styles.modalInput}
                      multiline
                      testID="feed_post_input"
                      autoFocus={Platform.OS === 'ios'}
                      textAlignVertical="top"
                    />
                    {/* Formatting toolbar */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingHorizontal: 2, gap: 2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                      {[
                        { label: 'B', prefix: '**', suffix: '**', style: { fontWeight: '700' as const } },
                        { label: 'I', prefix: '_', suffix: '_', style: { fontStyle: 'italic' as const } },
                        { label: 'S', prefix: '~~', suffix: '~~', style: { textDecorationLine: 'line-through' as const } },
                        { label: '`', prefix: '`', suffix: '`', style: { fontFamily: 'monospace' as const } },
                        { label: '||', prefix: '||', suffix: '||', style: {} },
                      ].map(({ label, prefix, suffix, style: fStyle }) => (
                        <AppPressable
                          key={label}
                          onPress={() => formatDraftText(prefix, suffix)}
                          hitSlop={6}
                          style={({ pressed }) => ({
                            paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
                            backgroundColor: pressed ? activeTint.fill : 'transparent',
                            borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
                            marginRight: 2,
                          })}
                        >
                          {/* Надпись остаётся на месте, когда под ней появляется плашка,
                              поэтому её цвет проверен и на плашке, и на фоне. */}
                          <Text style={[{ fontSize: 13, color: activeInk.secondary }, fStyle]}>{label}</Text>
                        </AppPressable>
                      ))}
                    </View>
                    </>
                  )}
                  {!isPollMode && uris.length > 0 ? (
                    <>
                      {/* v4.32.54: строка-статус над превью — видно прогресс лимита без подсчёта вручную. */}
                      <View style={styles.previewHeaderRow}>
                        <Ionicons name="images-outline" size={14} color={colors.textSecondary} />
                        <Text style={styles.previewHeaderText}>
                          Выбрано: {uris.length} / {FEED_MAX_IMAGES}
                        </Text>
                        {uris.length >= FEED_MAX_IMAGES ? (
                          <Text style={[styles.previewHeaderText, { color: colors.accent, fontWeight: '600' }]}>
                            · максимум
                          </Text>
                        ) : null}
                        <View style={{ flex: 1 }} />
                        {uris.length > 1 ? (
                          <AppPressable
                            onPress={() => setUris([])}
                            hitSlop={8}
                            style={styles.previewClearBtn}
                          >
                            <Ionicons name="trash-outline" size={14} color={colors.error} />
                            <Text style={[styles.previewHeaderText, { color: colors.error, marginLeft: 4 }]}>Очистить</Text>
                          </AppPressable>
                        ) : null}
                      </View>
                      <ScrollView
                        horizontal
                        nestedScrollEnabled
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        style={styles.previewRow}
                        contentContainerStyle={styles.previewRowContent}
                      >
                        {uris.map((uri, i) => (
                          <View key={`feed-preview-${uri}-${i}`} style={styles.previewWrap}>
                            <Image source={{ uri }} style={styles.previewImg} resizeMode="cover" />
                            {/* Порядковый номер — полезно когда 10 фото, юзер понимает какое первое. */}
                            <View style={styles.previewIndexBadge}>
                              <Text style={styles.previewIndexText}>{i + 1}</Text>
                            </View>
                            <AppPressable
                              style={styles.removeImg}
                              onPress={() => setUris((u) => u.filter((_, j) => j !== i))}
                              hitSlop={8}
                            >
                              <Ionicons name="close-circle" size={24} color={colors.error} />
                            </AppPressable>
                          </View>
                        ))}
                        {/* "Добавить ещё"-плитка в конце, если лимит не достигнут. Telegram-style. */}
                        {uris.length < FEED_MAX_IMAGES ? (
                          <AppPressable
                            style={styles.previewAddTile}
                            onPress={() => void pickImages()}
                            hitSlop={4}
                          >
                            <Ionicons name="add" size={32} color={colors.accent} />
                            <Text style={styles.previewAddText}>Добавить</Text>
                          </AppPressable>
                        ) : null}
                      </ScrollView>
                    </>
                  ) : null}
                  {/* v4.32.48: превью прикреплённых документов. */}
                  {!isPollMode && pickedDocs.length > 0 ? (
                    <View style={{ paddingHorizontal: 12, paddingBottom: 8, gap: 6 }}>
                      {pickedDocs.map((doc, i) => (
                        <View
                          key={`feed-doc-preview-${doc.uri}-${i}`}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            padding: 10,
                            borderRadius: 10,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: colors.border,
                            backgroundColor: colors.surface,
                            gap: 10,
                          }}
                        >
                          <Ionicons name="document-outline" size={22} color={colors.accent} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text numberOfLines={1} style={{ fontSize: 14, color: colors.text, fontWeight: '500' }}>
                              {doc.name}
                            </Text>
                            {formatByteSize(doc.size) ? (
                              <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                                {formatByteSize(doc.size)}
                              </Text>
                            ) : null}
                          </View>
                          <AppPressable
                            onPress={() => setPickedDocs((p) => p.filter((_, j) => j !== i))}
                            hitSlop={8}
                          >
                            <Ionicons name="close-circle" size={22} color={colors.error} />
                          </AppPressable>
                        </View>
                      ))}
                    </View>
                  ) : null}
                  <View style={styles.modalScrollBottomSpacer} />
                </ScrollView>

                {hashtagSuggestions.length > 0 && feedEmojiSuggestions.length === 0 && !isPollMode ? (
                  <ScrollView
                    horizontal
                    keyboardShouldPersistTaps="always"
                    showsHorizontalScrollIndicator={false}
                    style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, maxHeight: 44 }}
                    contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6, gap: 6 }}
                  >
                    {hashtagSuggestions.map((tag) => (
                      <AppPressable
                        key={tag}
                        onPress={() => {
                          const newText = draft.replace(/#([a-zа-яё0-9_]*)$/i, tag + ' ');
                          setDraft(newText);
                          setHashtagSuggestions([]);
                        }}
                        style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, backgroundColor: activeTint.fill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accent }}
                      >
                        <Text style={{ fontSize: 13, color: activeTint.ink, fontWeight: '500' }}>{tag}</Text>
                      </AppPressable>
                    ))}
                  </ScrollView>
                ) : null}
                {feedEmojiSuggestions.length > 0 && !isPollMode ? (
                  <ScrollView
                    horizontal
                    keyboardShouldPersistTaps="always"
                    showsHorizontalScrollIndicator={false}
                    style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, maxHeight: 44 }}
                    contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, gap: 4 }}
                  >
                    {feedEmojiSuggestions.map(({ key, emoji }) => (
                      <AppPressable
                        key={key}
                        onPress={() => {
                          const newText = draft.replace(/:([a-z0-9_]{2,})$/, emoji + ' ');
                          setDraft(newText);
                          setFeedEmojiSuggestions([]);
                        }}
                        style={{ alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
                      >
                        <Text style={{ fontSize: 20 }}>{emoji}</Text>
                        <Text style={{ fontSize: 9, color: colors.textMuted, marginTop: 1 }}>{key}</Text>
                      </AppPressable>
                    ))}
                  </ScrollView>
                ) : null}
                {mentionSuggestions.length > 0 && !isPollMode ? (
                  <ScrollView
                    horizontal
                    keyboardShouldPersistTaps="always"
                    showsHorizontalScrollIndicator={false}
                    style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, maxHeight: 44 }}
                    contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6, gap: 6 }}
                  >
                    {mentionSuggestions.map(({ name, did }) => (
                      <AppPressable
                        key={did}
                        onPress={() => {
                          const newText = draft.replace(/@([a-zа-яё0-9_.]*)$/i, `@${name} `);
                          setDraft(newText);
                          setMentionSuggestions([]);
                        }}
                        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, backgroundColor: activeTint.fill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accent, gap: 4 }}
                      >
                        <Ionicons name="person-outline" size={13} color={activeTint.ink} />
                        <Text style={{ fontSize: 13, color: activeTint.ink, fontWeight: '500' }}>{name}</Text>
                      </AppPressable>
                    ))}
                  </ScrollView>
                ) : null}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  style={styles.modalBottomBar}
                  contentContainerStyle={styles.modalBottomBarContent}
                >
                  {!isPollMode && !editingPost ? (
                    <AppPressable
                      style={[styles.iconAction, uris.length > 0 ? { backgroundColor: activeTint.fill, borderRadius: 8 } : null]}
                      onPress={() => void pickImages()}
                      onLongPress={() => {
                        Alert.alert(t('feed.mediaSheetTitle'), '', [
                          { text: t('feed.mediaFromGallery'), onPress: () => void pickImages() },
                          { text: t('feed.mediaFromCamera'), onPress: () => void takePhoto() },
                          { text: t('common.cancel'), style: 'cancel' },
                        ]);
                      }}
                      delayLongPress={400}
                    >
                      <Ionicons name="image-outline" size={24} color={uris.length > 0 ? activeTint.ink : colors.textMuted} />
                      <Text style={[styles.iconActionText, uris.length > 0 ? { color: activeTint.ink } : null]}>
                        {uris.length > 0 ? t('feed.photoCount', { count: uris.length }) : t('feed.photo')}
                      </Text>
                    </AppPressable>
                  ) : null}
                  {!editingPost ? (
                    <AppPressable
                      style={[styles.iconAction, isPollMode && { backgroundColor: activeTint.fill, borderRadius: 8 }]}
                      onPress={() => {
                        setIsPollMode((v) => !v);
                        setDraft('');
                        setUris([]);
                      }}
                    >
                      <Ionicons name="bar-chart-outline" size={24} color={isPollMode ? activeTint.ink : colors.textMuted} />
                      <Text style={[styles.iconActionText, isPollMode && { color: activeTint.ink }]}>{t('feed.poll')}</Text>
                    </AppPressable>
                  ) : null}
                  {!isPollMode && !editingPost ? (
                    <AppPressable
                      style={[styles.iconAction, postLocationTag ? { backgroundColor: activeTint.fill, borderRadius: 8 } : null]}
                      onPress={() => {
                        if (postLocationTag) {
                          setPostLocationTag(null);
                          return;
                        }
                        void (async () => {
                          // v4.32.543: раньше здесь был один catch на все причины и
                          // один текст «Не удалось определить геолокацию». Выключенная
                          // в телефоне геолокация чинится переключателем, а не
                          // повторной попыткой — об этом и надо говорить.
                          const read = await readPlaceOnce();
                          if (!read.ok) {
                            if (read.kind === 'denied') { showPermissionDeniedAlert(t('feed.locationPermTitle'), t('feed.locationPermMsg')); return; }
                            showError(locationFailureText(read.kind));
                            return;
                          }
                          // v4.32.52: 5 знаков после запятой (~1.1 м) — чтобы пин на карте
                          // показывал точное место, а не квадрат ~10 м как раньше при toFixed(4).
                          setPostLocationTag(`${read.coords.lat.toFixed(5)}, ${read.coords.lon.toFixed(5)}`);
                          showSuccess(t('feed.locationAdded'));
                        })();
                      }}
                    >
                      <Ionicons name="location-outline" size={24} color={postLocationTag ? activeTint.ink : colors.textMuted} />
                      <Text style={[styles.iconActionText, postLocationTag ? { color: activeTint.ink } : null]}>
                        {postLocationTag ? t('feed.locationOk') : t('feed.place')}
                      </Text>
                    </AppPressable>
                  ) : null}
                  {!isPollMode && !editingPost ? (
                    <AppPressable
                      style={[styles.iconAction, pickedDocs.length > 0 ? { backgroundColor: activeTint.fill, borderRadius: 8 } : null]}
                      onPress={() => void pickDocs()}
                    >
                      <Ionicons name="document-attach-outline" size={24} color={pickedDocs.length > 0 ? activeTint.ink : colors.textMuted} />
                      <Text style={[styles.iconActionText, pickedDocs.length > 0 ? { color: activeTint.ink } : null]}>
                        {pickedDocs.length > 0 ? t('feed.filesCount', { count: pickedDocs.length }) : t('feed.file')}
                      </Text>
                    </AppPressable>
                  ) : null}
                </ScrollView>
              </View>
            </KeyboardAvoidingView>
          </View>
          </GestureHandlerRootView>
        </Modal>
      </View>

      {/* ─── Comments fullscreen (v4.32.159) ──────────────────────────────
           Был bottom-sheet Modal (см. git до v4.32.159). Телеграм-образный
           full-screen: шапка-бар ← | «N комментарий» | 🔍 ▸ pinned-шапка с
           исходным постом ▸ «Начало обсуждения» ▸ пузырьки комментариев ▸
           input снизу. Стиль — наши iOS HIG токены (colors.*), не tmail dark. */}
      <Modal
        visible={!!commentPostId}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={closeComments}
      >
        {/* v4.32.25: GestureHandlerRootView обязателен для RNGH Pressable внутри Modal на Android. */}
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
          {/* v4.32.160 P2 audit #3: presentationStyle="fullScreen" на Android рисует за
              system bars — SafeAreaView по умолчанию (все edges) добавлял бы лишний
              top-inset, и шапка съезжала вниз. Пропускаем top на Android, оставляем
              bottom/left/right везде. */}
          <SafeAreaView
            style={{ flex: 1, backgroundColor: colors.background }}
            edges={Platform.OS === 'android' ? ['left', 'right', 'bottom'] : ['top', 'left', 'right', 'bottom']}
          >
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              // v4.32.163 P2#4 fix: на iPhone с notch внутри fullScreen Modal SafeAreaView
              // добавляет top-inset, но KeyboardAvoidingView его не учитывает и input
              // заезжает под клавиатуру на ~safeArea.top. Передаём insets.top на iOS.
              // Android использует softwareKeyboardLayoutMode=resize (app.json), клавиатура
              // ресайзит окно сама — offset=0 корректен.
              keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
            >
              {/* Header bar: ← | title | (search placeholder) */}
              {/* v4.32.227 (KB-1): fullScreen Modal draws behind the status bar and the
                  SafeAreaView above intentionally drops the 'top' edge — so the header
                  itself must carry the status-bar inset, otherwise the title/back row
                  slides under the clock/battery/notification strip. Apply insets.top on
                  Android (iOS gets it from the SafeAreaView 'top' edge). */}
              <View style={[cmStyles.screenHeader, Platform.OS === 'android' ? { paddingTop: insets.top } : null]}>
                <AppPressable onPress={closeComments} hitSlop={12} style={cmStyles.screenHeaderSide} accessibilityRole="button" accessibilityLabel={t('common.close')}>
                  <Ionicons name="chevron-back" size={26} color={colors.accent} />
                </AppPressable>
                <Text style={cmStyles.screenHeaderTitle} numberOfLines={1}>
                  {comments.length > 0
                    ? t('feed.commentsN', { count: comments.length })
                    : t('feed.a11yComments')}
                </Text>
                <View style={cmStyles.screenHeaderSide} />
              </View>

              {/* Scrollable list: pinned post (ListHeaderComponent) + comments */}
              <FlatList
                ref={commentScrollRef}
                style={{ flex: 1 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 12 }}
                data={comments}
                keyExtractor={(c) => c.id}
                onContentSizeChange={() => {
                  // v4.32.51: при первом рендере контента скроллим в конец.
                  if (comments.length > 0) scrollCommentsToEnd(false);
                }}
                ListHeaderComponent={commentsListHeader}
                ListEmptyComponent={commentsLoading ? (
                  <View style={{ alignItems: 'center', marginTop: 24, marginBottom: 16 }}>
                    <ActivityIndicator size="small" color={colors.accent} />
                  </View>
                ) : (
                  <Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: 24, marginBottom: 16 }}>
                    Нет комментариев. Будьте первым!
                  </Text>
                )}
                renderItem={({ item: c }) => {
                  const isOwn = c.authorDid === did;
                  const cReactions = c.reactions ?? {};
                  const heartCount = (cReactions['❤️'] ?? []).length;
                  const iHearted = (cReactions['❤️'] ?? []).includes(did);
                  return (
                    <View
                      style={cmStyles.commentRow}
                      accessible
                      accessibilityLabel={t('feed.a11yCommentFrom', { name: isOwn ? t('common.you') : shownName(c.authorName, c.nameUnreadable, t('common.anonymous')), text: feedCommentIsUnreadable(c) ? UNREADABLE_COMMENT_TEXT : c.text })}
                    >
                      <Ionicons name="person-circle" size={30} color={isOwn ? colors.accent : colors.textSecondary} style={{ marginRight: 8, marginTop: 2 }} />
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          {/* v4.32.50: тап по имени автора комментария → профиль */}
                          <AppPressable
                            onPress={() => { if (!isOwn) setPeekAuthorDid(c.authorDid); }}
                            hitSlop={4}
                          >
                            <Text style={cmStyles.commentAuthor}>{isOwn ? t('common.you') : shownName(c.authorName, c.nameUnreadable, t('common.anonymous'))}</Text>
                          </AppPressable>
                          <Text style={cmStyles.commentTime}>{formatTime(c.timestamp)}</Text>
                        </View>
                        {/* v4.32.588: непрочитанный комментарий приходил
                            пустой строкой и рисовался пустым пузырём. */}
                        {feedCommentIsUnreadable(c) ? (
                          <Text style={[cmStyles.commentText, cmStyles.commentUnreadable]}>{UNREADABLE_COMMENT_TEXT}</Text>
                        ) : (
                          <Text style={cmStyles.commentText}>{c.text}</Text>
                        )}
                        {/* Reaction pills row */}
                        {Object.keys(cReactions).length > 0 ? (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                            {Object.entries(cReactions).filter(([, dids]) => dids.length > 0).map(([emoji, dids]) => (
                              <AppPressable
                                key={emoji}
                                style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: dids.includes(did) ? commentTint.fill : colors.surfaceHigh, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, gap: 2 }}
                                onPress={() => {
                                  void toggleCommentReaction(pair, c.id, c.postId, emoji)
                                    .then((list) =>
                                      setComments((prev) =>
                                        acceptCommentList(commentPostIdRef.current, c.postId, list, prev)
                                      )
                                    )
                                    .catch((e) => {
                                      log.warn('feed_comment_reaction_failed', { err: rawErrorText(e) });
                                      showError(t('feed.reactionFailed'));
                                    });
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={t('feed.a11yReaction', { emoji, count: dids.length })}
                              >
                                <Text style={{ fontSize: 12 }}>{emoji}</Text>
                                <Text style={{ fontSize: 11, color: dids.includes(did) ? commentTint.ink : colors.textMuted }}>{dids.length}</Text>
                              </AppPressable>
                            ))}
                          </View>
                        ) : null}
                      </View>
                      <View style={{ alignItems: 'center', gap: 4 }}>
                        {/* Heart like button */}
                        <AppPressable
                          hitSlop={8}
                          onPress={() => {
                            void toggleCommentReaction(pair, c.id, c.postId, '❤️')
                              .then((list) =>
                                setComments((prev) =>
                                  acceptCommentList(commentPostIdRef.current, c.postId, list, prev)
                                )
                              )
                              .catch((e) => {
                                log.warn('feed_comment_heart_failed', { err: rawErrorText(e) });
                                showError(t('feed.likeFailed'));
                              });
                          }}
                          style={{ padding: 4 }}
                        >
                          <Ionicons name={iHearted ? 'heart' : 'heart-outline'} size={16} color={iHearted ? colors.error : colors.textMuted} />
                          {heartCount > 0 ? <Text style={{ fontSize: 10, color: colors.textMuted, textAlign: 'center' }}>{heartCount}</Text> : null}
                        </AppPressable>
                        {isOwn ? (
                          <AppPressable
                            hitSlop={8}
                            onPress={() => {
                              Alert.alert(t('feed.deleteCommentConfirm'), undefined, [
                                { text: t('common.cancel'), style: 'cancel' },
                                { text: t('common.delete'), style: 'destructive', onPress: () => void deleteComment(c.id) },
                              ]);
                            }}
                          >
                            <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                          </AppPressable>
                        ) : null}
                      </View>
                    </View>
                  );
                }}
              />

              {/* Input row — v4.32.160 P1 audit #1: добавлен bottom-inset на gesture-nav
                  устройства, иначе TextInput заезжал под домашний индикатор. */}
              <View style={[cmStyles.inputRow, { paddingBottom: Math.max(8, insets.bottom) }]}>
                <TextInput
                  ref={commentInputRef}
                  style={cmStyles.commentInput}
                  value={commentText}
                  onChangeText={setCommentText}
                  placeholder={t('feed.commentsPlaceholder')}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  maxLength={1000}
                  returnKeyType="send"
                  blurOnSubmit={false}
                  // v4.32.51: Enter на экранной клавиатуре → submit (без потери фокуса).
                  // Работает вместе с blurOnSubmit=false: иначе Android бы дропал фокус.
                  onSubmitEditing={() => {
                    if (commentText.trim() && !commentSending) {
                      void submitComment();
                    }
                  }}
                />
                <AppPressable
                  style={[cmStyles.sendBtn, (!commentText.trim() || commentSending) && { opacity: 0.4 }]}
                  onPress={() => void submitComment()}
                  disabled={!commentText.trim() || commentSending}
                >
                  {commentSending
                    ? <ActivityIndicator size="small" color={cmStyles.sendInk.color} />
                    : <Ionicons name="send" size={18} color={cmStyles.sendInk.color} />}
                </AppPressable>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </GestureHandlerRootView>
      </Modal>

      {/* ─── Viewers modal (v4.32.68) ────────────────────────────────────── */}
      <Modal
        visible={!!viewersPostId}
        transparent
        animationType="slide"
        onRequestClose={closeViewers}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <AppPressable
            style={{ flex: 1, backgroundColor: scrim.modal }}
            onPress={closeViewers}
          >
            <AppPressable
              onPress={() => {}}
              style={{
                marginTop: 'auto',
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                backgroundColor: colors.surface,
                maxHeight: '75%',
                paddingBottom: 16,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                }}
              >
                <Ionicons name="eye-outline" size={18} color={colors.accent} style={{ marginRight: 10 }} />
                <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, flex: 1 }} numberOfLines={1}>
                  {viewersList.length > 0 ? t('feed.viewsN', { count: viewersList.length }) : t('feed.viewsTitle')}
                </Text>
                <AppPressable onPress={closeViewers} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              {viewersLoading ? (
                <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={colors.accent} />
                </View>
              ) : viewersList.length === 0 ? (
                <View style={{ paddingVertical: 40, paddingHorizontal: 20, alignItems: 'center' }}>
                  <Ionicons name="eye-off-outline" size={36} color={colors.textMuted} style={{ marginBottom: 8 }} />
                  <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 15, marginBottom: 4 }}>
                    {t('feed.viewersEmptyTitle')}
                  </Text>
                  <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 12 }}>
                    {t('feed.viewersEmptyHint')}
                  </Text>
                </View>
              ) : (
                <ScrollView
                  style={{ maxHeight: SCREEN_HEIGHT * 0.6 }}
                  contentContainerStyle={{ paddingVertical: 4 }}
                  keyboardShouldPersistTaps="handled"
                >
                  {viewersList.map((v) => {
                    const pkShort = v.viewerDid.split(':').pop() ?? v.viewerDid;
                    const resolvedContact = allContacts.find(
                      (ct) => ct.peerPublicKey === pkShort || ct.peerPublicKey === v.viewerDid
                    );
                    // v4.32.589: имя просмотревшего тоже могло не открыться —
                    // тогда честнее пометка, чем непрозрачный ключ.
                    const displayName =
                      (resolvedContact?.displayName?.trim() ||
                        (v.nameUnreadable ? UNREADABLE_NAME_TEXT : v.viewerName?.trim()) ||
                        shortIdentity(v.viewerDid)) ?? '';
                    const initial = nameInitial(displayName);
                    const time = clockTime(v.viewedAt);
                    const now = Date.now();
                    const diffSec = Math.max(0, Math.floor((now - v.viewedAt) / 1000));
                    // v4.32.421: «сегодня» и «вчера» считает календарь, а не
                    // вычитание суток из текущего момента.
                    const sameDay = isSameCalendarDay(v.viewedAt, now);
                    const isYesterday = calendarDaysAgo(v.viewedAt, now) === 1;
                    // v4.32.69: относительное время для свежих просмотров + absolute для давних
                    let whenLabel: string;
                    if (diffSec < 45) {
                      whenLabel = t('feed.time.justNow');
                    } else if (diffSec < 3600) {
                      const min = Math.max(1, Math.round(diffSec / 60));
                      whenLabel = t('feed.time.minAgo', { n: min });
                    } else if (sameDay) {
                      const hr = Math.floor(diffSec / 3600);
                      whenLabel = hr < 6 ? t('feed.time.hrAgo', { n: hr, time }) : t('feed.time.today', { time });
                    } else if (isYesterday) {
                      whenLabel = t('feed.time.yesterday', { time });
                    } else {
                      whenLabel = t('feed.time.date', { date: dayMonthShort(v.viewedAt), time });
                    }
                    return (
                      <AppPressable
                        key={v.viewerDid}
                        // v4.32.72: тап по зрителю → UserProfilePeek (карточка профиля + действия).
                        // Предварительно закрываем viewers-модалку и открываем peek через rAF —
                        // на Android стек из двух одновременно открытых Modal'ов может конфликтовать
                        // по z-order / dismiss handling (см. v4.32.26 RNGH + Modal).
                        onPress={() => {
                          const did = v.viewerDid;
                          setViewersPostId(null);
                          requestAnimationFrame(() => setPeekAuthorDid(did));
                        }}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingHorizontal: 16,
                          paddingVertical: 10,
                        }}
                      >
                        {/* v4.32.408: кружок был одним и тем же акцентом у всех —
                            столбец одинаковых точек ничего не различал. Тот же
                            различитель, что и везде в приложении. */}
                        <View
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            backgroundColor: identityAvatar(v.viewerDid).fill,
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 12,
                          }}
                        >
                          <Text style={{ color: identityAvatar(v.viewerDid).ink, fontWeight: '700', fontSize: 15 }}>{initial}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                            {displayName}
                          </Text>
                          <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                            {t('feed.viewerSaw', { when: whenLabel })}
                          </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                      </AppPressable>
                    );
                  })}
                </ScrollView>
              )}
            </AppPressable>
          </AppPressable>
        </GestureHandlerRootView>
      </Modal>

      {/* Share to chat modal */}
      <Modal visible={shareToTarget !== null} transparent animationType="slide" onRequestClose={() => setShareToTarget(null)}>
        {/* v4.32.25: GestureHandlerRootView обязателен для RNGH Pressable внутри Modal на Android. */}
        <GestureHandlerRootView style={{ flex: 1 }}>
        <AppPressable style={{ flex: 1, backgroundColor: scrim.modal }} onPress={() => setShareToTarget(null)}>
          <AppPressable onPress={() => {}} style={{ marginTop: 'auto', borderTopLeftRadius: 20, borderTopRightRadius: 20, backgroundColor: colors.surface, maxHeight: '75%' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
              <Ionicons name="paper-plane-outline" size={18} color={colors.accent} style={{ marginRight: 10 }} />
              <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, flex: 1 }}>{t('feed.shareTitle')}</Text>
              <AppPressable onPress={() => setShareToTarget(null)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </AppPressable>
            </View>
            <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
              <TextInput
                style={{ backgroundColor: colors.surfaceHigh, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, color: colors.text, fontSize: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
                placeholder={t('feed.shareSearchPlaceholder')}
                placeholderTextColor={colors.textMuted}
                value={shareQuery}
                onChangeText={setShareQuery}
                autoFocus={false}
              />
            </View>
            <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
              {/* Groups section */}
              {shareFilteredGroups.length > 0 ? (
                <>
                  <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '600', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {t('feed.shareSectionGroups')}
                  </Text>
                  {shareFilteredGroups.map((g) => (
                    <AppPressable
                      key={g.id}
                      onPress={() => void handleShareToGroup(g)}
                      disabled={shareSending}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}
                    >
                      <View style={{ marginRight: 12 }}>
                        <GroupAvatar name={g.name} size={40} type={g.type} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }} numberOfLines={1}>{g.name}</Text>
                        {g.memberCount > 0 ? (
                          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                            {g.type === 'channel' ? t('feed.groupSubs', { n: g.memberCount }) : t('feed.groupMembers', { n: g.memberCount })}
                          </Text>
                        ) : null}
                      </View>
                      <Ionicons name="paper-plane-outline" size={18} color={colors.accent} />
                    </AppPressable>
                  ))}
                </>
              ) : null}
              {/* Contacts section */}
              {shareFilteredGroups.length > 0 && shareFilteredContacts.length > 0 ? (
                <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '600', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {t('feed.shareSectionContacts')}
                </Text>
              ) : null}
              {shareFilteredContacts.length === 0 && shareFilteredGroups.length === 0 ? (
                <Text style={{ textAlign: 'center', color: colors.textMuted, marginTop: 24, fontSize: 14 }}>
                  {shareTargets === 'loading'
                    ? t('common.loading')
                    : shareTargets === 'failed'
                      ? t('feed.shareTargetsFailed')
                      : shareContacts.length === 0 && shareGroups.length === 0
                        ? t('feed.shareNoTargets')
                        : t('feed.shareNotFound')}
                </Text>
              ) : shareFilteredContacts.map((c) => (
                <AppPressable
                  key={c.peerPublicKey}
                  onPress={() => void handleShareToContact(c)}
                  disabled={shareSending}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}
                >
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: identityAvatar(c.peerPublicKey).fill, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                    <Text style={{ color: identityAvatar(c.peerPublicKey).ink, fontWeight: '700', fontSize: 16 }}>
                      {nameInitial(c.displayName)}
                    </Text>
                  </View>
                  <Text style={{ color: colors.text, fontSize: 15, flex: 1 }}>{contactLabel(c.displayName, shortIdentity(c.peerPublicKey))}</Text>
                  <Ionicons name="paper-plane-outline" size={18} color={colors.accent} />
                </AppPressable>
              ))}
            </ScrollView>
          </AppPressable>
        </AppPressable>
        </GestureHandlerRootView>
      </Modal>
      {/* v4.32.34: Action-sheet для долгого нажатия на пост — замена Alert.alert, который
          на Android capped at 3 buttons. Рендерится как bottom-sheet Modal с прокручиваемым
          списком действий. Учитывает isSelf / isTranslated / item.archived / item.repostOf. */}
      <Modal
        visible={actionSheetPost !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setActionSheetPost(null)}
      >
        <GestureHandlerRootView style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: scrim.modal }}>
          <AppPressable
            style={StyleSheet.absoluteFill}
            onPress={() => setActionSheetPost(null)}
          />
          {(() => {
            const p = actionSheetPost;
            if (!p) return null;
            const myDidLocal = did;
            const isSelfP = p.authorDid === myDidLocal;
            const isArchivedP = !!p.archived;
            const isTranslatedP = !!translatedPosts[p.id];
            const isMutedP = mutedAuthors.has(p.authorDid);
            // v4.32.587: у непрочитанной записи текста нет — есть пустая
            // строка, и копировать, переводить или править её нечего.
            const hasText = mayReuseFeedText(p) && !!p.text && !p.text.startsWith('\x04');
            const close = () => setActionSheetPost(null);
            const row = (
              icon: string,
              label: string,
              onPress: () => void,
              opts?: { destructive?: boolean; iconColor?: string }
            ) => (
              <AppPressable
                key={label}
                onPress={() => { close(); onPress(); }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 18 }}
              >
                <Ionicons name={icon as never} size={22} color={opts?.destructive ? colors.error : (opts?.iconColor ?? colors.accent)} style={{ marginRight: 16, width: 24 }} />
                <Text style={{ fontSize: 16, color: opts?.destructive ? colors.error : colors.text, flex: 1 }}>{label}</Text>
              </AppPressable>
            );
            return (
              <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 8, paddingBottom: (insets.bottom || 12) + 8 }}>
                <View style={{ alignItems: 'center', paddingVertical: 6 }}>
                  <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
                </View>
                <Text style={{ fontSize: 13, color: colors.textSecondary, paddingHorizontal: 18, paddingBottom: 8 }} numberOfLines={1}>
                  {isSelfP ? t('common.you') : shownName(p.authorName, p.nameUnreadable, shortIdentity(p.authorDid))}
                </Text>
                <ScrollView style={{ maxHeight: 440 }}>
                  {row('happy-outline', t('feed.menuReaction'), () => setReactionTarget(p.id))}
                  {hasText ? row('copy-outline', t('feed.menuCopyText'), () => { void Clipboard.setStringAsync(p.text ?? '').then(() => showSuccess(t('feed.menuCopied'))); }) : null}
                  {hasText ? (
                    isTranslatedP
                      ? row('language-outline', t('feed.menuHideTranslation'), () => setTranslatedPosts((prev) => { const next = { ...prev }; delete next[p.id]; return next; }))
                      : row('language-outline', t('feed.menuTranslate'), () => void translatePost(p))
                  ) : null}
                  {!isSelfP ? row(
                    isMutedP ? 'eye-outline' : 'eye-off-outline',
                    isMutedP ? t('feed.menuShowAuthor') : t('feed.menuHideAuthor'),
                    () => runFeedOp(() => toggleMuteAuthor(p.authorDid), t('feed.muteAuthorFailed')),
                  ) : null}
                  {row(
                    mutedPosts.has(p.id) ? 'notifications' : 'notifications-off-outline',
                    mutedPosts.has(p.id) ? 'Включить уведомления о комментариях' : 'Отключить уведомления о комментариях',
                    () => runGuardedOp(() => toggleMutePost(p.id), t('feed.mutePostFailed')),
                  )}
                  {isSelfP && hasText && !p.repostOf ? row('create-outline', t('feed.edit'), () => {
                    setEditingPost(p);
                    setDraft(p.text ?? '');
                    setUris([]);
                    setPostLocationTag(null);
                    setIsPollMode(false);
                    setModalOpen(true);
                  }) : null}
                  {row(
                    isArchivedP ? 'archive' : 'archive-outline',
                    isArchivedP ? t('feed.menuUnarchive') : t('feed.menuArchive'),
                    // v4.32.91: error surface — раньше при сбое SQL юзер думал что
                    // действие прошло, но пост не архивировался.
                    () => runFeedOp(async () => {
                      await setFeedPostArchived(p.id, !isArchivedP);
                      showSuccess(isArchivedP ? t('feed.unarchivedToast') : t('feed.archivedToast'));
                    }, t('feed.archiveFailed')),
                  )}
                  {row('trash-outline', t('feed.menuDeletePost'), () => {
                    Alert.alert(
                      t('feed.deletePostConfirm'),
                      isSelfP
                        ? t('feed.deletePostSelfMsg')
                        : t('feed.deletePostOtherMsg'),
                      [
                        { text: t('common.cancel'), style: 'cancel' },
                        {
                          text: t('common.delete'),
                          style: 'destructive',
                          onPress: () => {
                            if (isSelfP) {
                              runFeedOp(() => deleteFeedPost(pair, p.id), t('feed.deletePostFailed'));
                            } else {
                              runFeedOp(() => deleteFeedPostLocal(p.id), t('feed.deletePostFailed'));
                            }
                          },
                        },
                      ],
                    );
                  }, { destructive: true })}
                  {row('close-outline', t('common.cancel'), () => {}, { iconColor: colors.textSecondary })}
                </ScrollView>
              </View>
            );
          })()}
        </GestureHandlerRootView>
      </Modal>
      {feedMediaViewerElement}
      {/* v4.32.50: профиль автора поста/комментария при тапе по имени/аватару */}
      <UserProfilePeek
        visible={peekAuthorDid !== null}
        onClose={() => setPeekAuthorDid(null)}
        peerDid={peekAuthorDid}
        pair={pair}
      />
      </KeyboardHost>
    </SafeScreen>
  );
}

function makeCmStyles(c: AppColors) { return StyleSheet.create({
  commentRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, paddingHorizontal: 12, marginHorizontal: 8, marginVertical: 4, backgroundColor: c.surface, borderRadius: 12 },
  commentAuthor: { color: c.accent, fontWeight: '600', fontSize: 13 },
  commentTime: { color: c.textMuted, fontSize: 11 },
  commentText: { color: c.text, fontSize: 14, lineHeight: 20, marginTop: 2 },
  // v4.32.588: пометка вместо пустого пузыря — тот же размер, но спокойнее.
  commentUnreadable: { color: c.warning, fontStyle: 'italic' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8, paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingBottom: 8, backgroundColor: c.background },
  commentInput: { flex: 1, color: c.text, fontSize: 15, backgroundColor: c.surfaceHigh, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, maxHeight: 100, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  sendBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  sendInk: { color: contrastingInk(c.primary) },
  // v4.32.159: full-screen comments UI.
  screenHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, backgroundColor: c.background },
  screenHeaderSide: { width: 44, alignItems: 'center', justifyContent: 'center' },
  screenHeaderTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: c.text },
  pinnedPost: { padding: 14, marginHorizontal: 8, marginTop: 8, marginBottom: 4, borderRadius: 14, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  pinnedAuthor: { color: c.text, fontWeight: '600', fontSize: 14 },
  pinnedTime: { color: c.textMuted, fontSize: 11, marginTop: 1 },
  pinnedBody: { color: c.text, fontSize: 15, lineHeight: 21 },
  pinnedReactionPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.surfaceHigh, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  pinnedReactionCount: { fontSize: 12, color: c.textSecondary, fontWeight: '500' },
  separatorRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 10, paddingHorizontal: 16, gap: 10 },
  separatorLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border },
  separatorText: { color: c.textMuted, fontSize: 12, fontWeight: '500' },
}); }

function makeStyles(c: AppColors) {
  // Плашка реакции лежит на карточке поста — от неё и считается (v4.32.395).
  const reaction = reactionInk(c, c.surface);
  // v4.32.406. Плашка очереди — это плашка состояния «внимание», и в палитре
  // для неё есть badgeTint: подложка считается от фона экрана, а надпись — от
  // подложки. Раньше подложка была вписана прозрачным янтарём, а надпись —
  // литералом '#ffb020', и в светлой теме давала на ней 1.66:1. Соседняя
  // плашка «непрочитанные» всё это время делала ровно правильно.
  const queue = badgeTint(c, 'warning', c.background);
  const queueInk = inkOn(c, queue.fill);
  return StyleSheet.create({
  // v4.32.36: paddingTop уменьшен с 16 до 8, чтобы h1 «Новости» не отваливался
  // ниже статус-бара больше, чем нужно. Боковой padding 16 остаётся.
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, backgroundColor: c.background },
  feedChrome: { marginBottom: 8, borderRadius: 18, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8 },
  list: { flex: 1 },
  // v4.32.36: topRow теперь одна строка (h1 + кнопки); marginBottom 8 вместо 4.
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  composeBtn: { padding: 4 },
  h1: { fontSize: 22, fontWeight: '700', color: c.text },
  subtitle: { color: c.textMuted, fontSize: 12, marginTop: 4, lineHeight: 17 },
  idRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  meta: { color: c.textSecondary, fontSize: 12, flex: 1 },
  unreadBanner: {
    backgroundColor: c.primaryMuted,
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: c.border,
  },
  // v4.32.407: надпись лежит на приглушённой заливке, а не на фоне.
  unreadText: { color: readableInk(c.accent, c.primaryMuted, 4.5), fontSize: 13, textAlign: 'center', fontWeight: '600' },
  queueBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: queue.fill,
    padding: 12,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: c.warning,
  },
  queueText: { color: queue.ink, fontSize: 13, fontWeight: '600' },
  // Подсказка лежит на той же подложке, значит и считается от неё, а не от
  // фона экрана: textMuted проверен на фоне, а не на янтаре.
  queueHint: { color: queueInk.secondary, fontSize: 11, marginTop: 4 },
  timeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 2 },
  pendingSpinner: { marginLeft: 8 },
  pendingLabel: { color: c.accent, fontSize: 12, marginLeft: 6, fontWeight: '600' },
  emptyState: { alignItems: 'center', marginTop: 48, paddingHorizontal: 24 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { color: c.textSecondary, fontSize: 18, fontWeight: '600', marginBottom: 8 },
  empty: { color: c.textMuted, textAlign: 'center', paddingHorizontal: 16 },
  card: {
    padding: 12,
    backgroundColor: c.surface,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  // v4.32.396: было '#151d38' — тёмно-синий литерал внутри темизированной
  // фабрики. В светлой теме непрочитанный пост получал почти чёрную карточку
  // под тёмный текст: `text` давал на ней 1.24:1. Приподнятая поверхность —
  // ровно та роль, что здесь нужна, и её содержимое палитра уже проверяет.
  cardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: c.primary,
    backgroundColor: c.surfaceHigh,
  },
  postHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  postHeaderText: { marginLeft: 10, flex: 1 },
  author: { color: c.text, fontWeight: '600', fontSize: 15 },
  time: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  body: { color: c.text, fontSize: 15, lineHeight: 22 },
  // v4.32.587: пометка о непрочитанной записи — на месте её текста.
  unreadableRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  unreadableText: { color: c.warning, fontSize: 15, fontStyle: 'italic', flex: 1 },
  mediaRow: { marginTop: 8 },
  thumb: { width: 120, height: 120, borderRadius: 8, marginRight: 8, backgroundColor: c.primaryMuted },
  modalOverlay: {
    flex: 1,
    backgroundColor: scrim.modal,
    justifyContent: 'flex-end',
  },
  modalKeyboardAvoid: {
    flex: 1,
    width: '100%',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: c.background,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 16,
    paddingTop: 12,
    overflow: 'hidden',
    flexDirection: 'column',
  },
  modalTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
    flexShrink: 0,
  },
  modalTopBarSide: {
    minWidth: 96,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  modalTopBarSideEnd: {
    justifyContent: 'flex-end',
  },
  modalCancelText: {
    fontSize: 16,
    color: c.textSecondary,
    fontWeight: '500',
  },
  modalTitleCentered: {
    flex: 1,
    textAlign: 'center',
    color: c.text,
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  modalHeaderPublish: {
    fontSize: 16,
    fontWeight: '700',
    color: c.accent,
  },
  modalHeaderPublishDisabled: {
    color: c.textMuted,
  },
  modalScrollArea: {
    flex: 1,
    flexGrow: 1,
    minHeight: 120,
  },
  modalScrollBody: {
    paddingBottom: 12,
    flexGrow: 1,
  },
  modalScrollBottomSpacer: {
    height: 12,
  },
  modalInput: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    padding: 12,
    color: c.text,
    backgroundColor: c.surface,
    marginBottom: 12,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
  previewHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  previewHeaderText: {
    fontSize: 12,
    color: c.textSecondary,
    marginLeft: 6,
  },
  previewClearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  previewRow: {
    marginBottom: 8,
  },
  previewRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  previewWrap: {
    marginRight: 10,
    position: 'relative',
    width: THUMB,
    height: THUMB,
    borderRadius: 14,
    overflow: 'visible',
    backgroundColor: c.primaryMuted,
  },
  previewImg: {
    width: THUMB,
    height: THUMB,
    borderRadius: 14,
    backgroundColor: c.primaryMuted,
  },
  previewIndexBadge: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: mediaScrim.bar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewIndexText: {
    color: mediaScrim.ink,
    fontSize: 11,
    fontWeight: '700',
  },
  removeImg: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: c.background,
    borderRadius: 12,
  },
  previewAddTile: {
    width: THUMB,
    height: THUMB,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: c.primary,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    // v4.32.408: подложка плитки считается от фона листа, надпись — от неё.
    backgroundColor: badgeTint(c, 'accent', c.background).fill,
  },
  previewAddText: {
    fontSize: 11,
    color: badgeTint(c, 'accent', c.background).ink,
    marginTop: 2,
    fontWeight: '600',
  },
  modalBottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    flexShrink: 0,
    backgroundColor: c.background,
  },
  // v4.32.228 (BUG-02): the attach bar is a horizontal ScrollView so the 4th
  // action («Файл») is never clipped off the right edge on narrow (≤360dp)
  // devices. flexGrow + space-around keeps the items evenly spread when they
  // already fit, and lets them scroll when they don't.
  modalBottomBarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flexGrow: 1,
    justifyContent: 'space-around',
    paddingHorizontal: 6,
    gap: 6,
  },
  iconAction: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: c.surface,
  },
  iconActionText: { color: c.accent, marginLeft: 6, fontWeight: '600' },
  // Repost
  repostBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 4,
  },
  repostBannerText: {
    color: c.textSecondary,
    fontSize: 12,
    fontStyle: 'italic',
  },
  // Reactions
  reactionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 6,
  },
  reactionBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // v4.32.395: было 'rgba(61,90,254,0.15)' с таким же контуром — акцент по
    // умолчанию, одинаковый в обеих темах. Плашка — вложенный блок на карточке,
    // поэтому считается от неё, как и в переписке (см. reactionInk).
    backgroundColor: reaction.fill,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: reaction.border,
  },
  reactionEmoji: { fontSize: 16, textAlign: 'center', textAlignVertical: 'center' },
  // Счётчик лежит на заливке плашки, а не на карточке: у `textSecondary` на ней
  // в светлой теме не хватало порога.
  reactionCount: { color: reaction.count, fontSize: 12, marginLeft: 4, fontWeight: '600', textAlign: 'center' },
  reactionAddBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionAddIcon: { color: c.textSecondary, fontSize: 18, textAlign: 'center', includeFontPadding: false },
  // Emoji picker modal
  emojiOverlay: {
    flex: 1,
    backgroundColor: scrim.modal,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // v4.32.406: было '#1a2340' (см. 396-й, там был '#151d38'). В светлой теме
  // `text` давал на этой карточке 1.10:1.
  emojiSheet: {
    backgroundColor: c.surfaceHigh,
    borderRadius: 20,
    padding: 20,
    width: 320,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  emojiTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 16,
  },
  emojiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 4,
  },
  emojiBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: nestedFill(c.surfaceHigh),
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  emojiBtnText: { fontSize: 22, textAlign: 'center', includeFontPadding: false },
}); }

// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: React.memo — предотвращает re-render при каждом setTab в App.tsx (v4.32.5).
export const FeedScreen = React.memo(FeedScreenImpl);
