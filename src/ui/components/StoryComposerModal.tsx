/**
 * StoryComposerModal — редактор новой сторис.
 *
 * v4.32.691. До этой версии «новая сторис» начиналась с системного
 * Alert.alert со списком «Текст / Фото / Видео», и каждый пункт открывал СВОЙ
 * редактор. Три следствия, и все три видны на экране:
 *
 *   • выбор типа делался ДО того, как человек увидел хоть что-то, и передумать
 *     можно было только через «Отмена» и второй заход;
 *   • набранная подпись пропадала при смене типа — редакторы разные, состояние
 *     у каждого своё;
 *   • системный Alert — это чужой лист поверх приложения: ни стекла, ни темы,
 *     ни акцента, выбранного в настройках.
 *
 * Здесь всё это одна страница: тип переключается снизу капсулой, текст живёт
 * один на все режимы, а выбранные фото и видео сохраняются каждое своё — уход
 * в другой режим и обратно ничего не теряет.
 *
 * Слой остаётся тёмным в любой теме: он лежит поверх кадра, как и
 * просмотрщик сторис (см. комментарий про `darkColors` в StoriesRow). Отсюда
 * `tone="dark"` у стекла и чернила из `mediaScrim`.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from './AppPressable';
import { AppModal as Modal } from './AppModal';
import { GlassSurface } from './GlassSurface';
import { useColors } from '../ThemeContext';
import { showPermissionDeniedAlert } from '../permissionAlert';
import {
  darkColors,
  font,
  inkOn,
  mediaScrim,
  nestedFill,
  primaryInk,
  radius,
  spacing,
  STORY_TEXT_BACKGROUNDS,
  TOUCH_TARGET_MIN,
} from '../theme';

/** Что именно публикуется. `uri === null` — текстовая сторис. */
export type StoryDraft = {
  uri: string | null;
  mediaType: 'image' | 'video';
  text: string | null;
};

type Mode = 'text' | 'photo' | 'video';

const MODES: ReadonlyArray<{ id: Mode; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { id: 'text', label: 'Текст', icon: 'text-outline' },
  { id: 'photo', label: 'Фото', icon: 'image-outline' },
  { id: 'video', label: 'Видео', icon: 'videocam-outline' },
];

/**
 * Предел длины один на все режимы.
 *
 * Раньше их было два — 280 у текстовой сторис и 200 у подписи, — и при
 * переключении режима текст пришлось бы молча обрезать. Общее поле требует
 * общего предела, и он берётся по большему: подпись короче не становится
 * оттого, что ей разрешено больше.
 */
const MAX_STORY_TEXT = 280;

/** Немое зацикленное видео в предпросмотре. Хук живёт в своём компоненте. */
function ComposerVideo({ uri }: { uri: string }): React.ReactElement {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  return <VideoView player={player} style={s.canvas} contentFit="cover" nativeControls={false} />;
}

