import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ExpoClipboardModule from 'expo-clipboard';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { SafeScreen } from '../../SafeScreen';
import { useTheme } from '../../../ThemeContext';
import { badgeTint, font, radius, spacing } from '../../../theme';
import { listConversationMedia, type SharedMediaRow } from '../../../../core/storage/local';
import { mediaRowReadable, mediaSkippedNotice } from '../../../../core/media/sharedMediaScan';
import { parseMediaCidsColumn } from '../../../../core/media/mediaCidPolicy';
import { useResolvedMediaUrls } from '../../../screens/chat-components/useResolvedMediaUrls';
import { showSuccess } from '../../userFeedback';
import { shouldApplyRows } from '../../../../core/storage/readResult';
import { isDocMessage } from '../../../../core/social/docEnvelope';
import { isVoiceMessage, parseVoiceMeta } from '../../../../core/social/voiceEnvelope';
import { isAudioFileName } from '../../../../core/media/audioName';
import { parseDocMeta } from '../../../../core/social/docMeta';
import { openExternal } from '../../../utils/openExternal';
import { formatByteSize } from '../../../../core/media/byteSize';
// Длительность голосового — общая арифметика на звонок, запись и видео:
// своя копия «мм:сс» уже однажды разошлась с остальными (durationLabel).
import { formatClockDuration } from '../../../time/durationLabel';
import { numericDate } from '../../../../core/time/ruDateTime';
import { COPIED_LINK } from '../../../clipboardText';

