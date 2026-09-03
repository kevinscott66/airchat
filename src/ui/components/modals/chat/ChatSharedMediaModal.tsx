import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  Image,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ExpoClipboardModule from 'expo-clipboard';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { SafeScreen } from '../../SafeScreen';
import { useTheme } from '../../../ThemeContext';
import { badgeTint, font, radius } from '../../../theme';
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
  // v4.32.409: плашка значка — от фона списка, значок — от плашки.
  const docTint = useMemo(() => badgeTint(colors, 'accent', colors.background), [colors]);
  const [items, setItems] = useState<SharedMediaRow[]>([]);
  const [sharedLinks, setSharedLinks] = useState<Array<{ url: string; text: string; createdAt: number }>>([]);
  const [sharedDocs, setSharedDocs] = useState<Array<{ name: string; size: string; createdAt: number; text: string }>>([]);
  /** v4.32.568: музыка — те же вложения-документы, отобранные по имени файла. */
  const [sharedMusic, setSharedMusic] = useState<Array<{ name: string; size: string; createdAt: number; text: string }>>([]);
  /** v4.32.568: голосовые — свой конверт, поэтому и свой список. */
  const [sharedVoice, setSharedVoice] = useState<Array<{ id: string; durationMs: number; createdAt: number; outgoing: boolean }>>([]);
  const [activeTab, setActiveTab] = useState<SharedMediaTab>(initialTab);

  // Открытие «на своей вкладке»: состояние живёт между открытиями модалки, и
  // без этого второй заход из раздела «Музыка» показывал бы прошлую вкладку.
  useEffect(() => {
    if (visible) setActiveTab(initialTab);
  }, [visible, initialTab]);

  useEffect(() => {
    if (!visible) return;
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
  }, [visible, contactPubB64, ownerProfileId]);

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

  const renderItem = useCallback(({ item }: { item: SharedMediaRow; index: number }) => {
    // v4.32.584: строку, которую не открыл ключ, показываем местом в сетке —
    // иначе вложение исчезает бесследно.
    if (!mediaRowReadable(item)) {
      return (
        <View style={[smStyles.thumb, smStyles.thumbUnreadable, { backgroundColor: colors.surface, borderColor: colors.border }]}>
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
      <AppPressable onPress={() => onImagePress(allUris, flatIdx >= 0 ? flatIdx : 0)}>
        <Image source={{ uri }} style={smStyles.thumb} resizeMode="cover" />
      </AppPressable>
    );
  }, [resolved, allCids, allUris, onImagePress, colors]);

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
        <View style={{ flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface }}>
          {TABS.map((tab) => (
            <AppPressable
              key={tab.id}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: activeTab === tab.id ? colors.primary : 'transparent' }}
              onPress={() => setActiveTab(tab.id)}
            >
              <Ionicons name={tab.icon} size={18} color={activeTab === tab.id ? colors.accent : colors.textMuted} />
              <Text style={{ fontSize: font.xs, color: activeTab === tab.id ? colors.accent : colors.textMuted, marginTop: 2, fontWeight: activeTab === tab.id ? '600' : '400' }}>{tab.label}</Text>
            </AppPressable>
          ))}
        </View>
        {activeTab === 'media' ? (
          items.length === 0 ? (
            <View style={smStyles.empty}>
              <Ionicons name="images-outline" size={48} color={colors.textMuted} />
              <Text style={{ color: colors.textMuted, marginTop: 12 }}>Нет медиафайлов</Text>
            </View>
          ) : (
            <View style={{ flex: 1 }}>
              {mediaNotice ? (
                <Text style={[smStyles.skipped, { color: colors.warning }]}>{mediaNotice}</Text>
              ) : null}
              <FlatList
                data={items}
                keyExtractor={(i) => i.id}
                numColumns={3}
                renderItem={renderItem}
                contentContainerStyle={{ padding: 1 }}
              />
            </View>
          )
        ) : activeTab === 'links' ? (
          <ScrollView>
            {sharedLinks.length === 0 ? (
              <View style={smStyles.empty}>
                <Ionicons name="link-outline" size={48} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, marginTop: 12 }}>Нет ссылок</Text>
              </View>
            ) : sharedLinks.map((link, i) => (
              <AppPressable
                key={`${link.url}_${i}`}
                style={{ padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
                onPress={() => openExternal(link.url, 'chat_shared_link')}
                onLongPress={() => { void ExpoClipboardModule.setStringAsync(link.url); showSuccess(COPIED_LINK); }}
              >
                <Text style={{ color: colors.accent, fontSize: 14 }} numberOfLines={1}>{link.url}</Text>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>{numericDate(link.createdAt)}</Text>
              </AppPressable>
            ))}
          </ScrollView>
        ) : activeTab === 'docs' || activeTab === 'music' ? (
          <ScrollView>
            {(activeTab === 'music' ? sharedMusic : sharedDocs).length === 0 ? (
              <View style={smStyles.empty}>
                <Ionicons name={activeTab === 'music' ? 'musical-notes-outline' : 'document-outline'} size={48} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, marginTop: 12 }}>
                  {activeTab === 'music' ? 'Нет музыки' : 'Нет файлов'}
                </Text>
              </View>
            ) : (activeTab === 'music' ? sharedMusic : sharedDocs).map((doc, i) => (
              <View key={i} style={{ padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: docTint.fill, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name={activeTab === 'music' ? 'musical-notes-outline' : 'document-outline'} size={20} color={docTint.ink} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{doc.name}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>{doc.size} · {numericDate(doc.createdAt)}</Text>
                </View>
              </View>
            ))}
          </ScrollView>
        ) : (
          <ScrollView>
            {sharedVoice.length === 0 ? (
              <View style={smStyles.empty}>
                <Ionicons name="mic-outline" size={48} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, marginTop: 12 }}>Нет голосовых</Text>
              </View>
            ) : sharedVoice.map((v) => (
              <View key={v.id} style={{ padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: docTint.fill, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name={v.outgoing ? 'arrow-up-outline' : 'arrow-down-outline'} size={20} color={docTint.ink} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '600' }}>{formatClockDuration(v.durationMs)}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                    {(v.outgoing ? 'Отправлено' : 'Получено')} · {numericDate(v.createdAt)}
                  </Text>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </SafeScreen>
    </Modal>
  );
}

const smStyles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  closeBtn: { padding: 8 },
  title: { fontSize: 17, fontWeight: '600', flex: 1 },
  thumb: { width: Math.floor(Dimensions.get('window').width / 3) - 2, height: Math.floor(Dimensions.get('window').width / 3) - 2, margin: 1 },
  thumbUnreadable: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  skipped: { fontSize: 12, fontStyle: 'italic', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