export function StoryComposerModal({
  onPublish,
  onCancel,
}: {
  onPublish: (draft: StoryDraft) => void;
  onCancel: () => void;
}): React.ReactElement {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [bgIdx, setBgIdx] = useState(0);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  const isText = mode === 'text';
  const mediaUri = mode === 'video' ? videoUri : mode === 'photo' ? photoUri : null;

  // Фон текстовой сторис известен — его только что выбрал автор, — поэтому
  // чернила считаются от него, а не пишутся белым «на глаз» (правило 415-го).
  const textBg = STORY_TEXT_BACKGROUNDS[bgIdx];
  const textInk = inkOn(darkColors, textBg);
  const textPlate = nestedFill(textBg);
  const textPlateInk = inkOn(darkColors, textPlate);
  // Поверх кадра фон неизвестен, и чернила берутся из слоя, а не из палитры.
  const inkMuted = isText ? textInk.secondary : mediaScrim.inkMuted;

  const pick = useCallback(async (kind: 'photo' | 'video') => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      showPermissionDeniedAlert(
        'Галерея',
        kind === 'photo'
          ? 'Чтобы опубликовать сторис с фото, разрешите доступ к галерее.'
          : 'Чтобы опубликовать сторис с видео, разрешите доступ к галерее.'
      );
      return;
    }
    // v4.32.54: quality:1 + exif:false избегает NoSuchMethodError в CompressionImageExporter.
    const result =
      kind === 'photo'
        ? await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [9, 16],
            quality: 1,
            exif: false,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Videos,
            allowsEditing: true,
            aspect: [9, 16],
            videoMaxDuration: 30,
          });
    if (result.canceled || !result.assets[0]) return;
    if (kind === 'photo') setPhotoUri(result.assets[0].uri);
    else setVideoUri(result.assets[0].uri);
  }, []);

  const trimmed = text.trim();
  const ready = isText ? trimmed.length > 0 : mediaUri !== null;

  const publish = useCallback(() => {
    if (isText) {
      if (!trimmed) return;
      onPublish({ uri: null, mediaType: 'image', text: trimmed });
      return;
    }
    if (!mediaUri) return;
    onPublish({ uri: mediaUri, mediaType: mode === 'video' ? 'video' : 'image', text: trimmed || null });
  }, [isText, trimmed, mediaUri, mode, onPublish]);

  // v4.32.27: на Android behavior=undefined (no-op) — чтобы не конкурировать с
  // native adjustResize из манифеста: две параллельные анимации заставляли
  // предпросмотр и подпись скакать в каждом кадре при показе клавиатуры.
  const behavior = Platform.OS === 'ios' ? 'padding' : undefined;

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onCancel} presentationStyle="overFullScreen">
      <KeyboardAvoidingView style={s.root} behavior={behavior}>
        <View style={[s.root, { backgroundColor: isText ? textBg : mediaScrim.fill }]}>
          {/* Холст */}
          {isText ? (
            <TextInput
              ref={inputRef}
              style={[s.textCanvas, { color: textInk.text, marginTop: insets.top + TEXT_CANVAS_OFFSET }]}
              value={text}
              onChangeText={setText}
              placeholder="Введите текст…"
              placeholderTextColor={textInk.secondary}
              multiline
              maxLength={MAX_STORY_TEXT}
              returnKeyType="default"
            />
          ) : mediaUri ? (
            mode === 'video' ? (
              <ComposerVideo uri={mediaUri} />
            ) : (
              <Image source={{ uri: mediaUri }} style={s.canvas} resizeMode="cover" />
            )
          ) : (
            <View style={s.emptyWrap}>
              <GlassSurface tone="dark" variant="prominent" style={s.emptyCard}>
                <Ionicons
                  name={mode === 'video' ? 'videocam-outline' : 'image-outline'}
                  size={38}
                  color={mediaScrim.ink}
                />
                <Text style={[s.emptyTitle, { color: mediaScrim.ink }]}>
                  {mode === 'video' ? 'Видео для сторис' : 'Фото для сторис'}
                </Text>
                <Text style={[s.emptyHint, { color: mediaScrim.inkMuted }]}>
                  {mode === 'video' ? 'До 30 секунд, вертикальное' : 'Лучше вертикальное, 9:16'}
                </Text>
                <AppPressable
                  style={[s.pickBtn, { backgroundColor: c.primary }]}
                  onPress={() => void pick(mode === 'video' ? 'video' : 'photo')}
                >
                  <Text style={[s.pickText, { color: primaryInk(c).text }]}>Выбрать из галереи</Text>
                </AppPressable>
              </GlassSurface>
            </View>
          )}

          {/* Шапка */}
          <View style={[s.header, { top: insets.top + spacing.sm }]}>
            <AppPressable onPress={onCancel} hitSlop={16}>
              <GlassSurface tone="dark" variant="prominent" style={[s.iconPlate, isText ? { backgroundColor: textPlate } : null]}>
                <Ionicons name="close" size={24} color={isText ? textPlateInk.text : mediaScrim.ink} />
              </GlassSurface>
            </AppPressable>
            <GlassSurface tone="dark" variant="prominent" style={[s.titlePlate, isText ? { backgroundColor: textPlate } : null]}>
              <Text style={[s.title, { color: isText ? textPlateInk.text : mediaScrim.ink }]}>Новая сторис</Text>
            </GlassSurface>
            <AppPressable
              style={[s.publishBtn, { backgroundColor: c.primary, opacity: ready ? 1 : DIM_DISABLED }]}
              disabled={!ready}
              accessibilityState={{ disabled: !ready }}
              onPress={publish}
            >
              <Text style={[s.publishText, { color: primaryInk(c).text }]}>Опубликовать</Text>
            </AppPressable>
          </View>

          {/* Нижний блок: подпись/палитра, затем переключатель режимов */}
          <View style={[s.bottom, { paddingBottom: insets.bottom + spacing.md }]}>
            {isText ? (
              <View style={s.swatches}>
                {STORY_TEXT_BACKGROUNDS.map((color, i) => (
                  <AppPressable
                    key={color}
                    accessibilityLabel={`Фон ${i + 1}`}
                    onPress={() => setBgIdx(i)}
                    style={[
                      s.swatch,
                      { backgroundColor: color, borderColor: textInk.text, borderWidth: i === bgIdx ? 3 : 1 },
                    ]}
                  />
                ))}
              </View>
            ) : mediaUri ? (
              <>
                <GlassSurface tone="dark" variant="prominent" style={s.captionWrap}>
                  <TextInput
                    style={[s.captionInput, { color: mediaScrim.ink }]}
                    placeholder="Добавить подпись…"
                    placeholderTextColor={mediaScrim.inkMuted}
                    value={text}
                    onChangeText={setText}
                    multiline
                    maxLength={MAX_STORY_TEXT}
                    returnKeyType="done"
                  />
                </GlassSurface>
                <AppPressable
                  style={s.replaceRow}
                  onPress={() => void pick(mode === 'video' ? 'video' : 'photo')}
                >
                  <Ionicons name="swap-horizontal-outline" size={16} color={mediaScrim.inkMuted} />
                  <Text style={[s.replaceText, { color: mediaScrim.inkMuted }]}>Заменить</Text>
                </AppPressable>
              </>
            ) : null}

            <GlassSurface tone="dark" variant="prominent" style={s.switcher}>
              {MODES.map((m) => {
                const active = m.id === mode;
                return (
                  <AppPressable
                    key={m.id}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={m.label}
                    onPress={() => setMode(m.id)}
                    style={[s.tab, active ? { backgroundColor: c.primary } : null]}
                  >
                    <Ionicons name={m.icon} size={16} color={active ? primaryInk(c).text : inkMuted} />
                    <Text style={[s.tabText, { color: active ? primaryInk(c).text : inkMuted }]}>{m.label}</Text>
                  </AppPressable>
                );
              })}
            </GlassSurface>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * Отступ поля от верхнего края.
 *
 * v4.32.27: позиция крепится к верху экрана, а не считается от высоты
 * контейнера. При flex-центрировании внутри KeyboardAvoidingView текст
 * пересчитывал позицию в каждом кадре анимации клавиатуры и «бегал».
 */