// ─── SharedMediaModal ─────────────────────────────────────────────────────────
const URL_REGEX_SM = /https?:\/\/[^\s<>"]+/g;

/**
 * v4.32.568: вкладок стало пять. Карточка профиля разводит «Файлы», «Музыку»
 * и «Голосовые» по отдельным разделам, и каждый раздел открывает эту же
 * модалку сразу на своей вкладке — отсюда `initialTab`.
 */
export type SharedMediaTab = 'media' | 'links' | 'docs' | 'music' | 'voice';

/** Зазор между плитками сетки. Плитка считается от ширины места под неё. */
const TILE_GAP = 2;
/** Сколько плиток в ряду. Три — как в галерее телефона. */
const TILE_COLUMNS = 3;

/**
 * SharedMediaPane — содержимое одной вкладки без окна вокруг (v4.32.577).
 *
 * Отдельно от модалки, потому что мест показа стало два: полноэкранная
 * галерея переписки (экран диалога) и раздел прямо в карточке профиля, где
 * никакого окна поверх нет. Списки при этом обязаны остаться одни и те же:
 * две копии «файлов переписки» разошлись бы на первой же правке — так уже
 * было с разбором «мм:сс».
 *
 * Своей вертикальной прокрутки у полосы нет: она рисует ровно то, что ей
 * дали, а прокручивает её тот, кто её вставил. Иначе внутри карточки профиля
 * получилась бы прокрутка в прокрутке — то есть список, до конца которого
 * пальцем не добраться.
 */
export function SharedMediaPane({
  active,
  contactPubB64,
  ownerProfileId,
  gateway,
  tab,
  limit = null,
  onImagePress,
  onShowAll,
}: {
  /** Читать ли содержимое. Закрытая вкладка в базу не ходит. */
  active: boolean;
  contactPubB64: string;
  ownerProfileId: number;
  gateway: string;
  tab: SharedMediaTab;
  /** Сколько строк показать. `null` — все; иначе остальное за «Показать всё». */
  limit?: number | null;
  onImagePress: (uris: string[], idx: number) => void;
  /** Открыть полный список. Без него обрезка молчит — и это было бы враньём. */
  onShowAll?: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.409: плашка значка — от фона списка, значок — от плашки.
  const docTint = useMemo(() => badgeTint(colors, 'accent', colors.background), [colors]);
  const [items, setItems] = useState<SharedMediaRow[]>([]);
  const [sharedLinks, setSharedLinks] = useState<Array<{ url: string; text: string; createdAt: number }>>([]);
  const [sharedDocs, setSharedDocs] = useState<Array<{ name: string; size: string; createdAt: number; text: string }>>([]);
  /** v4.32.568: музыка — те же вложения-документы, отобранные по имени файла. */
  const [sharedMusic, setSharedMusic] = useState<Array<{ name: string; size: string; createdAt: number; text: string }>>([]);
  /** v4.32.568: голосовые — свой конверт, поэтому и свой список. */
  const [sharedVoice, setSharedVoice] = useState<Array<{ id: string; durationMs: number; createdAt: number; outgoing: boolean }>>([]);
  /** Ширина места под сетку: в карточке профиля она уже, чем экран. */
  const [gridWidth, setGridWidth] = useState(0);

  useEffect(() => {
    if (!active) return;
    void listConversationMedia(contactPubB64, ownerProfileId).then(setItems);
    // Load links and docs from messages
    void import('../../../../core/storage/local').then(async (m) => {
      const msgs = await m.listAllChatMessages({ contactPubB64, ownerProfileId });
      // v4.32.604: сбой чтения — не «ссылок и файлов нет». Прежние списки
      // остаются как были, вкладка не рисует пустоту как факт.
      if (!shouldApplyRows(msgs)) return;
      const links: Array<{ url: string; text: string; createdAt: number }> = [];
      const docs: Array<{ name: string; size: string; createdAt: number; text: string }> = [];
      const music: Array<{ name: string; size: string; createdAt: number; text: string }> = [];
      const voice: Array<{ id: string; durationMs: number; createdAt: number; outgoing: boolean }> = [];
      const seenUrls = new Set<string>();
      for (const msg of msgs) {
        if (!msg.text) continue;
        // Extract URLs
        const urls = msg.text.match(URL_REGEX_SM) ?? [];
        for (const url of urls) {
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            links.push({ url, text: msg.text.slice(0, 100), createdAt: msg.createdAt });
          }
        }
        // Extract docs using local helpers (defined at bottom of ChatScreen)
        if (isDocMessage(msg.text)) {
          const meta = parseDocMeta(msg.text);
          if (meta) {
            const row = { name: meta.name, size: formatByteSize(meta.size), createdAt: msg.createdAt, text: msg.text };
            // Музыка уходит в свой раздел и во «Файлах» не дублируется:
            // человек искал бы её дважды в двух списках одного и того же.
            if (isAudioFileName(meta.name)) music.push(row);
            else docs.push(row);
          }
        }
        if (isVoiceMessage(msg.text)) {
          const vm = parseVoiceMeta(msg.text);
          if (vm) voice.push({ id: msg.id, durationMs: vm.durationMs, createdAt: msg.createdAt, outgoing: msg.direction === 'out' });
        }
      }
      setSharedLinks(links.reverse());
      setSharedDocs(docs.reverse());
      setSharedMusic(music.reverse());
      setSharedVoice(voice.reverse());
    }).catch(() => {});
  }, [active, contactPubB64, ownerProfileId]);

  /**
   * v4.32.248: «Общие медиа» показывали только снимки со шлюза IPFS, а на
   * телефоне IPFS выключен — все фотографии переписки ездят зашифрованным
   * вложением (`nb:`). Поэтому вкладка была пуста ВСЕГДА, при любой переписке
   * с картинками. Разбор адреса теперь общий с самой перепиской
   * (useResolvedMediaUrls): вложение расшифровывается в файл кэша, обычный
   * CID по-прежнему собирается адресом шлюза.
   *
   * Потолок в 300 адресов — не косметика: каждое незакэшированное вложение
   * это загрузка до 8 МБ, и в переписке на тысячу фотографий открытие
   * вкладки означало бы тысячу загрузок. Очередь на них общая
   * (см. useResolvedMediaUrls).
   */
  const allCids = useMemo(() => {
    const out: string[] = [];
    for (const it of items) {
      for (const cid of parseMediaCidsColumn(it.mediaCids)) {
        const c = cid.trim();
        if (c) out.push(c);
      }
      if (out.length >= 300) break;
    }
    return out.slice(0, 300);
  }, [items]);
  const resolved = useResolvedMediaUrls(allCids, gateway);
  const allUris = useMemo(() => resolved.filter((u): u is string => !!u), [resolved]);

  /** v4.32.584: сколько вложений не прочитано — молчать об этом нельзя. */
  const mediaNotice = useMemo(() => mediaSkippedNotice(items), [items]);

  /** Сторона плитки: место под сетку без зазоров, поделённое на три. */
  const tileSide = gridWidth > 0
    ? Math.floor((gridWidth - TILE_GAP * (TILE_COLUMNS - 1)) / TILE_COLUMNS)
    : 0;

  const renderTile = useCallback((item: SharedMediaRow) => {
    // v4.32.584: строку, которую не открыл ключ, показываем местом в сетке —
    // иначе вложение исчезает бесследно.
    if (!mediaRowReadable(item)) {
      return (
        <View
          key={item.id}
          style={[
            paneStyles.thumbUnreadable,
            { width: tileSide, height: tileSide, backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Ionicons name="alert-circle-outline" size={22} color={colors.warning} />
        </View>
      );
    }
    const first = parseMediaCidsColumn(item.mediaCids)[0]?.trim() ?? '';
    if (!first) return null;
    // Вложение расшифровывается асинхронно: пока файла нет — плитки нет.
    const uri = resolved[allCids.indexOf(first)] ?? null;
    if (!uri) return null;
    const flatIdx = allUris.indexOf(uri);
    return (
      <AppPressable key={item.id} onPress={() => onImagePress(allUris, flatIdx >= 0 ? flatIdx : 0)}>
        <Image source={{ uri }} style={{ width: tileSide, height: tileSide }} resizeMode="cover" />
      </AppPressable>
    );
  }, [resolved, allCids, allUris, onImagePress, colors, tileSide]);

  /** «Показано не всё» — строкой под списком, а не молчанием. */
  const more = useCallback((shown: number, total: number) => (
    total > shown && onShowAll ? (
      <AppPressable
        style={paneStyles.moreRow}
        onPress={onShowAll}
        accessibilityRole="button"
        accessibilityLabel="Показать всё"
      >
        <Text style={[paneStyles.moreText, { color: colors.accent }]}>
          Показать всё · {total}
        </Text>
      </AppPressable>
    ) : null
  ), [onShowAll, colors]);

  const empty = (icon: React.ComponentProps<typeof Ionicons>['name'], text: string) => (
    <View style={paneStyles.empty}>
      <Ionicons name={icon} size={44} color={colors.textMuted} />
      <Text style={[paneStyles.emptyText, { color: colors.textMuted }]}>{text}</Text>
    </View>
  );

  const cut = <T,>(rows: T[]): T[] => (limit === null ? rows : rows.slice(0, limit));

  if (tab === 'media') {
    const shown = cut(items);
    return (
      <View onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
        {mediaNotice ? (
          <Text style={[paneStyles.skipped, { color: colors.warning }]}>{mediaNotice}</Text>
        ) : null}
        {items.length === 0 ? empty('images-outline', 'Нет медиафайлов') : (
          <View style={paneStyles.grid}>
            {tileSide > 0 ? shown.map(renderTile) : null}
          </View>
        )}
        {more(shown.length, items.length)}
      </View>
    );
  }

  if (tab === 'links') {
    const shown = cut(sharedLinks);
    return (
      <View>
        {sharedLinks.length === 0 ? empty('link-outline', 'Нет ссылок') : shown.map((link, i) => (
          <AppPressable
            key={`${link.url}_${i}`}
            style={[paneStyles.row, { borderColor: colors.border }]}
            onPress={() => openExternal(link.url, 'chat_shared_link')}
            onLongPress={() => { void ExpoClipboardModule.setStringAsync(link.url); showSuccess(COPIED_LINK); }}
          >
            <Text style={[paneStyles.rowTitle, { color: colors.accent }]} numberOfLines={1}>{link.url}</Text>
            <Text style={[paneStyles.rowSub, { color: colors.textMuted }]}>{numericDate(link.createdAt)}</Text>
          </AppPressable>
        ))}
        {more(shown.length, sharedLinks.length)}
      </View>
    );
  }

  if (tab === 'docs' || tab === 'music') {
    const all = tab === 'music' ? sharedMusic : sharedDocs;
    const icon = tab === 'music' ? 'musical-notes-outline' : 'document-outline';
    const shown = cut(all);
    return (
      <View>
        {all.length === 0
          ? empty(icon, tab === 'music' ? 'Нет музыки' : 'Нет файлов')
          : shown.map((doc, i) => (
            <View key={`${doc.name}_${i}`} style={[paneStyles.row, paneStyles.rowLine, { borderColor: colors.border }]}>
              <View style={[paneStyles.badge, { backgroundColor: docTint.fill }]}>
                <Ionicons name={icon} size={20} color={docTint.ink} />
              </View>
              <View style={paneStyles.rowBody}>
                <Text style={[paneStyles.rowName, { color: colors.text }]} numberOfLines={1}>{doc.name}</Text>
                <Text style={[paneStyles.rowSub, { color: colors.textMuted }]}>{doc.size} · {numericDate(doc.createdAt)}</Text>
              </View>
            </View>
          ))}
        {more(shown.length, all.length)}
      </View>
    );
  }

  const shownVoice = cut(sharedVoice);
  return (
    <View>
      {sharedVoice.length === 0 ? empty('mic-outline', 'Нет голосовых') : shownVoice.map((v) => (
        <View key={v.id} style={[paneStyles.row, paneStyles.rowLine, { borderColor: colors.border }]}>
          <View style={[paneStyles.badge, { backgroundColor: docTint.fill }]}>
            <Ionicons name={v.outgoing ? 'arrow-up-outline' : 'arrow-down-outline'} size={20} color={docTint.ink} />
          </View>
          <View style={paneStyles.rowBody}>
            <Text style={[paneStyles.rowName, { color: colors.text }]}>{formatClockDuration(v.durationMs)}</Text>
            <Text style={[paneStyles.rowSub, { color: colors.textMuted }]}>
              {(v.outgoing ? 'Отправлено' : 'Получено')} · {numericDate(v.createdAt)}
            </Text>
          </View>
        </View>
      ))}
      {more(shownVoice.length, sharedVoice.length)}
    </View>
  );
}

export function SharedMediaModal({
  visible,
  contactPubB64,
  ownerProfileId,
  gateway,
  initialTab = 'media',
  onClose,
  onImagePress,
}: {
  visible: boolean;
  contactPubB64: string;
  ownerProfileId: number;
  gateway: string;
  /** С какой вкладки открыться. По умолчанию — «Медиа», как было. */
  initialTab?: SharedMediaTab;
  onClose: () => void;
  onImagePress: (uris: string[], idx: number) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [activeTab, setActiveTab] = useState<SharedMediaTab>(initialTab);

  // Открытие «на своей вкладке»: состояние живёт между открытиями модалки, и
  // без этого второй заход из раздела «Музыка» показывал бы прошлую вкладку.
  useEffect(() => {
    if (visible) setActiveTab(initialTab);
  }, [visible, initialTab]);

  const TABS = [
    { id: 'media' as const, label: 'Медиа', icon: 'images-outline' as const },
    { id: 'links' as const, label: 'Ссылки', icon: 'link-outline' as const },
    { id: 'docs' as const, label: 'Файлы', icon: 'document-outline' as const },
    { id: 'music' as const, label: 'Музыка', icon: 'musical-notes-outline' as const },
    { id: 'voice' as const, label: 'Голос', icon: 'mic-outline' as const },
  ];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* v4.32.571: safe-area сверху. Без неё шапка со стрелкой «назад» и
          заголовком уезжала под системную строку — часы и батарею, — и нажать
          «назад» на телефоне с вырезом было нечем. Обёртка та же, что у
          полноэкранных модалок контактов (v4.32.42). */}
      <SafeScreen edges={['top', 'left', 'right']} backgroundColor={colors.background} style={smStyles.container}>
        <View style={[smStyles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
          <AppPressable style={smStyles.closeBtn} onPress={onClose}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </AppPressable>
          <Text style={[smStyles.title, { color: colors.text }]}>Медиа и файлы</Text>
        </View>
        {/* Tab bar */}
        <View style={[smStyles.tabs, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          {TABS.map((tab) => (
            <AppPressable
              key={tab.id}
              style={[
                smStyles.tab,
                { borderBottomColor: activeTab === tab.id ? colors.primary : 'transparent' },
              ]}
              onPress={() => setActiveTab(tab.id)}
            >
              <Ionicons name={tab.icon} size={18} color={activeTab === tab.id ? colors.accent : colors.textMuted} />
              <Text
                style={[
                  smStyles.tabLabel,
                  {
                    color: activeTab === tab.id ? colors.accent : colors.textMuted,
                    fontWeight: activeTab === tab.id ? '600' : '400',
                  },
                ]}
              >
                {tab.label}
              </Text>
            </AppPressable>
          ))}
        </View>
        <ScrollView>
          <SharedMediaPane
            active={visible}
            contactPubB64={contactPubB64}
            ownerProfileId={ownerProfileId}
            gateway={gateway}
            tab={activeTab}
            onImagePress={onImagePress}
          />
        </ScrollView>
      </SafeScreen>
    </Modal>
  );
}

const paneStyles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: TILE_GAP },
  thumbUnreadable: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  skipped: {
    fontSize: font.xs,
    fontStyle: 'italic',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: font.sm },
  rowName: { fontSize: font.sm, fontWeight: '600' },
  rowSub: { fontSize: font.xs, marginTop: 2 },
  badge: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreRow: { paddingVertical: spacing.md, paddingHorizontal: spacing.sm },
  moreText: { fontSize: font.sm, fontWeight: '600' },
  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  emptyText: { fontSize: font.sm, textAlign: 'center' },
});

const smStyles = StyleSheet.create({
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
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 2,
  },
  tabLabel: { fontSize: font.xs, marginTop: 2 },
});
