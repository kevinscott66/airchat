/**
 * ProfilePostsModal — «Стена», «Истории» и «Архив публикаций» в карточке
 * профиля (v4.32.568, разделены — 575, альбомы историй — 576).
 *
 * Сначала это был один раздел «Публикации», где сторис лежали полосой над
 * стеной. Разделов стало три, потому что это три разных вопроса: «что человек
 * писал» (стена — записи ленты, от новых к старым), «что у него сейчас» (
 * истории живут сутки и смотрятся плитками) и «что я у себя убрал» (архив).
 * Общего у них — только автор.
 *
 * Важная честность про охват. Лента AirChat не серверная: у каждого лежит
 * только то, что до него доехало. Стена показывает записи автора, дошедшие до
 * ЭТОГО устройства, — не «все его публикации». Поэтому пустая стена — это не
 * «он ничего не публиковал», и подпись под пустым списком говорит именно так.
 *
 * Архив — отдельный режим и только свой: это записи, которые владелец убрал из
 * своей ленты у себя. Чужого архива не существует.
 *
 * Альбомы (576). История живёт сутки и уходит вместе со снимком — это её
 * обещание, и менять его альбом не должен. Поэтому альбом не ссылается на
 * историю, а хранит СВОЮ копию снимка в каталоге документов: истёкшая история
 * исчезнет, а плитка в альбоме останется.
 *
 * Альбомы — свои и только на этом телефоне. Полосу альбомов видит владелец
 * профиля; в чужом профиле её нет — не потому что «пока не сделали», а потому
 * что альбом никуда не передаётся: истории раздаются в момент публикации и
 * через сутки истекают, канала «покажи собеседнику свой альбом» в протоколе
 * нет. Обещать его плашкой в чужом профиле было бы враньём.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { ActionSheet, type ActionSheetState } from '../../ActionSheet';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { SafeScreen } from '../../SafeScreen';
import { useTheme } from '../../../ThemeContext';
import { font, radius, spacing } from '../../../theme';
import {
  listActiveStories,
  listStoryAlbumItems,
  listStoryAlbums,
  renameStoryAlbum,
  type StoryAlbumItemRow,
  type StoryAlbumRow,
  type StoryRow,
} from '../../../../core/storage/local';
import {
  addStoryToAlbum,
  createStoryAlbum,
  removeStoryAlbum,
  removeStoryFromAlbum,
} from '../../../../core/social/storyAlbums';
import { storyAlbumUriFromName } from '../../../../core/media/storyAlbumFiles';
import { ALBUM_TITLE_MAX, albumCountLabel, albumTitleProblem } from '../../storyAlbumsModel';
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

/** Что сейчас набирают в строке названия: новый альбом или переименование. */
type AlbumDraft =
  | null
  /** `story` — история, которую положат в альбом сразу после его создания. */
  | { kind: 'create'; story: StoryRow | null }
  | { kind: 'rename'; id: string };

