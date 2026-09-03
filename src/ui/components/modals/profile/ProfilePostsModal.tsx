/**
 * ProfilePostsModal — «Публикации» и «Архив публикаций» в карточке профиля
 * (v4.32.568).
 *
 * «Публикации — т.е. сторис, в принципе можно и стену публикаций»: здесь и то,
 * и другое. Сверху — сторис автора, которые ещё не истекли (они живут сутки),
 * ниже — стена: записи ленты этого же автора, от новых к старым.
 *
 * Важная честность про охват. Лента AirChat не серверная: у каждого лежит
 * только то, что до него доехало. Стена показывает записи автора, дошедшие до
 * ЭТОГО устройства, — не «все его публикации». Поэтому пустая стена — это не
 * «он ничего не публиковал», и подпись под пустым списком говорит именно так.
 *
 * Архив — отдельный режим и только свой: это записи, которые владелец убрал из
 * своей ленты у себя. Чужого архива не существует.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { SafeScreen } from '../../SafeScreen';
import { useTheme } from '../../../ThemeContext';
import { font, radius, spacing } from '../../../theme';
import { listActiveStories, type StoryRow } from '../../../../core/storage/local';
import {
  listArchivedFeedPosts,
  loadFeedPosts,
  resolveFeedMediaUris,
} from '../../../../core/social/feedService';
import type { FeedPostRow } from '../../../../core/storage/feedStorage';
import { shouldApplyRows } from '../../../../core/storage/readResult';
import { loadConfig } from '../../../../core/config';
import { dayMonthShortTime } from '../../../../core/time/ruDateTime';
import { UNREADABLE_MESSAGE_TEXT } from '../../../../core/storage/unreadableText';
import { log } from '../../../../core/logger';
import { rawErrorText } from '../../userErrorText';

/** Сколько записей ленты просматриваем в поисках записей этого автора. */
const SCAN_LIMIT = 400;

