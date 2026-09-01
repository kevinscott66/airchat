// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: Telegram-style attach-hub с 8 вкладками (Галерея / Камера / Файл /
//          Геопозиция / GIF / Опрос / Ответ / Контакт). Заменяет старый
//          Alert.alert('Вложение', ...) в ChatScreen/GroupsScreen/MessageComposer.
//          Любое изменение структуры Props ломает 3 composer-call-sites.
//
// v4.32.60 — первая версия. Верхний header с X + заголовок активной вкладки.
//           Нижний горизонтальный TabBar со всеми 8 вкладками (скроллится).
//           Вкладка «Галерея» использует expo-media-library для 3-col grid
//           недавних фото/видео; остальные вкладки — shortcut-кнопки или
//           списки из уже существующих БД (quickReplies, contacts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Image, ScrollView, TextInput, Alert, FlatList } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from './AppPressable';
import { AppModal as Modal } from './AppModal';
import { KeyboardHost } from './KeyboardHost';
import { SafeScreen } from './SafeScreen';
import { useThemedStyles, useColors } from '../ThemeContext';
import { badgeTint, contrastingInk, font, mediaScrim, spacing } from '../theme';
import { listQuickReplies, type QuickReply } from '../../core/storage/local';
import { filterTemplates, mayPickTemplate, templateReadable } from '../../core/social/templateSearch';
import { UNREADABLE_TEMPLATE_TEXT } from '../../core/storage/unreadableText';
import { listContacts, type Contact } from '../../core/social/contacts';
import { showPermissionDeniedAlert } from '../permissionAlert';
import { MAX_BLOB_BYTES } from '../../core/media/blobRef';
import { IPFS_DOC_MAX_BYTES, formatLimit, uploadLimitBytes } from '../../core/media/uploadRoute';
import { formatClockDuration } from '../time/durationLabel';
import { nameInitials } from '../../core/social/contactLabel';

export type AttachSheetTab =
  | 'gallery'
  | 'camera'
  | 'file'
  | 'location'
  | 'gif'
  | 'poll'
  | 'reply'
  | 'contact';

export type AttachSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Отправить выбранные из grid «Галерея» assets. До 10 штук. */
  onPickGalleryAssets: (assets: Array<{ uri: string; type: 'image' | 'video' }>) => void;
  /** Системный picker камеры. */
  onOpenCamera: () => void;
  /** Системный picker галереи (fullscreen, с мульти-выбором). */
  onOpenImagePicker: () => void;
  /** Системный picker документов. */
  onOpenDocumentPicker: () => void;
  /** Отправить текущую геолокацию один раз. */
  onSendLocation: () => void;
  /** Начать трансляцию геолокации. durationMin: 15 / 60 / 480. Опционально:
   *  группы/каналы не поддерживают live-session, в этом случае раздел скрыт. */
  onShareLiveLocation?: (durationMin: 15 | 60 | 480) => void;
  /** Открыть GIF-пикер (если allowGif). */
  onOpenGifPicker?: () => void;
  /** Открыть композер опроса (если allowPoll — группы/каналы). */
  onOpenPollComposer?: () => void;
  /** Вставить текст быстрого ответа в TextInput композера. */
  onPickQuickReply: (text: string) => void;
  /** Отправить контакт собеседнику. */
  onShareContact: (contact: Contact) => void;
  /** Профиль-скоуп для quickReplies. */
  profileId: number;
  /** Feature-флаги. */
  allowPoll?: boolean;
  allowGif?: boolean;
  allowContact?: boolean;
};

type TabDef = {
  id: AttachSheetTab;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
};

const ALL_TABS: TabDef[] = [
  { id: 'gallery', label: 'Галерея', icon: 'images-outline' },
  { id: 'camera', label: 'Камера', icon: 'camera-outline' },
  { id: 'file', label: 'Файл', icon: 'document-outline' },
  { id: 'location', label: 'Геопозиция', icon: 'location-outline' },
  { id: 'gif', label: 'GIF', icon: 'film-outline' },
  { id: 'poll', label: 'Опрос', icon: 'bar-chart-outline' },
  { id: 'reply', label: 'Ответ', icon: 'arrow-undo-outline' },
  { id: 'contact', label: 'Контакт', icon: 'person-outline' },
];