export function ProfilePostsModal({
  visible,
  mode,
  isSelf,
  authorDid,
  authorPubB64,
  authorName,
  ownerProfileId,
  onClose,
}: {
  visible: boolean;
  /** 'wall' — записи автора; 'stories' — его истории; 'archive' — свой архив. */
  mode: 'wall' | 'stories' | 'archive';
  /** Свой ли это профиль. Полоса альбомов есть только у своего. */
  isSelf: boolean;
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
  const [albums, setAlbums] = useState<StoryAlbumRow[]>([]);
  /** `null` — открыты живые истории, иначе id открытого альбома. */
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [items, setItems] = useState<StoryAlbumItemRow[]>([]);
  const [sheet, setSheet] = useState<ActionSheetState>(null);
  const [draft, setDraft] = useState<AlbumDraft>(null);
  const [draftText, setDraftText] = useState('');
  // Итог действия словами. Альбом — тихая операция без экрана результата, и
  // без строки человек не отличает «положили» от «не вышло».
  const [note, setNote] = useState<string | null>(null);

  const albumsShown = mode === 'stories' && isSelf;

  const reloadAlbums = useCallback(async () => {
    try {
      setAlbums(await listStoryAlbums(ownerProfileId));
    } catch (e) {
      log.warn('ui_story_albums_failed', { err: rawErrorText(e) });
    }
  }, [ownerProfileId]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoaded(false);
    setPosts([]);
    setStories([]);
    setMedia({});
    setAlbumId(null);
    setItems([]);
    setDraft(null);
    setNote(null);
    // Истории не листают ленту: их раздел про сутки, а не про историю записей.
    if (mode !== 'stories') void (async () => {
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
    // Сторис читаются только в своём разделе: ни на стене, ни в архиве им
    // места нет.
    if (mode === 'stories') {
      void listActiveStories(ownerProfileId)
        .then((rows) => {
          if (cancelled) return;
          setStories(rows.filter((s) => s.authorPubB64 === authorPubB64));
          // «Пусто» пишется только после чтения — до него это «ещё не знаем».
          setLoaded(true);
        })
        .catch(() => { /* сбой чтения — не «историй нет»: подпись не появится */ });
    }
    if (albumsShown) void reloadAlbums();
    return () => { cancelled = true; };
  }, [visible, mode, authorDid, authorPubB64, ownerProfileId, albumsShown, reloadAlbums]);

  // Содержимое открытого альбома. Читается отдельно от полосы: в полосе
  // хватает счётчика и обложки, а строки нужны только раскрытому альбому.
  useEffect(() => {
    if (!visible || albumId === null) { setItems([]); return; }
    let cancelled = false;
    void listStoryAlbumItems(albumId, ownerProfileId)
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((e) => log.warn('ui_story_album_items_failed', { err: rawErrorText(e) }));
    return () => { cancelled = true; };
  }, [visible, albumId, ownerProfileId]);

  const openAlbum = albums.find((a) => a.id === albumId) ?? null;

  const refreshOpenAlbum = useCallback(async (id: string) => {
    try {
      setItems(await listStoryAlbumItems(id, ownerProfileId));
    } catch (e) {
      log.warn('ui_story_album_items_failed', { err: rawErrorText(e) });
    }
  }, [ownerProfileId]);

  const putIntoAlbum = useCallback(async (id: string, story: StoryRow) => {
    const r = await addStoryToAlbum(id, story, ownerProfileId).catch((e) => {
      log.warn('ui_story_album_add_failed', { err: rawErrorText(e) });
      return 'copy-failed' as const;
    });
    setNote(
      r === 'ok' ? 'История в альбоме.'
        : r === 'duplicate' ? 'Эта история уже в альбоме.'
        : r === 'no-media' ? 'У этой истории нет снимка — в альбом её не положить.'
        : 'Копию сохранить не удалось: истории в альбоме нет.'
    );
    if (r === 'ok') {
      await reloadAlbums();
      if (albumId === id) await refreshOpenAlbum(id);
    }
  }, [ownerProfileId, reloadAlbums, albumId, refreshOpenAlbum]);

  const startDraft = useCallback((d: AlbumDraft, initial: string) => {
    setDraft(d);
    setDraftText(initial);
    setNote(null);
  }, []);

  const onStoryPress = useCallback((s: StoryRow) => {
    if (!albumsShown) return;
    setSheet({
      title: 'В альбом',
      message: 'Альбом хранит копию снимка: история истечёт через сутки, плитка останется.',
      options: [
        ...albums.map((a) => ({
          label: a.titleUnreadable ? UNREADABLE_MESSAGE_TEXT : (a.title || 'Без названия'),
          onPress: () => void putIntoAlbum(a.id, s),
        })),
        { label: 'Новый альбом…', onPress: () => startDraft({ kind: 'create', story: s }, '') },
      ],
    });
  }, [albumsShown, albums, putIntoAlbum, startDraft]);

  const onItemPress = useCallback((it: StoryAlbumItemRow) => {
    setSheet({
      title: it.textUnreadable ? UNREADABLE_MESSAGE_TEXT : (it.text || dayMonthShortTime(it.createdAt)),
      options: [{
        label: 'Убрать из альбома',
        destructive: true,
        onPress: () => void (async () => {
          await removeStoryFromAlbum(it, ownerProfileId).catch((e) =>
            log.warn('ui_story_album_remove_failed', { err: rawErrorText(e) }));
          await reloadAlbums();
          await refreshOpenAlbum(it.albumId);
          setNote('История убрана из альбома вместе с копией снимка.');
        })(),
      }],
    });
  }, [ownerProfileId, reloadAlbums, refreshOpenAlbum]);

  const onAlbumMenu = useCallback((a: StoryAlbumRow) => {
    setSheet({
      title: a.titleUnreadable ? UNREADABLE_MESSAGE_TEXT : (a.title || 'Без названия'),
      options: [
        { label: 'Переименовать', onPress: () => startDraft({ kind: 'rename', id: a.id }, a.title) },
        {
          label: 'Удалить альбом',
          destructive: true,
          // Копии снимков уходят вместе с альбомом: другого места, где на них
          // есть ссылка, нет, и оставшись, они лежали бы мёртвым грузом.
          onPress: () => void (async () => {
            await removeStoryAlbum(a.id, ownerProfileId).catch((e) =>
              log.warn('ui_story_album_delete_failed', { err: rawErrorText(e) }));
            setAlbumId(null);
            await reloadAlbums();
            setNote('Альбом удалён вместе с копиями снимков.');
          })(),
        },
      ],
    });
  }, [ownerProfileId, reloadAlbums, startDraft]);

  // Названия, с которыми сверяется набранное. При переименовании своё
  // прежнее имя не считается занятым — иначе альбом нельзя было бы
  // переименовать, поправив в нём одну букву.
  const takenTitles = useMemo(
    () => albums.filter((a) => !(draft?.kind === 'rename' && a.id === draft.id)).map((a) => a.title),
    [albums, draft]
  );
  const draftProblem = draft ? albumTitleProblem(draftText, takenTitles) : null;

  const submitDraft = useCallback(() => {
    if (!draft || draftProblem) return;
    const d = draft;
    const text = draftText;
    setDraft(null);
    void (async () => {
      try {
        if (d.kind === 'rename') {
          await renameStoryAlbum(d.id, text.trim(), ownerProfileId);
          await reloadAlbums();
          setNote('Альбом переименован.');
          return;
        }
        const id = await createStoryAlbum(text.trim(), ownerProfileId);
        await reloadAlbums();
        if (d.story) await putIntoAlbum(id, d.story);
        else setNote('Альбом создан. Нажмите на историю, чтобы положить её сюда.');
      } catch (e) {
        log.warn('ui_story_album_save_failed', { err: rawErrorText(e) });
        setNote('Не вышло сохранить альбом.');
      }
    })();
  }, [draft, draftProblem, draftText, ownerProfileId, reloadAlbums, putIntoAlbum]);

  const title = mode === 'archive'
    ? 'Архив публикаций'
    : `${mode === 'stories' ? 'Истории' : 'Стена'} · ${authorName}`;

  const emptyNote = useMemo(() => {
    if (mode === 'archive') {
      return 'В архиве пусто. Сюда попадают записи, которые вы убрали из своей ленты.';
    }
    if (mode === 'stories') {
      return 'Историй нет. Они живут сутки, и видно только те, что дошли до этого телефона.';
    }
    return 'Здесь пусто. Лента хранится на устройстве: видно только те записи автора, которые дошли до этого телефона.';
  }, [mode]);

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

  /** Плитка: снимок или значок-заглушка и подпись под ним. */
  const renderTile = (
    key: string,
    uri: string | null,
    unreadable: boolean,
    caption: string,
    onPress: () => void,
  ) => (
    <AppPressable
      key={key}
      style={[styles.storyTile, { borderColor: colors.border, backgroundColor: colors.surface }]}
      onPress={onPress}
      accessibilityLabel={caption}
    >
      {uri && !unreadable ? (
        <Image source={{ uri }} style={styles.storyImage} resizeMode="cover" />
      ) : (
        <View style={styles.storyImage}>
          <Ionicons
            name={unreadable ? 'alert-circle-outline' : 'text-outline'}
            size={20}
            color={colors.textMuted}
          />
        </View>
      )}
      <Text style={[styles.storyCaption, { color: colors.textMuted }]} numberOfLines={1}>
        {caption}
      </Text>
    </AppPressable>
  );

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
          {albumsShown ? (
            <>
              {/* Полоса вбок: альбомов бывает много, а сетка из них отняла бы
                  весь экран у того, ради чего сюда зашли, — у самих историй. */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.albumStrip}
              >
                <AppPressable
                  style={[
                    styles.chip,
                    { borderColor: colors.border },
                    albumId === null ? { backgroundColor: colors.primary } : null,
                  ]}
                  onPress={() => setAlbumId(null)}
                  accessibilityLabel="Все истории"
                >
                  <Text style={[styles.chipText, { color: albumId === null ? colors.background : colors.text }]}>
                    Все истории
                  </Text>
                </AppPressable>
                {albums.map((a) => {
                  const active = a.id === albumId;
                  return (
                    <AppPressable
                      key={a.id}
                      style={[
                        styles.chip,
                        { borderColor: colors.border },
                        active ? { backgroundColor: colors.primary } : null,
                      ]}
                      // Открытый альбом второй раз — это меню: отдельной
                      // кнопки «⋯» на плашке не хватило бы места.
                      onPress={() => (active ? onAlbumMenu(a) : setAlbumId(a.id))}
                      accessibilityLabel={`Альбом ${a.title || 'без названия'}`}
                    >
                      <Text
                        style={[styles.chipText, { color: active ? colors.background : colors.text }]}
                        numberOfLines={1}
                      >
                        {a.titleUnreadable ? UNREADABLE_MESSAGE_TEXT : (a.title || 'Без названия')}
                      </Text>
                      <Text
                        style={[styles.chipCount, { color: active ? colors.background : colors.textMuted }]}
                      >
                        {a.count}
                      </Text>
                    </AppPressable>
                  );
                })}
                <AppPressable
                  style={[styles.chip, { borderColor: colors.border }]}
                  onPress={() => startDraft({ kind: 'create', story: null }, '')}
                  accessibilityLabel="Новый альбом"
                >
                  <Ionicons name="add" size={16} color={colors.text} />
                  <Text style={[styles.chipText, { color: colors.text }]}>Альбом</Text>
                </AppPressable>
              </ScrollView>

              {draft ? (
                <View style={[styles.draft, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                  <TextInput
                    style={[styles.input, { color: colors.text, borderColor: colors.border }]}
                    value={draftText}
                    onChangeText={setDraftText}
                    placeholder="Название альбома"
                    placeholderTextColor={colors.textMuted}
                    maxLength={ALBUM_TITLE_MAX}
                    autoFocus
                    testID="story_album_title"
                  />
                  {draftProblem ? (
                    <Text style={[styles.draftProblem, { color: colors.textMuted }]}>{draftProblem}</Text>
                  ) : null}
                  <View style={styles.draftRow}>
                    <AppPressable
                      style={styles.draftBtn}
                      onPress={() => setDraft(null)}
                      accessibilityLabel="Отмена"
                    >
                      <Text style={[styles.draftBtnText, { color: colors.textMuted }]}>Отмена</Text>
                    </AppPressable>
                    <AppPressable
                      style={styles.draftBtn}
                      onPress={submitDraft}
                      disabled={draftProblem !== null}
                      accessibilityLabel="Сохранить альбом"
                    >
                      <Text
                        style={[
                          styles.draftBtnText,
                          { color: draftProblem ? colors.textMuted : colors.primary },
                        ]}
                      >
                        {draft.kind === 'rename' ? 'Переименовать' : 'Создать'}
                      </Text>
                    </AppPressable>
                  </View>
                </View>
              ) : null}

              {note ? (
                <Text style={[styles.note, { color: colors.textMuted }]}>{note}</Text>
              ) : null}
            </>
          ) : null}

          {openAlbum ? (
            <View style={styles.storiesBlock}>
              <Text style={[styles.blockLabel, { color: colors.textMuted }]}>
                {albumCountLabel(items.length)}
              </Text>
              <View style={styles.storiesGrid}>
                {items.map((it) => renderTile(
                  it.id,
                  it.mediaFile ? storyAlbumUriFromName(it.mediaFile) : null,
                  !!it.mediaUnreadable,
                  it.textUnreadable ? UNREADABLE_MESSAGE_TEXT : (it.text || dayMonthShortTime(it.createdAt)),
                  () => onItemPress(it),
                ))}
              </View>
              {items.length === 0 ? (
                <Text style={[styles.emptyText, { color: colors.textMuted }]}>
                  Альбом пуст. Откройте «Все истории» и нажмите на ту, что хотите оставить.
                </Text>
              ) : null}
            </View>
          ) : stories.length > 0 ? (
            <View style={styles.storiesBlock}>
              <Text style={[styles.blockLabel, { color: colors.textMuted }]}>
                Ещё видны · {stories.length}
              </Text>
              {/* Плитками в сетку, а не полосой вбок: раздел теперь только про
                  истории, и прятать половину из них за краем экрана незачем. */}
              <View style={styles.storiesGrid}>
                {stories.map((s) => renderTile(
                  s.id,
                  s.mediaUri,
                  !!s.mediaUnreadable,
                  s.textUnreadable ? UNREADABLE_MESSAGE_TEXT : (s.text || dayMonthShortTime(s.createdAt)),
                  () => onStoryPress(s),
                ))}
              </View>
            </View>
          ) : null}

          {posts.length > 0 ? (
            posts.map(renderPost)
          ) : loaded && stories.length === 0 && openAlbum === null ? (
            <View style={styles.empty}>
              <Ionicons
                name={mode === 'stories' ? 'aperture-outline' : 'albums-outline'}
                size={44}
                color={colors.textMuted}
              />
              <Text style={[styles.emptyText, { color: colors.textMuted }]}>{emptyNote}</Text>
            </View>
          ) : null}
        </ScrollView>
        <ActionSheet state={sheet} onClose={() => setSheet(null)} />
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
  albumStrip: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingRight: spacing.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    maxWidth: 200,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontSize: font.sm, flexShrink: 1 },
  chipCount: { fontSize: font.xs },
  draft: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: font.md,
  },
  draftProblem: { fontSize: font.xs },
  draftRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
  draftBtn: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  draftBtnText: { fontSize: font.sm, fontWeight: '600' },
  note: { fontSize: font.sm },
  storiesBlock: { gap: spacing.xs },
  storiesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  blockLabel: { fontSize: font.xs, textTransform: 'uppercase', letterSpacing: 0.5 },
  storyTile: {
    width: 92,
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
