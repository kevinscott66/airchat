import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  ScrollView,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { badgeTint, font, radius } from '../../../theme';
import {
  listGroupConversationMedia,
  type SharedMediaRow,
  listAllGroupMessages,
} from '../../../../core/storage/local';
import { shouldApplyRows } from '../../../../core/storage/readResult';
import { isDocMessage, parseDocEnvelope } from '../../../../core/social/docEnvelope';
import { useResolvedMediaUrls } from '../../../screens/chat-components/useResolvedMediaUrls';
import { mediaRowReadable, mediaSkippedNotice } from '../../../../core/media/sharedMediaScan';
import { parseMediaCidsColumn } from '../../../../core/media/mediaCidPolicy';
import { openExternal } from '../../../utils/openExternal';
import { formatByteSize } from '../../../../core/media/byteSize';
import { numericDate } from '../../../../core/time/ruDateTime';

const GRP_THUMB_SIZE = Math.floor(Dimensions.get('window').width / 3) - 2;

const GRP_URL_RE_SM = /https?:\/\/[^\s<>"]+/g;

// Причина у всех трёх вкладок одна, поэтому и текст один: разные формулировки
// про «ссылки» и «файлы» намекали бы, что не прочиталось что-то одно.
const GSM_READ_FAILED = 'Не удалось прочитать переписку';

export function GroupSharedMediaModal({
  visible,
  groupId,
  ownerProfileId,
  gateway,
  onClose,
}: {
  visible: boolean;
  groupId: string;
  ownerProfileId: number;
  gateway: string;
  onClose: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.409: плашка значка — от фона списка, значок — от плашки.
  const docTint = useMemo(() => badgeTint(colors, 'accent', colors.background), [colors]);
  const [items, setItems] = useState<SharedMediaRow[]>([]);
  const [sharedLinks, setSharedLinks] = useState<Array<{ url: string; createdAt: number }>>([]);
  const [sharedDocs, setSharedDocs] = useState<Array<{ name: string; size: string; createdAt: number }>>([]);
  const [activeTab, setActiveTab] = useState<'media' | 'links' | 'docs'>('media');
  // v4.32.532: обе выборки окна раньше возвращали пустой список на любой сбой
  // базы, и окно писало «Нет медиафайлов» — то есть заявляло, что вложений в
  // группе нет, хотя просто не смогло их прочитать.
  const [readFailed, setReadFailed] = useState(false);

  /**
   * v4.32.248: галерея группы показывала только снимки со шлюза IPFS, а на
   * телефоне IPFS выключен — фотографии ездят зашифрованным вложением (`nb:`),
   * поэтому вкладка «Медиа» была пуста при любой переписке. Разбор адреса
   * теперь общий с самой перепиской: вложение расшифровывается в файл кэша.
   *
   * Показываем не больше 300 последних: каждое незакэшированное вложение —
   * это загрузка до 8 МБ, очередь на них общая (см. useResolvedMediaUrls).
   */
  const mediaItems = useMemo(() => items.slice(0, 300), [items]);
  /** v4.32.584: сколько вложений не прочитано — молчать об этом нельзя. */
  const mediaNotice = useMemo(() => mediaSkippedNotice(mediaItems), [mediaItems]);
  const firstCids = useMemo(
    () => mediaItems.map((it) => parseMediaCidsColumn(it.mediaCids)[0]?.trim() ?? ''),
    [mediaItems]
  );
  const thumbUris = useResolvedMediaUrls(firstCids, gateway);

  useEffect(() => {
    if (!visible) return;
    // v4.32.532: окно открывают и закрывают быстрее, чем читается тысяча
    // сообщений; без этой проверки ответ прошлого открытия дописывался в уже
    // закрытое окно.
    let alive = true;
    setReadFailed(false);
    void listGroupConversationMedia(groupId, ownerProfileId).then((rows) => {
      if (!alive) return;
      if (!shouldApplyRows(rows)) { setReadFailed(true); return; }
      setItems([...rows]);
    }).catch(() => { if (alive) setReadFailed(true); });
    void listAllGroupMessages({ groupId, ownerProfileId }).then((msgs) => {
      if (!alive) return;
      if (!shouldApplyRows(msgs)) { setReadFailed(true); return; }
      const links: Array<{ url: string; createdAt: number }> = [];
      const docs: Array<{ name: string; size: string; createdAt: number }> = [];
      const seenUrls = new Set<string>();
      for (const msg of msgs) {
        const t = msg.text ?? '';
        const urls = t.match(GRP_URL_RE_SM) ?? [];
        for (const url of urls) {
          if (!seenUrls.has(url)) { seenUrls.add(url); links.push({ url, createdAt: msg.createdAt }); }
        }
        // v4.32.241: свой JSON.parse без проверок принимал meta.name любого
        // типа и с невидимым U+202E (подмена расширения на экране). Общий
        // разбор — в core/social/docEnvelope.
        if (isDocMessage(t)) {
          const meta = parseDocEnvelope(t);
          if (meta) {
            docs.push({ name: meta.name, size: formatByteSize(meta.size), createdAt: msg.createdAt });
          }
        }
      }
      setSharedLinks(links.reverse());
      setSharedDocs(docs.reverse());
    }).catch(() => { if (alive) setReadFailed(true); });
    return () => { alive = false; };
  }, [visible, groupId, ownerProfileId]);

  const GRP_SM_TABS = [
    { id: 'media' as const, label: 'Медиа', icon: 'images-outline' as const },
    { id: 'links' as const, label: 'Ссылки', icon: 'link-outline' as const },
    { id: 'docs' as const, label: 'Файлы', icon: 'document-outline' as const },
  ];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[gsmStyles.container, { backgroundColor: colors.background }]}>
        <View style={[gsmStyles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
          <AppPressable style={gsmStyles.closeBtn} onPress={onClose}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </AppPressable>
          <Text style={[gsmStyles.title, { color: colors.text }]}>Медиа и файлы</Text>
        </View>
        <View style={{ flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface }}>
          {GRP_SM_TABS.map((tab) => (
            <AppPressable key={tab.id} style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: activeTab === tab.id ? colors.primary : 'transparent' }} onPress={() => setActiveTab(tab.id)}>
              <Ionicons name={tab.icon} size={18} color={activeTab === tab.id ? colors.accent : colors.textMuted} />
              <Text style={{ fontSize: font.xs, color: activeTab === tab.id ? colors.accent : colors.textMuted, marginTop: 2, fontWeight: activeTab === tab.id ? '600' : '400' }}>{tab.label}</Text>
            </AppPressable>
          ))}
        </View>
        {activeTab === 'media' ? (
          items.length === 0 ? (
            <View style={gsmStyles.empty}>
              <Ionicons name={readFailed ? 'alert-circle-outline' : 'images-outline'} size={48} color={colors.textMuted} />
              <Text style={{ color: colors.textMuted, marginTop: 12 }}>{readFailed ? GSM_READ_FAILED : 'Нет медиафайлов'}</Text>
            </View>
          ) : (
            <View style={{ flex: 1 }}>
              {mediaNotice ? (
                <Text style={[gsmStyles.skipped, { color: colors.warning }]}>{mediaNotice}</Text>
              ) : null}
              <FlatList
                data={mediaItems}
                keyExtractor={(i) => i.id}
                numColumns={3}
                renderItem={({ item, index }) => {
                  // v4.32.584: строку, которую не открыл ключ, показываем
                  // местом в сетке — иначе вложение исчезает бесследно.
                  if (!mediaRowReadable(item)) {
                    return (
                      <View style={[gsmStyles.thumb, gsmStyles.thumbUnreadable, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                        <Ionicons name="alert-circle-outline" size={22} color={colors.warning} />
                      </View>
                    );
                  }
                  // Пока вложение не расшифровано, адреса нет — плитка появится
                  // сама, когда файл окажется в кэше.
                  const uri = thumbUris[index];
                  if (!uri) return null;
                  return <Image source={{ uri }} style={gsmStyles.thumb} resizeMode="cover" />;
                }}
                contentContainerStyle={{ padding: 1 }}
              />
            </View>
          )
        ) : activeTab === 'links' ? (
          <ScrollView>
            {sharedLinks.length === 0 ? (
              <View style={gsmStyles.empty}>
                <Ionicons name={readFailed ? 'alert-circle-outline' : 'link-outline'} size={48} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, marginTop: 12 }}>{readFailed ? GSM_READ_FAILED : 'Нет ссылок'}</Text>
              </View>
            ) : sharedLinks.map((link, i) => (
              <AppPressable key={`${link.url}_${i}`} style={{ padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
                onPress={() => openExternal(link.url, 'group_shared_link')}>
                <Text style={{ color: colors.accent, fontSize: 14 }} numberOfLines={1}>{link.url}</Text>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>{numericDate(link.createdAt)}</Text>
              </AppPressable>
            ))}
          </ScrollView>
        ) : (
          <ScrollView>
            {sharedDocs.length === 0 ? (
              <View style={gsmStyles.empty}>
                <Ionicons name={readFailed ? 'alert-circle-outline' : 'document-outline'} size={48} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, marginTop: 12 }}>{readFailed ? GSM_READ_FAILED : 'Нет файлов'}</Text>
              </View>
            ) : sharedDocs.map((doc, i) => (
              <View key={i} style={{ padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: docTint.fill, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="document-outline" size={20} color={docTint.ink} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{doc.name}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>{doc.size} · {numericDate(doc.createdAt)}</Text>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const gsmStyles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  closeBtn: { padding: 8 },
  title: { fontSize: 17, fontWeight: '600', flex: 1 },
  thumb: { width: GRP_THUMB_SIZE, height: GRP_THUMB_SIZE, margin: 1 },
  thumbUnreadable: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  skipped: { fontSize: 12, fontStyle: 'italic', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