const MAX_GALLERY_PICK = 10;
const GALLERY_PAGE_SIZE = 60;

export function AttachSheet(props: AttachSheetProps) {
  const {
    visible,
    onClose,
    onPickGalleryAssets,
    onOpenCamera,
    onOpenImagePicker,
    onOpenDocumentPicker,
    onSendLocation,
    onShareLiveLocation,
    onOpenGifPicker,
    onOpenPollComposer,
    onPickQuickReply,
    onShareContact,
    profileId,
    allowPoll,
    allowGif,
    allowContact,
  } = props;

  const colors = useColors();
  const [activeTab, setActiveTab] = useState<AttachSheetTab>('gallery');

  const visibleTabs = useMemo(() => {
    return ALL_TABS.filter((t) => {
      if (t.id === 'poll' && !allowPoll) return false;
      if (t.id === 'gif' && allowGif === false) return false;
      if (t.id === 'contact' && allowContact === false) return false;
      return true;
    });
  }, [allowPoll, allowGif, allowContact]);

  // Reset to 'gallery' on each open
  useEffect(() => {
    if (visible) setActiveTab('gallery');
  }, [visible]);

  const styles = useThemedStyles((c) => ({
    /* Полноэкранная модалка — нужно место под grid фото */
    screen: {
      flex: 1,
      backgroundColor: c.background,
    },
    /* Header: X + title */
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    closeBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: c.surfaceHigh,
    },
    headerTitle: {
      flex: 1,
      textAlign: 'center' as const,
      fontSize: font.lg,
      fontWeight: '600' as const,
      color: c.text,
    },
    headerSpacer: { width: 40 },
    /* Нижний ряд вкладок — горизонтальный ScrollView
     * ВАЖНО: height + flexShrink: 0 / flexGrow: 0 — иначе на Android
     * горизонтальный ScrollView «раздувается» (как было в StoriesRow v4.32.39).
     * Значение подобрано: icon 20 + marginBottom 2 + label ~12 + paddingVertical 6 = ~52dp.
     */
    tabBarWrap: {
      height: 56,
      flexShrink: 0,
      flexGrow: 0,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    tabBar: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 4,
    },
    tabItem: {
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      paddingHorizontal: 10,
      paddingVertical: 6,
      minWidth: 60,
      borderRadius: 10,
      marginHorizontal: 2,
    },
    tabItemActive: {
      backgroundColor: c.surfaceHigh,
    },
    tabIcon: {
      marginBottom: 2,
    },
    tabLabel: {
      fontSize: font.xs,
      color: c.textMuted,
    },
    tabLabelActive: {
      color: c.accent,
      fontWeight: '600' as const,
    },
    /* Content */
    content: {
      flex: 1,
    },
  }));

  const activeTabDef = visibleTabs.find((t) => t.id === activeTab) ?? visibleTabs[0];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardHost variant="modal">
      <SafeScreen edges={['top', 'bottom']}>
        <View style={styles.screen}>
          {/* Header */}
          <View style={styles.header}>
            <AppPressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.text} />
            </AppPressable>
            <Text style={styles.headerTitle}>{activeTabDef?.label ?? 'Вложение'}</Text>
            <View style={styles.headerSpacer} />
          </View>

          {/* Content — по вкладке */}
          <View style={styles.content}>
            {activeTab === 'gallery' && (
              <GalleryTab
                onSend={(assets) => { onPickGalleryAssets(assets); onClose(); }}
              />
            )}
            {activeTab === 'camera' && (
              <SimpleActionTab
                icon="camera"
                label="Открыть камеру"
                description="Сделать фото или видео прямо сейчас"
                onAction={() => { onOpenCamera(); onClose(); }}
              />
            )}
            {activeTab === 'file' && (
              <FileTab
                onPickFromGallery={() => { onOpenImagePicker(); onClose(); }}
                onPickFromFiles={() => { onOpenDocumentPicker(); onClose(); }}
              />
            )}
            {activeTab === 'location' && (
              <LocationTab
                onSendNow={() => { onSendLocation(); onClose(); }}
                onShareLive={onShareLiveLocation ? ((dur) => { onShareLiveLocation(dur); onClose(); }) : undefined}
              />
            )}
            {activeTab === 'gif' && (
              <SimpleActionTab
                icon="film"
                label="Открыть GIF-пикер"
                description="Поиск и выбор GIF из библиотеки Tenor"
                onAction={() => { onOpenGifPicker?.(); onClose(); }}
              />
            )}
            {activeTab === 'poll' && (
              <SimpleActionTab
                icon="bar-chart"
                label="Создать опрос"
                description="Задать вопрос с вариантами ответа"
                onAction={() => { onOpenPollComposer?.(); onClose(); }}
              />
            )}
            {activeTab === 'reply' && (
              <ReplyTab
                profileId={profileId}
                onPick={(text) => { onPickQuickReply(text); onClose(); }}
              />
            )}
            {activeTab === 'contact' && (
              <ContactTab
                onPick={(c) => { onShareContact(c); onClose(); }}
              />
            )}
          </View>

          {/* TabBar внизу — wrap с фиксированной высотой, чтобы ScrollView не раздувался */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.tabBarWrap}
            contentContainerStyle={styles.tabBar}
          >
            {visibleTabs.map((t) => {
              const isActive = t.id === activeTab;
              return (
                <AppPressable
                  key={t.id}
                  style={[styles.tabItem, isActive && styles.tabItemActive]}
                  onPress={() => setActiveTab(t.id)}
                >
                  <Ionicons
                    name={t.icon}
                    size={20}
                    color={isActive ? colors.accent : colors.textMuted}
                    style={styles.tabIcon}
                  />
                  <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]} numberOfLines={1}>
                    {t.label}
                  </Text>
                </AppPressable>
              );
            })}
          </ScrollView>
        </View>
      </SafeScreen>
      </KeyboardHost>
    </Modal>
  );
}