const TEXT_CANVAS_OFFSET = 120;
/** Непрозрачность недоступной кнопки — из правил Material (0.38–0.5). */
const DIM_DISABLED = 0.45;

const s = StyleSheet.create({
  root: { flex: 1 },
  canvas: { ...StyleSheet.absoluteFillObject },
  textCanvas: {
    fontSize: font.xxl,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 34,
    width: '100%',
    minHeight: 80,
    paddingHorizontal: spacing.xl,
  },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyCard: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.lg,
    width: '100%',
  },
  emptyTitle: { fontSize: font.lg, fontWeight: '700' },
  emptyHint: { fontSize: font.sm },
  pickBtn: {
    marginTop: spacing.sm,
    minHeight: TOUCH_TARGET_MIN,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    borderRadius: radius.full,
  },
  pickText: { fontSize: font.md, fontWeight: '700' },
  header: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  iconPlate: {
    width: TOUCH_TARGET_MIN,
    height: TOUCH_TARGET_MIN,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titlePlate: { borderRadius: radius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  title: { fontSize: font.lg, fontWeight: '600' },
  publishBtn: {
    minHeight: TOUCH_TARGET_MIN,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
  },
  publishText: { fontSize: font.sm, fontWeight: '700' },
  bottom: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: 0, gap: spacing.sm },
  swatches: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  swatch: { width: 30, height: 30, borderRadius: radius.full },
  captionWrap: { borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  captionInput: { fontSize: font.md, minHeight: TOUCH_TARGET_MIN, maxHeight: 120 },
  replaceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, minHeight: TOUCH_TARGET_MIN },
  replaceText: { fontSize: font.sm, fontWeight: '600' },
  switcher: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: spacing.xs,
    padding: spacing.xs,
    borderRadius: radius.full,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: TOUCH_TARGET_MIN,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
  },
  tabText: { fontSize: font.sm, fontWeight: '700' },
});