export function ProfilePostsModal({
  visible,
  mode,
  authorDid,
  authorPubB64,
  authorName,
  ownerProfileId,
  onClose,
}: {
  visible: boolean;
  /** 'posts' — сторис и стена автора; 'archive' — свой локальный архив. */
  mode: 'posts' | 'archive';
  authorDid: string;
  authorPubB64: string;
  authorName: string;
  ownerProfileId: number;
  onClose: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [posts, setPosts] = useState<FeedPostRow[]>([]);
  const [stories, setStories] = useState<StoryRow[]>([]);
  const [media, setMedia] = useState<Record<string, string[]>>({});
  // Пока не дочитали — это «ещё не знаем», а не «пусто». Разница видна на
  // экране: подпись «Ничего не найдено» появляется только после чтения.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoaded(false);
    setPosts([]);
    setStories([]);
    setMedia({});
    void (async () => {
      try {
        const rows = mode === 'archive'
          ? await listArchivedFeedPosts(SCAN_LIMIT, 0)
          : await loadFeedPosts(SCAN_LIMIT, 0);
        if (cancelled) return;
        // Сбой чтения не должен выглядеть как пустая стена.
        if (!shouldApplyRows(rows)) {
          log.warn('ui_profile_posts_read_failed', { mode });
          return;
        }
        const mine = [...rows].filter((p) => p.authorDid === authorDid);
        if (cancelled) return;
        setPosts(mine);
        setLoaded(true);
        const gw = await loadConfig().then((c) => c.ipfs.gatewayUrl.replace(/\/$/, '')).catch(() => '');
        if (cancelled) return;
        const map = await resolveFeedMediaUris(
          mine.map((p) => ({ id: p.id, mediaCids: p.mediaCids })),
          gw || null,
        );
        if (!cancelled) setMedia(map);
      } catch (e) {
        log.warn('ui_profile_posts_failed', { err: rawErrorText(e) });
      }
    })();
    // Сторис — только в режиме публикаций: в архиве им места нет.
    if (mode === 'posts') {
      void listActiveStories(ownerProfileId)
        .then((rows) => {
          if (!cancelled) setStories(rows.filter((s) => s.authorPubB64 === authorPubB64));
        })
        .catch(() => { /* сторис — не главное на этом экране */ });
    }
    return () => { cancelled = true; };
  }, [visible, mode, authorDid, authorPubB64, ownerProfileId]);

  const title = mode === 'archive' ? 'Архив публикаций' : `Публикации · ${authorName}`;

  const emptyNote = useMemo(() => (
    mode === 'archive'
      ? 'В архиве пусто. Сюда попадают записи, которые вы убрали из своей ленты.'
      : 'Здесь пусто. Лента хранится на устройстве: видно только те записи автора, которые дошли до этого телефона.'
  ), [mode]);

  const renderPost = useCallback((p: FeedPostRow) => {
    const uris = media[p.id] ?? [];
    return (
      <View
        key={p.id}
        style={[styles.post, { borderColor: colors.border, backgroundColor: colors.surface }]}
      >
        <Text style={[styles.postDate, { color: colors.textMuted }]}>
          {dayMonthShortTime(p.timestamp)}
        </Text>
        {p.textUnreadable ? (
          <Text style={[styles.postText, styles.unreadable, { color: colors.textMuted }]}>
            {UNREADABLE_MESSAGE_TEXT}
          </Text>
        ) : p.text ? (
          <Text style={[styles.postText, { color: colors.text }]}>{p.text}</Text>
        ) : null}
        {uris.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbs}>
            {uris.map((u, i) => (
              <Image key={`${p.id}_${i}`} source={{ uri: u }} style={styles.thumb} resizeMode="cover" />
            ))}
          </ScrollView>
        ) : null}
      </View>
    );
  }, [media, colors]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* v4.32.571: safe-area сверху. Без неё шапка со стрелкой «назад» и
          заголовком уезжала под системную строку — часы и батарею, — и нажать
          «назад» на телефоне с вырезом было нечем. Обёртка та же, что у
          полноэкранных модалок контактов (v4.32.42). */}
      <SafeScreen edges={['top', 'left', 'right']} backgroundColor={colors.background} style={styles.container}>
        <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
          <AppPressable style={styles.closeBtn} onPress={onClose} accessibilityLabel="Назад">
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </AppPressable>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {stories.length > 0 ? (
            <View style={styles.storiesBlock}>
              <Text style={[styles.blockLabel, { color: colors.textMuted }]}>
                Сторис · ещё видны {stories.length}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {stories.map((s) => (
                  <View
                    key={s.id}
                    style={[styles.storyTile, { borderColor: colors.border, backgroundColor: colors.surface }]}
                  >
                    {s.mediaUri && !s.mediaUnreadable ? (
                      <Image source={{ uri: s.mediaUri }} style={styles.storyImage} resizeMode="cover" />
                    ) : (
                      <View style={styles.storyImage}>
                        <Ionicons
                          name={s.mediaUnreadable ? 'alert-circle-outline' : 'text-outline'}
                          size={20}
                          color={colors.textMuted}
                        />
                      </View>
                    )}
                    <Text style={[styles.storyCaption, { color: colors.textMuted }]} numberOfLines={1}>
                      {s.textUnreadable ? UNREADABLE_MESSAGE_TEXT : (s.text || dayMonthShortTime(s.createdAt))}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : null}

          {posts.length > 0 ? (
            posts.map(renderPost)
          ) : loaded && stories.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="albums-outline" size={44} color={colors.textMuted} />
              <Text style={[styles.emptyText, { color: colors.textMuted }]}>{emptyNote}</Text>
            </View>
          ) : null}
        </ScrollView>
      </SafeScreen>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
  },
  closeBtn: { padding: spacing.xs },
  title: { fontSize: font.lg, fontWeight: '600', flex: 1 },
  body: { padding: spacing.md, gap: spacing.md },
  storiesBlock: { gap: spacing.xs },
  blockLabel: { fontSize: font.xs, textTransform: 'uppercase', letterSpacing: 0.5 },
  storyTile: {
    width: 92,
    marginRight: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  storyImage: { width: '100%', height: 120, alignItems: 'center', justifyContent: 'center' },
  storyCaption: { fontSize: font.xs, padding: spacing.xs },
  post: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.xs,
  },
  postDate: { fontSize: font.xs },
  postText: { fontSize: font.md },
  unreadable: { fontStyle: 'italic' },
  thumbs: { marginTop: spacing.xs },
  thumb: { width: 120, height: 120, borderRadius: radius.md, marginRight: spacing.xs },
  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  emptyText: { fontSize: font.sm, textAlign: 'center' },
});

export default ProfilePostsModal;