// ============================================================================
// Tab: Галерея — MediaLibrary 3-col grid
// ============================================================================

function GalleryTab({ onSend }: { onSend: (assets: Array<{ uri: string; type: 'image' | 'video' }>) => void }) {
  const colors = useColors();
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // IB-05: don't re-prompt on every open. Check the already-granted state
        // first; only show the system dialog when we don't yet have access (and
        // the OS still lets us ask). Re-requesting when granted re-triggers the
        // AUDIO + PHOTO/VIDEO dialogs each time the Галерея tab mounts.
        let perm = await MediaLibrary.getPermissionsAsync();
        if (!perm.granted && perm.canAskAgain) {
          perm = await MediaLibrary.requestPermissionsAsync();
        }
        if (!perm.granted) {
          setPermissionDenied(true);
          setLoading(false);
          return;
        }
        const res = await MediaLibrary.getAssetsAsync({
          mediaType: ['photo', 'video'],
          sortBy: [MediaLibrary.SortBy.creationTime],
          first: GALLERY_PAGE_SIZE,
        });
        setAssets(res.assets);
      } catch {
        setPermissionDenied(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggleSelect = useCallback((uri: string) => {
    setSelected((prev) => {
      if (prev.includes(uri)) return prev.filter((u) => u !== uri);
      if (prev.length >= MAX_GALLERY_PICK) {
        Alert.alert('Лимит', `Можно выбрать до ${MAX_GALLERY_PICK} файлов за раз`);
        return prev;
      }
      return [...prev, uri];
    });
  }, []);

  const styles = useThemedStyles((c) => ({
    loadingWrap: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const },
    loadingText: { color: c.textMuted, fontSize: font.sm },
    permWrap: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.lg },
    permTitle: { color: c.text, fontSize: font.md, fontWeight: '600' as const, marginBottom: spacing.sm, textAlign: 'center' as const },
    permText: { color: c.textSecondary, fontSize: font.sm, textAlign: 'center' as const, marginBottom: spacing.md },
    permBtn: { backgroundColor: c.primary, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 20 },
    permBtnText: { color: contrastingInk(c.primary), fontSize: font.sm, fontWeight: '600' as const },
    grid: { padding: 2 },
    cell: {
      width: '33.333%',
      aspectRatio: 1,
      padding: 2,
    },
    cellInner: {
      flex: 1,
      backgroundColor: c.surfaceHigh,
      borderRadius: 2,
      overflow: 'hidden' as const,
      position: 'relative' as const,
    },
    cellImg: { width: '100%', height: '100%' },
    selectDot: {
      position: 'absolute' as const,
      top: 6,
      right: 6,
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: mediaScrim.ink,
      backgroundColor: mediaScrim.bar,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    selectDotActive: {
      backgroundColor: c.primary,
    },
    selectDotText: {
      color: contrastingInk(c.primary),
      fontSize: font.xs,
      fontWeight: '700' as const,
    },
    videoBadge: {
      position: 'absolute' as const,
      bottom: 6,
      left: 6,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: mediaScrim.bar,
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: 4,
    },
    videoBadgeText: {
      color: mediaScrim.ink,
      fontSize: 10,
      marginLeft: 2,
    },
    sendBarWrap: {
      padding: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    sendBtn: {
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center' as const,
    },
    sendBtnText: {
      color: contrastingInk(c.primary),
      fontWeight: '700' as const,
      fontSize: font.md,
    },
  }));

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <Text style={styles.loadingText}>Загрузка галереи…</Text>
      </View>
    );
  }

  if (permissionDenied) {
    return (
      <View style={styles.permWrap}>
        <Ionicons name="images-outline" size={48} color={colors.textMuted} style={{ marginBottom: spacing.md }} />
        <Text style={styles.permTitle}>Нет доступа к галерее</Text>
        <Text style={styles.permText}>
          Разрешите доступ к фото и видео в настройках приложения, чтобы выбирать медиа без открытия системного picker'а.
        </Text>
        <AppPressable
          style={styles.permBtn}
          onPress={() => showPermissionDeniedAlert('галерее', 'Для просмотра фото и видео внутри приложения.')}
        >
          <Text style={styles.permBtnText}>Настройки</Text>
        </AppPressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={assets}
        keyExtractor={(a) => a.id}
        numColumns={3}
        contentContainerStyle={styles.grid}
        renderItem={({ item }) => {
          const isSel = selected.includes(item.uri);
          const selIdx = selected.indexOf(item.uri);
          return (
            <View style={styles.cell}>
              <AppPressable style={styles.cellInner} onPress={() => toggleSelect(item.uri)}>
                <Image source={{ uri: item.uri }} style={styles.cellImg} />
                {item.mediaType === 'video' && (
                  <View style={styles.videoBadge}>
                    <Ionicons name="videocam" size={10} color={mediaScrim.ink} />
                    <Text style={styles.videoBadgeText}>{formatClockDuration((item.duration ?? 0) * 1000)}</Text>
                  </View>
                )}
                <View style={[styles.selectDot, isSel && styles.selectDotActive]}>
                  {isSel && <Text style={styles.selectDotText}>{selIdx + 1}</Text>}
                </View>
              </AppPressable>
            </View>
          );
        }}
      />
      {selected.length > 0 && (
        <View style={styles.sendBarWrap}>
          <AppPressable
            style={styles.sendBtn}
            onPress={() => {
              const out = selected.map((uri) => {
                const a = assets.find((x) => x.uri === uri);
                const type: 'image' | 'video' = a?.mediaType === 'video' ? 'video' : 'image';
                return { uri, type };
              });
              onSend(out);
            }}
          >
            <Text style={styles.sendBtnText}>Отправить ({selected.length})</Text>
          </AppPressable>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// Tab: Camera / GIF / Poll — простая shortcut-кнопка
// ============================================================================

function SimpleActionTab({
  icon,
  label,
  description,
  onAction,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description: string;
  onAction: () => void;
}) {
  const styles = useThemedStyles((c) => ({
    wrap: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.xl },
    circle: {
      width: 96, height: 96, borderRadius: 48,
      backgroundColor: c.primary,
      alignItems: 'center' as const, justifyContent: 'center' as const,
      marginBottom: spacing.lg,
    },
    title: { fontSize: font.lg, fontWeight: '600' as const, color: c.text, marginBottom: spacing.sm, textAlign: 'center' as const },
    desc: { fontSize: font.sm, color: c.textSecondary, textAlign: 'center' as const, marginBottom: spacing.lg },
    btn: { backgroundColor: c.primary, paddingHorizontal: spacing.xl, paddingVertical: 12, borderRadius: 24 },
    // Значок в кружке — на акценте; цвет держится в стилях, потому что здесь
    // нет доступа к палитре вне фабрики (тот же приём, что в 400-м).
    circleInk: { color: contrastingInk(c.primary) },
    btnText: { color: contrastingInk(c.primary), fontSize: font.md, fontWeight: '600' as const },
  }));
  return (
    <View style={styles.wrap}>
      <View style={styles.circle}>
        <Ionicons name={icon} size={48} color={styles.circleInk.color} />
      </View>
      <Text style={styles.title}>{label}</Text>
      <Text style={styles.desc}>{description}</Text>
      <AppPressable style={styles.btn} onPress={onAction}>
        <Text style={styles.btnText}>Открыть</Text>
      </AppPressable>
    </View>
  );
}

// ============================================================================
// Tab: Файл — 2 опции + подсказка
// ============================================================================

function FileTab({
  onPickFromGallery,
  onPickFromFiles,
}: {
  onPickFromGallery: () => void;
  onPickFromFiles: () => void;
}) {
  const colors = useColors();
  // v4.32.422: подпись под кнопками обещала «до 25 MB» — числом, не имеющим
  // отношения ни к одному пределу этого экрана: 25 МБ — потолок ВИДЕО в IPFS,
  // а IPFS на телефоне выключен kill-switch'ем (heliaNode), поэтому документ
  // уезжает вложением с потолком 8 МБ. Пользователь выбирал файл на 20 МБ по
  // приглашению приложения и получал отказ «предел 8 МБ».
  //
  // Теперь подпись считается тем же вызовом, что и сама проверка в ChatScreen,
  // — расходиться нечему. Начальное значение — потолок вложения: на телефоне
  // оно и есть верное, и обещать больше до ответа импорта незачем.
  const [docLimitBytes, setDocLimitBytes] = useState(MAX_BLOB_BYTES);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { isIpfsEnabled } = await import('../../core/transport/ipfs/heliaNode');
      if (!alive) return;
      setDocLimitBytes(
        uploadLimitBytes({ ipfsEnabled: isIpfsEnabled(), ipfsMaxBytes: IPFS_DOC_MAX_BYTES })
      );
    })();
    return () => {
      alive = false;
    };
  }, []);
  const styles = useThemedStyles((c) => ({
    wrap: { flex: 1, padding: spacing.md },
    card: {
      backgroundColor: c.surfaceHigh,
      borderRadius: 14,
      overflow: 'hidden' as const,
      marginBottom: spacing.md,
    },
    row: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
    },
    rowSep: {
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    iconWrap: {
      width: 32, height: 32, borderRadius: 16,
      alignItems: 'center' as const, justifyContent: 'center' as const,
      // v4.32.409: подложка считается от приподнятой карточки, а не от фона.
      backgroundColor: badgeTint(c, 'accent', c.surfaceHigh).fill,
      marginRight: spacing.md,
    },
    rowLabel: { color: c.text, fontSize: font.md, flex: 1 },
    hint: { color: c.textMuted, fontSize: font.xs, marginTop: spacing.sm, textAlign: 'center' as const },
  }));
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <AppPressable style={[styles.row, styles.rowSep]} onPress={onPickFromGallery}>
          <View style={styles.iconWrap}>
            <Ionicons name="image-outline" size={18} color={colors.accent} />
          </View>
          <Text style={styles.rowLabel}>Выбрать из Галереи</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </AppPressable>
        <AppPressable style={styles.row} onPress={onPickFromFiles}>
          <View style={styles.iconWrap}>
            <Ionicons name="cloud-outline" size={18} color={colors.accent} />
          </View>
          <Text style={styles.rowLabel}>Выбрать из файлов</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </AppPressable>
      </View>
      <Text style={styles.hint}>
        Поддерживаются любые типы файлов до {formatLimit(docLimitBytes)}.
      </Text>
    </View>
  );
}

