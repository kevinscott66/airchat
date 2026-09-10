/**
 * StoriesRow — горизонтальная лента сторис (аналог Telegram Stories).
 * Отображается вверху экрана чатов.
 *
 * - Моя сторис: первый элемент с кнопкой «+»
 * - Чужие сторис: пузырьки с аватарками контактов
 * - Просмотр: открывает полноэкранный StoryViewer
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Dimensions,
  Alert,
  TextInput,
  KeyboardAvoidingView,
  Animated,
} from 'react-native';
import { AppPressable } from './AppPressable';
// v4.32.27: Modal заменён на AppModal — автоматически оборачивает в
// GestureHandlerRootView, чтобы RNGH Pressable внутри Modal получал касания.
import { AppModal as Modal } from './AppModal';
import { StoryComposerModal, type StoryDraft } from './StoryComposerModal';
import * as FileSystem from 'expo-file-system/legacy';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { profileManager } from '../../core/identity/profileManager';
import {
  listActiveStories,
  markStoryViewed,
  deleteExpiredStories,
  deleteStory,
  type StoryRow,
} from '../../core/storage/local';
import { listContacts } from '../../core/social/contacts';
import { publishStory, subscribeStoryUpdates } from '../../core/social/storyService';
import { storyPublishProblem } from '../../core/social/storyPublishOutcome';
import { storyIsUnreadable } from '../../core/media/storyMediaSweep';
import { UNREADABLE_STORY_TEXT, UNREADABLE_VIEWERS_TEXT } from '../../core/storage/unreadableText';
import { mayCountViewers, parseViewerList, storyRingUnread, viewerCount } from '../../core/social/viewerList';
/**
 * v4.32.365. Модуль брал `colors` — это тёмная палитра как таковая, а не
 * активная тема. Следствий два, и оба видны на экране:
 *
 *   • в светлой теме лента сторис оставалась куском тёмной: подпись под
 *     кружком (#9aa3c0 на #F2F2F7 — 2.2:1 при пороге 4.5:1) не читалась, а
 *     нижняя граница ленты рисовалась тёмно-синей чертой поперёк светлого
 *     списка чатов;
 *   • выбранный в настройках цвет акцента до сторис не доходил вовсе —
 *     кольцо непрочитанного и кнопка «Опубликовать» оставались синими,
 *     какой бы цвет человек ни выбрал.
 *
 * Разделение здесь такое же, как для исходящего пузыря: просмотрщик и
 * редактор сторис лежат поверх фотографии на чёрном и остаются тёмными в
 * любой теме, поэтому текст на них берётся из `darkColors` явно — тянуть туда
 * светлую палитру значило бы написать #036B96 по чёрному. А заливки (`primary`)
 * темы слушаются везде: normalizeAccent гарантирует читаемость белой надписи
 * поверх любой из них.
 */
import { avatarShape, darkColors, font, inkOn, mediaScrim, primaryInk, radius, STORY_TEXT_VIEWER_BG } from '../theme';
import { useColors } from '../ThemeContext';
import { showError } from './userFeedback';
import { log } from '../../core/logger';
// v4.32.50: модалка профиля при тапе на имя автора сторис.
import { UserProfilePeek } from './UserProfilePeek';
import { nameInitial } from '../../core/social/contactLabel';
import { shortIdentity } from '../identity/shortId';
import { rawErrorText, userErrorText } from './userErrorText';

const { width: W, height: H } = Dimensions.get('window');

/**
 * Адрес медиа ЧУЖОЙ сторис, пригодный к показу.
 *
 * v4.32.185 разрешал только http(s): в конверте тогда лежал адрес как есть, и
 * `file://`/`content://` от собеседника означали бы чтение чужого файла с
 * устройства получателя.
 *
 * v4.32.248: с v4.32.246 адрес больше не берётся из конверта — storyService
 * сам скачивает и расшифровывает вложение и кладёт файл в свой кэш, возвращая
 * либо путь в кэше, либо data:-строку. Ни то ни другое проверку не проходило,
 * поэтому у всех чужих сторис с картинкой или видео вместо медиа показывался
 * пустой текстовый фон. Проверка оставлена, но теперь она описывает то, что
 * приложение действительно умеет отдавать.
 */