// ============================================================================
// Tab: Геопозиция — кнопки «Отправить» / «Транслировать N мин»
// ============================================================================

function LocationTab({
  onSendNow,
  onShareLive,
}: {
  onSendNow: () => void;
  onShareLive?: (dur: 15 | 60 | 480) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    wrap: { flex: 1, padding: spacing.md },
    card: {
      backgroundColor: c.surfaceHigh,
      borderRadius: 14,
      overflow: 'hidden' as const,
      marginBottom: spacing.md,
    },
    row: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
    },
    rowSep: {
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    iconWrapBlue: {
      width: 40, height: 40, borderRadius: 20,
      alignItems: 'center' as const, justifyContent: 'center' as const,
      backgroundColor: c.primary,
      marginRight: spacing.md,
    },
    iconWrapGreen: {
      width: 40, height: 40, borderRadius: 20,
      alignItems: 'center' as const, justifyContent: 'center' as const,
      backgroundColor: c.success,
      marginRight: spacing.md,
    },
    title: { color: c.text, fontSize: font.md, fontWeight: '600' as const },
    sub: { color: c.textSecondary, fontSize: font.xs, marginTop: 2 },
    textCol: { flex: 1 },
    sectionTitle: {
      color: c.textMuted,
      fontSize: font.xs,
      textTransform: 'uppercase' as const,
      marginTop: spacing.sm,
      marginBottom: spacing.sm,
      marginLeft: spacing.sm,
      letterSpacing: 0.5,
    },
    durRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: spacing.md,
      paddingVertical: 12,
    },
    durLabel: { flex: 1, color: c.text, fontSize: font.md },
  }));
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <AppPressable style={[styles.row, styles.rowSep]} onPress={onSendNow}>
          <View style={styles.iconWrapBlue}>
            <Ionicons name="location" size={20} color={contrastingInk(colors.primary)} />
          </View>
          <View style={styles.textCol}>
            <Text style={styles.title}>Отправить геопозицию</Text>
            <Text style={styles.sub}>Текущие координаты, отправляется один раз</Text>
          </View>
        </AppPressable>
      </View>

      {onShareLive ? (
        <>
          <Text style={styles.sectionTitle}>Транслировать геопозицию</Text>
          <View style={styles.card}>
            <AppPressable style={[styles.durRow, styles.rowSep]} onPress={() => onShareLive(15)}>
              <View style={styles.iconWrapGreen}>
                <Ionicons name="radio" size={18} color={contrastingInk(colors.success)} />
              </View>
              <Text style={styles.durLabel}>15 минут</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </AppPressable>
            <AppPressable style={[styles.durRow, styles.rowSep]} onPress={() => onShareLive(60)}>
              <View style={styles.iconWrapGreen}>
                <Ionicons name="radio" size={18} color={contrastingInk(colors.success)} />
              </View>
              <Text style={styles.durLabel}>1 час</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </AppPressable>
            <AppPressable style={styles.durRow} onPress={() => onShareLive(480)}>
              <View style={styles.iconWrapGreen}>
                <Ionicons name="radio" size={18} color={contrastingInk(colors.success)} />
              </View>
              <Text style={styles.durLabel}>8 часов</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </AppPressable>
          </View>
        </>
      ) : null}
    </View>
  );
}

// ============================================================================
// Tab: Ответ — список quickReplies + поиск
// ============================================================================

function ReplyTab({
  profileId,
  onPick,
}: {
  profileId: number;
  onPick: (text: string) => void;
}) {
  const colors = useColors();
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const list = await listQuickReplies(profileId);
        setReplies(list);
      } finally {
        setLoading(false);
      }
    })();
  }, [profileId]);

  // v4.32.582: отбор через filterTemplates — непрочитанный шаблон остаётся в
  // выдаче с пометкой. Раньше он сравнивался пустой строкой и исчезал, а
  // «ничего не найдено» выдавало незнание за утверждение.
  const filtered = useMemo(() => filterTemplates(replies, q), [replies, q]);

  const styles = useThemedStyles((c) => ({
    wrap: { flex: 1 },
    searchWrap: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.surfaceHigh,
      borderRadius: 20,
      paddingHorizontal: spacing.md,
      margin: spacing.md,
    },
    searchInput: {
      flex: 1,
      color: c.text,
      fontSize: font.md,
      paddingVertical: 10,
      marginLeft: spacing.sm,
    },
    item: {
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    itemText: { color: c.text, fontSize: font.md },
    itemTextUnreadable: { color: c.textMuted, fontSize: font.md, fontStyle: 'italic' as const },
    empty: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.lg },
    emptyText: { color: c.textMuted, fontSize: font.sm, textAlign: 'center' as const },
  }));

  return (
    <View style={styles.wrap}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={q}
          onChangeText={setQ}
          placeholder="Поиск"
          placeholderTextColor={colors.textMuted}
        />
      </View>
      {loading ? (
        <View style={styles.empty}><Text style={styles.emptyText}>Загрузка…</Text></View>
      ) : filtered.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="arrow-undo-outline" size={40} color={colors.textMuted} style={{ marginBottom: spacing.sm }} />
          <Text style={styles.emptyText}>
            {q ? 'Ничего не найдено' : 'Нет быстрых ответов. Создайте их в Настройках → Быстрые ответы.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => {
            // v4.32.582: у непрочитанного шаблона текста нет — вставлять
            // нечего, поэтому нажатие отключено, а не молча вставляет пустоту.
            const readable = templateReadable(item);
            return (
              <AppPressable
                style={styles.item}
                disabled={!mayPickTemplate(item)}
                onPress={() => onPick(item.text)}
              >
                <Text style={readable ? styles.itemText : styles.itemTextUnreadable} numberOfLines={2}>
                  {readable ? item.text : UNREADABLE_TEMPLATE_TEXT}
                </Text>
              </AppPressable>
            );
          }}
        />
      )}
    </View>
  );
}