function displayableRemoteStoryUri(uri: string): string {
  if (!uri) return '';
  if (/^https?:\/\//i.test(uri)) return uri;
  if (/^data:(image|video)\//i.test(uri)) return uri;
  const cache = FileSystem.cacheDirectory ?? '';
  if (cache && uri.startsWith(cache)) return uri;
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// StoryVideo — full-screen story video (expo-video). Owns the useVideoPlayer
// hook at its top level so it can be rendered conditionally without violating
// the rules of hooks. `playToEnd` advances to the next story (replaces the old
// onPlaybackStatusUpdate → didJustFinish → goNext).
// ─────────────────────────────────────────────────────────────────────────────

function StoryVideo({ uri, onFinish }: { uri: string; onFinish: () => void }): React.ReactElement {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = false;
    p.play();
  });
  useEffect(() => {
    const sub = player.addListener('playToEnd', () => onFinish());
    return () => sub.remove();
  }, [player, onFinish]);
  return (
    <VideoView
      player={player}
      style={sv.media}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Story viewer modal
// ─────────────────────────────────────────────────────────────────────────────

function StoryViewer({
  stories,
  startIndex,
  myPubB64,
  onClose,
  nameMap,
  pair,
  ownerProfileId,
  onOpenChatWithPeer,
}: {
  stories: StoryRow[];
  startIndex: number;
  myPubB64: string;
  onClose: () => void;
  nameMap?: Record<string, string>;
  pair: KeyPairBytes | null;
  ownerProfileId: number;
  /** v4.32.568: карточка автора сторис умеет открыть переписку — но не вкладку. */
  onOpenChatWithPeer?: (peer: string, intent?: 'chat' | 'search' | 'starred') => void;
}): React.ReactElement {
  const [index, setIndex] = useState(startIndex);
  const story = stories[index];
  // v4.32.50: тап по имени автора сторис открывает карточку профиля
  // (UserProfilePeek). Для своей сторис тап игнорируется — профиль и так свой.
  const [peekPubB64, setPeekPubB64] = useState<string | null>(null);
  const STORY_DURATION_MS = 6000;
  const [replyText, setReplyText] = useState('');
  const [replyPaused, setReplyPaused] = useState(false);
  const c = useColors();

  /**
   * Ответ на сторис уходит обычным сообщением в личку — с пометкой, на что
   * он отвечает: у автора сторис в переписке иначе появлялось бы просто
   * «❤️» без всякого повода.
   *
   * v4.32.248: ответ эмодзи начинался с невидимого U+200D (zero-width joiner).
   * Его никто не читал — ни превью, ни разбор конвертов, — зато перед эмодзи
   * он оказывался частью самой последовательности символов и мог менять её
   * отрисовку. Обе кнопки теперь шлют одну и ту же строку.
   */
  const sendStoryReply = (text: string): void => {
    if (!text || !story) return;
    const { getMessagingService } = require('../../core/social/messaging') as typeof import('../../core/social/messaging');
    const svc = getMessagingService();
    // v4.32.335: ответ уходил молча в обе стороны — ни подтверждения, ни отказа.
    // Поле при этом очищается и сторис пролистывается дальше, так что человек
    // считает ответ отправленным. Автор мог его заблокировать, мог сработать
    // часовой лимит — sendMessage в обоих случаях отвечает null.
    void (async () => {
      const id = svc ? await svc.sendMessage(story.authorPubB64, `💬 → [сторис]: ${text}`) : null;
      if (!id) showError('Ответ не отправлен');
    })().catch(() => showError('Ответ не отправлен'));
  };

  const sendReply = () => {
    sendStoryReply(replyText.trim());
    setReplyText('');
    setReplyPaused(false);
    goNext();
  };
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!story) return;
    // v4.32.672: своя сторис не считается просмотренной самим автором.
    //
    // Список `viewed_by` показывается только автору и означает «кто её
    // посмотрел». Открывая свою сторис — а автор открывает её хотя бы затем,
    // чтобы узнать число просмотров, — он дописывал в этот список себя, и
    // счётчик показывал «Просмотрело 1 чел.» при полном отсутствии зрителей,
    // а в самом списке первым стоял он сам. Заодно уходила одна из пятисот
    // ячеек и открывалась пишущая транзакция на каждый кадр своей ленты.
    //
    // Кружок «новая сторис» этим не затронут: своей группе он выставляется
    // в `hasUnread: false` напрямую, без списка зрителей.
    if (story.authorPubB64 === myPubB64) return;
    void markStoryViewed(story.id, myPubB64, ownerProfileId).catch(() => {});
  // Зависим именно от story?.id: с полным объектом story эффект перезапускался бы
  // при каждой смене ссылки и слал повторные markStoryViewed для той же сторис.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, myPubB64, ownerProfileId]);

  const goNext = useCallback(() => {
    if (index < stories.length - 1) setIndex(index + 1);
    else onClose();
  }, [index, stories.length, onClose]);

  const goPrev = useCallback(() => {
    if (index > 0) setIndex(index - 1);
  }, [index]);

  /**
   * v4.32.620: переход держим в ref, а эффект зависит только от того, что
   * действительно должно перезапускать полосу — номер сторис и пауза.
   *
   * Прежде в зависимостях стоял сам `goNext`, а он пересобирается при каждой
   * смене `onClose`; родитель же передаёт `onClose` встроенной стрелкой и
   * перерисовывается на каждой записи в переписку. В активном чате полоса
   * сбрасывалась в ноль на каждом входящем сообщении: шесть секунд не
   * дотикивали никогда, сторис не листались сами и не закрывались по концу.
   */
  const goNextRef = useRef(goNext);
  goNextRef.current = goNext;

  // Auto-advance and progress bar animation
  useEffect(() => {
    if (replyPaused) return;
    progressAnim.setValue(0);
    const anim = Animated.timing(progressAnim, {
      toValue: 1,
      duration: STORY_DURATION_MS,
      useNativeDriver: false,
    });
    anim.start(({ finished }: { finished: boolean }) => { if (finished) goNextRef.current(); });
    return () => anim.stop();
  }, [index, progressAnim, replyPaused]);

  if (!story) return <></>;

  // v4.32.590: разбор переехал в viewerList — он же отличает пустой список
  // от неизвестного. Раньше непрочитанный столбец давал «0 просмотров».
  const viewerList = parseViewerList(story.viewedBy, story.viewedUnreadable);
  const viewers = viewerList.viewers;
  const isOwn = story.authorPubB64 === myPubB64;

  return (
    <Modal visible animationType="fade" statusBarTranslucent onRequestClose={onClose} presentationStyle="overFullScreen">
      <View style={sv.root}>
        {/* Progress indicators */}
        <View style={sv.progress}>
          {stories.map((_, i) => (
            i < index ? (
              <View key={i} style={[sv.progressBar, { backgroundColor: mediaScrim.ink }]} />
            ) : i === index ? (
              <View key={i} style={[sv.progressBar, { backgroundColor: mediaScrim.bar, overflow: 'hidden' }]}>
                <Animated.View style={{ height: '100%', backgroundColor: mediaScrim.ink, width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
              </View>
            ) : (
              <View key={i} style={[sv.progressBar, { backgroundColor: mediaScrim.bar }]} />
            )
          ))}
        </View>
        {/* Image / video or text */}
        {(() => {
          // v4.32.586: столбец, который ключ не открыл, приходил пустотой, и
          // сторис рисовалась пустой чёрной карточкой — как будто человек
          // выложил ничего. Пометка стоит на месте самой сторис.
          if (storyIsUnreadable(story.mediaUnreadable, story.textUnreadable)) {
            return (
              <View style={sv.textBg}>
                <Ionicons name="alert-circle-outline" size={44} color={mediaScrim.ink} />
                <Text numberOfLines={3} style={[sv.textContent, sv.unreadable]}>{UNREADABLE_STORY_TEXT}</Text>
              </View>
            );
          }
          const rawUri = story.mediaUri ?? '';
          const safeUri = isOwn ? rawUri : displayableRemoteStoryUri(rawUri);
          return safeUri && story.mediaType === 'video' ? (
            <StoryVideo uri={safeUri} onFinish={goNext} />
          ) : safeUri ? (
            <Image source={{ uri: safeUri }} style={sv.media} resizeMode="cover" />
          ) : (
            <View style={sv.textBg}>
              {/* v4.32.374: предел по строкам. Текст сторис — 4096 символов, и
                  чередование «а\nб\nв» даёт две тысячи строк: экран уезжает, а
                  закрыть сторис нечем — кнопка тоже уехала. */}
              <Text numberOfLines={12} style={sv.textContent}>{story.text}</Text>
            </View>
          );
        })()}
        {/* Text overlay */}
        {story.mediaUri && story.text && !storyIsUnreadable(story.mediaUnreadable, story.textUnreadable) ? (
          <View style={sv.textOverlay}>
            {/* Подпись поверх картинки: тот же предел, но короче — она лежит
                над самим снимком и закрывать его целиком не должна. */}
            <Text numberOfLines={4} style={sv.textOverlayText}>{story.text}</Text>
          </View>
        ) : null}
        {/* Header */}
        <View style={sv.header}>
          {/* v4.32.614: «Моя сторис» никуда не ведёт, но нажатие сжимало
              строку — отклик на палец без действия. См. FeedScreen. */}
          <AppPressable
            style={sv.authorInfo}
            hitSlop={4}
            disabled={isOwn}
            onPress={() => setPeekPubB64(story.authorPubB64)}
          >
            <View style={[sv.authorDot, { backgroundColor: c.primary }]} />
            <Text style={sv.authorName}>
              {isOwn ? 'Моя сторис' : (nameMap?.[story.authorPubB64] ?? shortIdentity(story.authorPubB64))}
            </Text>
          </AppPressable>
          <View style={sv.headerActions}>
            {isOwn ? (
              <AppPressable
                hitSlop={16}
                onPress={() => {
                  Alert.alert('Сторис', undefined, [
                    {
                      text: '🗑 Удалить сторис',
                      style: 'destructive',
                      onPress: () => {
                        // v4.32.625: у обещания не было .catch. deleteStory
                        // ходит в базу и сносит файл снимка — отказ там
                        // возможен, и тогда onClose не звался: просмотрщик
                        // оставался открытым с той же сторис, без единого
                        // слова о том, что удаление не прошло.
                        void deleteStory(story.id, ownerProfileId)
                          .then(onClose)
                          .catch((e) => {
                            log.warn('ui_story_delete_failed', { err: rawErrorText(e) });
                            showError('Не удалось удалить сторис.');
                          });
                      },
                    },
                    !mayCountViewers(viewerList) ? {
                      text: `👁 ${UNREADABLE_VIEWERS_TEXT}`,
                      onPress: () => {
                        Alert.alert('Просмотры', UNREADABLE_VIEWERS_TEXT, [{ text: 'ОК' }]);
                      },
                    } : viewers.length > 0 ? {
                      text: `👁 Просмотрело ${viewers.length} чел.`,
                      onPress: () => {
                        Alert.alert(
                          'Просмотры',
                          viewers.map((v) => {
                            const name = nameMap?.[v];
                            return name ?? `${v.slice(0, 10)}…`;
                          }).join('\n') || 'Нет данных',
                          [{ text: 'ОК' }]
                        );
                      },
                    } : null,
                    { text: 'Отмена', style: 'cancel' },
                  ].filter(Boolean) as import('react-native').AlertButton[]);
                }}
              >
                <Ionicons name="ellipsis-vertical" size={24} color={mediaScrim.ink} />
              </AppPressable>
            ) : null}
            <AppPressable onPress={onClose} hitSlop={16}>
              <Ionicons name="close" size={28} color={mediaScrim.ink} />
            </AppPressable>
          </View>
        </View>
        {/* View count for own stories */}
        {isOwn && !mayCountViewers(viewerList) ? (
          <View style={sv.viewCount}>
            <Ionicons name="eye-off-outline" size={16} color={mediaScrim.ink} />
            <Text style={sv.viewCountText}>?</Text>
          </View>
        ) : isOwn && viewerCount(viewerList) > 0 ? (
          <View style={sv.viewCount}>
            <Ionicons name="eye-outline" size={16} color={mediaScrim.ink} />
            <Text style={sv.viewCountText}>{viewerCount(viewerList)}</Text>
          </View>
        ) : null}
        {/* Story reaction emojis (non-own stories, not in reply mode) */}
        {!isOwn && !replyPaused ? (
          <View style={sv.replyBar}>
            {['❤️', '🔥', '😂', '😮', '👏', '🎉'].map((emoji) => (
              <AppPressable
                key={emoji}
                style={sv.reactionBtn}
                onPress={() => {
                  sendStoryReply(emoji);
                  goNext();
                }}
              >
                <Text style={{ fontSize: 26 }}>{emoji}</Text>
              </AppPressable>
            ))}
          </View>
        ) : null}
        {/* Text reply input (non-own stories) */}
        {!isOwn ? (
          // v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet)
          <KeyboardAvoidingView
            behavior="padding"
            keyboardVerticalOffset={0}
            style={sv.replyInputBar}
          >
            <TextInput
              style={sv.replyInput}
              placeholder="Ответить на сторис…"
              placeholderTextColor={mediaScrim.inkMuted}
              value={replyText}
              onChangeText={setReplyText}
              onFocus={() => setReplyPaused(true)}
              onBlur={() => { if (!replyText.trim()) setReplyPaused(false); }}
              multiline={false}
              returnKeyType="send"
              onSubmitEditing={sendReply}
            />
            {replyText.trim() ? (
              <AppPressable onPress={sendReply} style={{ marginLeft: 8, padding: 8 }}>
                {/* Значок лежит на затемнённой полосе поверх фото — тёмная палитра. */}
                <Ionicons name="send" size={22} color={darkColors.accent} />
              </AppPressable>
            ) : null}
          </KeyboardAvoidingView>
        ) : null}
        {/* Tap zones — only when reply input is not focused */}
        {!replyPaused ? (
          <>
            <AppPressable style={[sv.tapZone, { left: 0, width: W * 0.4 }]} onPress={goPrev} />
            <AppPressable style={[sv.tapZone, { right: 0, width: W * 0.6 }]} onPress={goNext} />
          </>
        ) : null}
        {/* v4.32.50: профиль автора сторис по тапу на имя. */}
        <UserProfilePeek
          visible={peekPubB64 !== null}
          onClose={() => setPeekPubB64(null)}
          peerPubB64={peekPubB64}
          pair={pair}
          onOpenChat={
            onOpenChatWithPeer
              ? (peer, _name, intent) => { onClose(); onOpenChatWithPeer(peer, intent); }
              : undefined
          }
        />
      </View>
    </Modal>
  );
}

const sv = StyleSheet.create({
  root: { flex: 1, backgroundColor: mediaScrim.fill },
  progress: { position: 'absolute', top: 44, left: 8, right: 8, flexDirection: 'row', gap: 4, zIndex: 10 },
  progressBar: { flex: 1, height: 2, borderRadius: 1 },
  media: { width: W, height: H },
  textBg: { flex: 1, backgroundColor: STORY_TEXT_VIEWER_BG, alignItems: 'center', justifyContent: 'center', padding: 32 },
  textContent: { color: inkOn(darkColors, STORY_TEXT_VIEWER_BG).text, fontSize: 22, fontWeight: '600', textAlign: 'center', lineHeight: 32 },
  // v4.32.586: пометка о непрочитанной сторис — тот же размер, но спокойнее
  // обычной подписи: это не то, что человек написал.
  unreadable: { fontSize: 17, fontWeight: '500', fontStyle: 'italic', marginTop: 12 },
  textOverlay: { position: 'absolute', bottom: 100, left: 0, right: 0, padding: 16, backgroundColor: mediaScrim.bar },
  textOverlayText: { color: mediaScrim.ink, fontSize: 18, fontWeight: '500' },
  header: { position: 'absolute', top: 52, left: 8, right: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  authorInfo: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: mediaScrim.bar, borderRadius: radius.xl, paddingLeft: 4, paddingRight: 12, paddingVertical: 4 },
  authorDot: { ...avatarShape(36), borderWidth: 2, borderColor: mediaScrim.ink },
  authorName: { color: mediaScrim.ink, fontWeight: '600', fontSize: 15 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: mediaScrim.bar, borderRadius: radius.xl, paddingHorizontal: 10, paddingVertical: 6 },
  viewCount: { position: 'absolute', bottom: 40, left: 16, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: mediaScrim.bar, borderRadius: radius.lg, paddingHorizontal: 10, paddingVertical: 5 },
  viewCountText: { color: mediaScrim.ink, fontSize: 14 },
  tapZone: { position: 'absolute', top: 0, bottom: 0 },
  replyBar: { position: 'absolute', bottom: 90, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 8, paddingHorizontal: 16 },
  reactionBtn: { padding: 8 },
  replyInputBar: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, paddingBottom: 28, backgroundColor: mediaScrim.bar },
  replyInput: { flex: 1, color: mediaScrim.ink, fontSize: 15, borderWidth: 1, borderColor: mediaScrim.inkMuted, borderRadius: radius.xl, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: mediaScrim.field },
});

// ─────────────────────────────────────────────────────────────────────────────
// Stories bubble in the list
// ─────────────────────────────────────────────────────────────────────────────

type StoryGroup = { authorPubB64: string; stories: StoryRow[]; hasUnread: boolean; displayName: string };

function StoryBubble({
  group,
  onPress,
  isMe,
}: {
  group: StoryGroup;
  onPress: () => void;
  isMe: boolean;
}): React.ReactElement {
  const c = useColors();
  const letter = nameInitial(group.displayName);
  // Кольцо прочитанного было белым с прозрачностью 0.2 — на светлом фоне
  // списка чатов это 1.01:1, то есть его там попросту нет. Берём разделитель
  // палитры: та же заметность, что у любой другой черты в приложении, и
  // порядок сохраняется — непрочитанное (3.7:1) по-прежнему ярче прочитанного.
  const ringColor = group.hasUnread ? c.primary : c.border;

  return (
    <AppPressable style={sb.wrap} onPress={onPress}>
      <View style={[sb.ring, { borderColor: ringColor }]}>
        <View style={[sb.avatar, { backgroundColor: isMe ? c.primary : c.surfaceHigh }]}>
          {isMe ? (
            <Ionicons name="add" size={24} color={primaryInk(c).text} />
          ) : (
            <Text style={[sb.letter, { color: c.text }]}>{letter}</Text>
          )}
        </View>
      </View>
      <Text style={[sb.name, { color: c.textSecondary }]} numberOfLines={1}>
        {isMe ? 'Моя' : group.displayName.split(' ')[0]}
      </Text>
    </AppPressable>
  );
}

const sb = StyleSheet.create({
  wrap: { alignItems: 'center', width: 68 },
  ring: { ...avatarShape(60), borderWidth: 2.5, padding: 2, marginBottom: 4 },
  avatar: { flex: 1, borderRadius: avatarShape(51).borderRadius, alignItems: 'center', justifyContent: 'center' },
  letter: { fontSize: 20, fontWeight: '700' },
  name: { fontSize: font.xs, textAlign: 'center', maxWidth: 64 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  myPubB64: string;
  pair?: KeyPairBytes;
  /** Trigger a refresh from outside */
  refreshTick?: number;
  /** v4.32.568: открыть переписку с автором сторис из его карточки профиля. */
  onOpenChatWithPeer?: (peer: string, intent?: 'chat' | 'search' | 'starred') => void;
};

export function StoriesRow({
  myPubB64,
  pair,
  refreshTick,
  onOpenChatWithPeer,
}: Props): React.ReactElement {
  const [groups, setGroups] = useState<StoryGroup[]>([]);
  const [viewerTarget, setViewerTarget] = useState<{ stories: StoryRow[]; index: number } | null>(null);
  const [composerVisible, setComposerVisible] = useState(false);
  const [storyNameMap, setStoryNameMap] = useState<Record<string, string>>({});
  const c = useColors();
  const pid = profileManager.getActiveProfile()?.id ?? 1;

  // v4.32.193 (Round-23 #9): alive flag — reload is invoked on every story
  // subscribe update; if the row unmounts mid-reload the setState×3 writes
  // on a dead component. subscribeStoryUpdates cleanup doesn't abort
  // in-flight reload.
  const aliveRef = useRef(true);

  const reload = useCallback(async () => {
    await deleteExpiredStories();
    if (!aliveRef.current) return;
    const [allStories, contacts] = await Promise.all([
      listActiveStories(pid),
      listContacts(),
    ]);
    if (!aliveRef.current) return;
    const nameMap = new Map<string, string>(contacts.map((c) => [c.peerPublicKey, c.displayName ?? '']));
    nameMap.set(myPubB64, 'Я');
    setStoryNameMap(Object.fromEntries(nameMap));

    // Group by author
    const byAuthor = new Map<string, StoryRow[]>();
    for (const s of allStories) {
      const list = byAuthor.get(s.authorPubB64) ?? [];
      list.push(s);
      byAuthor.set(s.authorPubB64, list);
    }

    const result: StoryGroup[] = [];
    // Own story first
    if (byAuthor.has(myPubB64)) {
      const own = byAuthor.get(myPubB64)!;
      result.push({ authorPubB64: myPubB64, stories: own, hasUnread: false, displayName: 'Я' });
    }
    // Others
    for (const [pub, stories] of byAuthor.entries()) {
      if (pub === myPubB64) continue;
      // v4.32.590: неизвестный список посмотревших больше не зажигает кружок
      // навсегда — погасить его было нечем, писать в непрочитанный столбец
      // нельзя.
      const hasUnread = storyRingUnread(
        parseViewerList(stories[0].viewedBy, stories[0].viewedUnreadable),
        myPubB64,
      );
      result.push({
        authorPubB64: pub,
        stories,
        hasUnread,
        displayName: nameMap.get(pub) ?? shortIdentity(pub),
      });
    }
    if (!aliveRef.current) return;
    setGroups(result);
  }, [pid, myPubB64]);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => { aliveRef.current = false; };
  }, [reload, refreshTick]);

  // Live refresh when any story is published or received.
  // v4.32.49: явная форма — subscribeStoryUpdates возвращает unsubscribe,
  // храним в переменной и возвращаем из effect'а как cleanup. Старая форма
  // `useEffect(() => subscribe(...))` (implicit return) работала, но легко
  // сломать добавлением `{}` в будущем — тогда listener останется навсегда.
  useEffect(() => {
    const unsub = subscribeStoryUpdates(() => void reload());
    return unsub;
  }, [reload]);

  // v4.32.691: тип сторис больше не спрашивается заранее.
  //
  // Раньше здесь стоял системный Alert.alert со списком «Текст / Фото /
  // Видео», и выбрать приходилось вслепую — до того, как человек увидел хоть
  // один экран. Теперь открывается один редактор, а тип переключается внутри
  // него: набранный текст при переключении не теряется, и передумать можно не
  // выходя. Заодно ушёл чужой системный лист поверх приложения — редактор
  // сделан на нашем стекле и в нашей теме.
  const createStory = useCallback(() => { setComposerVisible(true); }, []);

  // v4.32.49: inflight-ref защищает от double-publish при быстром double-tap
  // на кнопку "Опубликовать". setComposerUri(null) асинхронный → вторая
  // invocation успевает попасть в publishFromComposer до unmount композера
  // и закрытие via closure видит старое значение composerUri. Ref проверяется
  // синхронно и блокирует второй вызов.
  const publishingRef = useRef(false);

  const publishDraft = useCallback(async (draft: StoryDraft) => {
    if (publishingRef.current) return;
    publishingRef.current = true;
    setComposerVisible(false);
    try {
      if (pair) {
        // Текстовая сторис (uri === null) рассылается тем же личным
        // сообщением, что и медийная, — и без транспорта её так же не увидит
        // никто. Поэтому проверка результата одна на оба случая.
        const res = await publishStory(pair, draft.uri, draft.text, draft.mediaType);
        // Без этого автор видел бы свою сторис с видео (локальный файл), а у
        // контактов она была бы пустой — и он бы об этом не узнал.
        const problem = storyPublishProblem(res, draft.mediaType);
        if (problem) showError(problem);
      }
    } catch (e) {
      showError(userErrorText(e, 'Не удалось опубликовать историю'));
    } finally {
      publishingRef.current = false;
    }
    await reload();
  }, [pair, reload]);

  // Always show "add my story" button
  const hasMyStory = groups.some((g) => g.authorPubB64 === myPubB64);

  if (groups.length === 0 && !hasMyStory) {
    // Show just the add button
    return (
      <>
        <View style={[styles.rowWrap, { borderBottomColor: c.border }]} collapsable={false} testID="stories_row_wrap_empty">
          <View style={{ paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', alignItems: 'center' }}>
            <AppPressable style={sb.wrap} onPress={() => void createStory()}>
              <View style={[sb.ring, { borderColor: c.primary }]}>
                <View style={[sb.avatar, { backgroundColor: c.primary }]}>
                  <Ionicons name="add" size={24} color={primaryInk(c).text} />
                </View>
              </View>
              <Text style={[sb.name, { color: c.textSecondary }]}>Добавить</Text>
            </AppPressable>
          </View>
        </View>
        {composerVisible ? (
          <StoryComposerModal
            onPublish={(draft) => void publishDraft(draft)}
            onCancel={() => setComposerVisible(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      {/* v4.32.39: убрана обёртка-ScrollView. Предыдущие попытки (v4.32.37 wrapper
          View с height:84, v4.32.38 collapsable={false}+testID) не помогали —
          на устройстве horizontal ScrollView всё равно занимал ~293dp вертикали.
          Root cause: horizontal ScrollView как flex-child в column-flex parent без
          явного height на ScrollView style (не contentContainerStyle) и без flexShrink:0
          получает intrinsic height от самого высокого child, умноженного на что-то.
          Решение: заменяем ScrollView на обычный View с flexDirection:'row' — все
          "сторис" (как правило 1-5 штук) помещаются на экран, горизонтальный скролл
          не нужен для такого количества. onLayout логирует реальную высоту. */}
      <View
        style={[styles.rowWrap, { borderBottomColor: c.border }]}
        collapsable={false}
        testID="stories_row_wrap"
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          log.info('ui_stories_row_layout', { width: Math.round(width), height: Math.round(height) });
        }}
      >
        <View style={styles.rowContent}>
          {/* Add button if no own story */}
          {!hasMyStory ? (
            <AppPressable style={sb.wrap} onPress={() => void createStory()}>
              <View style={[sb.ring, { borderColor: c.primary }]}>
                <View style={[sb.avatar, { backgroundColor: c.primary }]}>
                  <Ionicons name="add" size={24} color={primaryInk(c).text} />
                </View>
              </View>
              <Text style={[sb.name, { color: c.textSecondary }]}>Добавить</Text>
            </AppPressable>
          ) : null}
          {groups.map((g) => (
            <StoryBubble
              key={g.authorPubB64}
              group={g}
              isMe={g.authorPubB64 === myPubB64}
              onPress={() => {
                if (g.authorPubB64 === myPubB64 && !hasMyStory) {
                  void createStory();
                } else {
                  setViewerTarget({ stories: g.stories, index: 0 });
                }
              }}
            />
          ))}
        </View>
      </View>
      {viewerTarget ? (
        <StoryViewer
          stories={viewerTarget.stories}
          startIndex={viewerTarget.index}
          myPubB64={myPubB64}
          onClose={() => { setViewerTarget(null); void reload(); }}
          nameMap={storyNameMap}
          pair={pair ?? null}
          ownerProfileId={pid}
          onOpenChatWithPeer={onOpenChatWithPeer}
        />
      ) : null}
      {/* v4.32.626 разошлась с веткой пустого состояния в признаке «это
          видео», и ролик открывался картинкой — чёрный кадр вместо кино.
          С 691-й расходиться нечему: редактор один и признаков у него нет. */}
      {composerVisible ? (
        <StoryComposerModal
          onPublish={(draft) => void publishDraft(draft)}
          onCancel={() => setComposerVisible(false)}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  // v4.32.39: фиксированная высота 84dp, border нижний, overflow:hidden клипает
  // любой оверхед. flexShrink:0 защищает от сжатия, flexGrow:0 — от раздутия.
  rowWrap: { height: 84, borderBottomWidth: 1, overflow: 'hidden', flexShrink: 0, flexGrow: 0 },
  rowContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, gap: 4 },
});