// ============================================================================
// Tab: Контакт — список из listContacts()
// ============================================================================

function ContactTab({ onPick }: { onPick: (c: Contact) => void }) {
  const colors = useColors();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const list = await listContacts();
        setContacts(list);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return contacts;
    return contacts.filter((c) => c.displayName.toLowerCase().includes(needle));
  }, [contacts, q]);

  const styles = useThemedStyles((c) => ({
    wrap: { flex: 1 },
    searchWrap: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.surfaceHigh,
      borderRadius: 20,
      paddingHorizontal: spacing.md,
      margin: spacing.md,
    },
    searchInput: {
      flex: 1,
      color: c.text,
      fontSize: font.md,
      paddingVertical: 10,
      marginLeft: spacing.sm,
    },
    row: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: spacing.md,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    avatar: {
      width: 40, height: 40, borderRadius: 20,
      backgroundColor: c.primaryMuted,
      alignItems: 'center' as const, justifyContent: 'center' as const,
      marginRight: spacing.md,
    },
    initials: { color: c.accent, fontWeight: '700' as const, fontSize: font.sm },
    name: { color: c.text, fontSize: font.md, flex: 1 },
    empty: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.lg },
    emptyText: { color: c.textMuted, fontSize: font.sm, textAlign: 'center' as const },
  }));

  return (
    <View style={styles.wrap}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={q}
          onChangeText={setQ}
          placeholder="Поиск по контактам"
          placeholderTextColor={colors.textMuted}
        />
      </View>
      {loading ? (
        <View style={styles.empty}><Text style={styles.emptyText}>Загрузка…</Text></View>
      ) : filtered.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="person-outline" size={40} color={colors.textMuted} style={{ marginBottom: spacing.sm }} />
          <Text style={styles.emptyText}>
            {q ? 'Ничего не найдено' : 'Нет контактов'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(c) => c.peerPublicKey}
          renderItem={({ item }) => {
            const initials = nameInitials(item.displayName);
            return (
              <AppPressable style={styles.row} onPress={() => onPick(item)}>
                <View style={styles.avatar}>
                  <Text style={styles.initials}>{initials}</Text>
                </View>
                <Text style={styles.name} numberOfLines={1}>{item.displayName}</Text>
                <Ionicons name="share-outline" size={18} color={colors.textMuted} />
              </AppPressable>
            );
          }}
        />
      )}
    </View>
  );
}
