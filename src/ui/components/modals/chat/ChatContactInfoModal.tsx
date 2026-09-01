import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Image,
  Alert,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { identityAvatar, scrim } from '../../../theme';
import { showError, showSuccess } from '../../userFeedback';
import { exportBody } from '../../../../core/social/exportLine';
import { shouldApplyRows } from '../../../../core/storage/readResult';
import { SECRET_UNREADABLE_TEXT } from '../../../../core/storage/secretUpdate';
import { renameContact } from '../../../../core/social/contacts';
import {
  listConversationMedia,
  type SharedMediaRow,
  setConversationMuted,
  setConversationMutedUntil,
  listGroups,
  listGroupMembers,
  type GroupRow,
} from '../../../../core/storage/local';
import { usePresence } from '../../../hooks/usePresence';
// v4.32.168: зеркалим chat mute в muteStore → FCM gate в pushNotifications.ts.
import { setMuted as muteSet, unmute as muteUnset } from '../../../../core/notifications/muteStore';
import { membersLabel } from '../../../utils/plural';
import { mediaSkippedNotice, readableMediaCount } from '../../../../core/media/sharedMediaScan';
import { parseMediaCidsColumn } from '../../../../core/media/mediaCidPolicy';
import { shareTextExport } from '../../../../core/media/cacheFiles';
import { useResolvedMediaUrl, useResolvedMediaUrls } from '../../../screens/chat-components/useResolvedMediaUrls';
import { nameInitial } from '../../../../core/social/contactLabel';
import { publicKeyFromB64 } from '../../../../core/crypto/pubKeyFormat';
import { dayMonthLongYear, dayMonthShortTime, fullDateTime, numericDate } from '../../../../core/time/ruDateTime';
import { userErrorText } from '../../userErrorText';

// ─── computeSafetyCode (local helper) ────────────────────────────────────────
/** Сколько байтов ключей участвует в коде безопасности. */
const SAFETY_CODE_BYTES = 12;

/**
 * Код безопасности из двух открытых ключей: XOR первых 12 байт, шестнадцатерично.
 *
 * v4.32.427. Раньше длина кода бралась как `Math.min(a.length, b.length, 12)`,
 * то есть КОРОТКИЙ ключ УКОРАЧИВАЛ КОД. Строка контакта, испорченная до десяти
 * байт, давала не отказ, а код из десяти байт — короче настоящего, но с виду
 * такой же. Люди сверяют этот код голосом именно затем, чтобы поймать подмену;
 * молча ослаблять его на порченых данных — ровно обратное тому, зачем он есть.
 * Теперь код показывается только когда оба ключа настоящие, иначе — прочерк.
 */
function computeSafetyCode(aPubB64: string, bPubB64: string): string {
  const a = publicKeyFromB64(aPubB64);
  const b = publicKeyFromB64(bPubB64);
  if (!a || !b) return '—';
  const xored: number[] = [];
  for (let i = 0; i < SAFETY_CODE_BYTES; i++) xored.push((a[i] ^ b[i]) & 0xff);
  // Format as groups of 4 hex digits: "abcd ef12 3456 7890 1234 5678"
  const hex = xored.map((v) => v.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{1,4}/g)?.join(' ') ?? hex;
}

export function ContactInfoModal({
  visible,
  peerB64,
  myPubB64,
  displayName,
  onClose,
  onRename,
  activeProfileId,
  gateway,
  isMuted: initMuted,
  mutedUntil: initMutedUntil,
  onMuteChanged,
}: {
  visible: boolean;
  peerB64: string;
  myPubB64?: string;
  displayName: string;
  onClose: () => void;
  onRename: (newName: string) => void;
  activeProfileId: number;
  gateway: string;
  isMuted?: boolean;
  mutedUntil?: number | null;
  onMuteChanged?: (muted: boolean, until: number | null) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [mediaCount, setMediaCount] = useState(0);
  const [msgCount, setMsgCount] = useState(0);
  const [firstMsgDate, setFirstMsgDate] = useState<number | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [renameVisible, setRenameVisible] = useState(false);
  const [newName, setNewName] = useState(displayName);
  const [peerBio, setPeerBio] = useState<string | null>(null);
  const [peerAvatarCid, setPeerAvatarCid] = useState<string | null>(null);
  const [mediaGallery, setMediaGallery] = useState<SharedMediaRow[]>([]);
  const [mediaGalleryVisible, setMediaGalleryVisible] = useState(false);
  const [mutualGroups, setMutualGroups] = useState<GroupRow[]>([]);
  const presence = usePresence(peerB64);
  // v4.32.409: кружок-заглушка — различитель личности, как в списках просмотров.
  const peerCircle = useMemo(() => identityAvatar(peerB64), [peerB64]);
  const [contactNote, setContactNote] = useState('');
  const [noteEditVisible, setNoteEditVisible] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [notifyOnline, setNotifyOnline] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setNewName(displayName);
    setPeerBio(null);
    void listConversationMedia(peerB64, activeProfileId).then((m) => {
      // v4.32.584: счётчик считает только то, что и правда покажем, а о
      // непрочитанном говорит подпись в самой галерее.
      setMediaCount(readableMediaCount(m));
      setMediaGallery(m);
    });
    void import('../../../../core/storage/local').then((m) =>
      m.getChatMessageStats(peerB64, activeProfileId)
    ).then((stats) => {
      setMsgCount(stats.messageCount);
      setSentCount(stats.sentCount);
      setFirstMsgDate(stats.firstMessageAt);
    }).catch(() => {});
    // Load contact note
    // v4.32.277: заметка о человеке — такой же личный текст, как и переписка,
    // и лежит она в той же БД. Читается и пишется через секретный kv.
    // v4.32.278: и в пространстве имён профиля — заметка про этого человека у
    // каждого аккаунта своя, а до этой версии была одна на устройство.
    void import('../../../../core/storage/local').then((m) => m.kvGetSecretScoped(activeProfileId, m.contactNoteKey(peerB64))).then((n) => setContactNote(n ?? ''));
    // Load notify-when-online setting
    void import('../../../../core/settings/privacyPrefs').then((m) => m.notifyOnlineGet(peerB64)).then(setNotifyOnline);
    // v4.32.247: «О себе» и фото контакта берём из его конверта профиля —
    // он приходит личным сообщением и лежит в строке контакта. Прежний путь
    // (загрузка подписанного профиля по CID из IPFS) на телефоне не работал
    // никогда: CID туда не попадал, потому что IPFS выключен.
    void import('../../../../core/social/contacts').then((m) => m.listContacts()).then((contacts) => {
      const c = contacts.find((x) => x.peerPublicKey === peerB64);
      setPeerBio(c?.bio ?? null);
      setPeerAvatarCid(c?.avatarCid ?? null);
    }).catch(() => {});
    // Find mutual groups
    void (async () => {
      try {
        const groups = await listGroups(activeProfileId);
        const mutual: GroupRow[] = [];
        for (const g of groups) {
          const members = await listGroupMembers(g.id, activeProfileId);
          if (members.some((m) => m.peerPubB64 === peerB64)) {
            mutual.push(g);
          }
        }
        setMutualGroups(mutual);
      } catch { /* ignore */ }
    })();
  }, [visible, peerB64, displayName, activeProfileId]);

  const initial = nameInitial(displayName);
  const peerAvatarUri = useResolvedMediaUrl(peerAvatarCid, gateway);

  /**
   * v4.32.248: галерея показывала только снимки со шлюза IPFS, а на телефоне
   * IPFS выключен — фотографии переписки ездят зашифрованным вложением
   * (`nb:`), и «Общие медиа» были пусты всегда. Разбор адреса теперь общий с
   * самой перепиской: вложение расшифровывается в файл кэша.
   *
   * Потолок в 300 плиток сохранён с v4.32.185: собеседник мог прислать
   * тысячи снимков, и попытка показать их разом означала бы нехватку памяти.
   */
  const galleryCids = useMemo(
    () => mediaGallery.flatMap((m) => parseMediaCidsColumn(m.mediaCids)).slice(0, 300),
    [mediaGallery]
  );
  const galleryUris = useResolvedMediaUrls(galleryCids, gateway);

  const submitRename = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    await renameContact(peerB64, trimmed);
    onRename(trimmed);
    setRenameVisible(false);
    showSuccess('Имя обновлено');
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={{ flex: 1, backgroundColor: scrim.modal }} onPress={onClose}>
        <AppPressable
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.surface, paddingBottom: 32 }}
          onPress={() => {}}
        >
          {/* Header */}
          <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
            {peerAvatarUri ? (
              <Image
                source={{ uri: peerAvatarUri }}
                style={{ width: 72, height: 72, borderRadius: 36, marginBottom: 10 }}
                accessibilityIgnoresInvertColors
              />
            ) : (
              <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: peerCircle.fill, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
                <Text style={{ fontSize: 28, fontWeight: '700', color: peerCircle.ink }}>{initial}</Text>
              </View>
            )}
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{displayName}</Text>
            {presence.bucket !== 'never' ? (
              <Text style={{ fontSize: 12, color: presence.bucket === 'online' ? colors.success : colors.textMuted, marginTop: 4 }}>
                {presence.label}
              </Text>
            ) : (
              <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>{peerB64.slice(0, 16)}…</Text>
            )}
            {presence.status ? (
              // v4.32.375: предел по строкам — на случай статуса от чужого
              // клиента, который про правило «одна строка» не знает.
              <Text numberOfLines={2} style={{ fontSize: 13, color: colors.textSecondary, marginTop: 6, fontStyle: 'italic' }}>«{presence.status}»</Text>
            ) : null}
            {peerBio ? (
              // v4.32.374: предел по строкам. С этой версии «О себе» доезжает
              // с переводами строки — значит 512 символов вида «а\nб\nв» дают
              // не три строки, а полторы сотни, и шапка карточки уезжает выше
              // экрана вместе со всем, что под ней.
              <Text numberOfLines={6} style={{ fontSize: 13, color: colors.textSecondary, marginTop: 8, textAlign: 'center', paddingHorizontal: 20 }}>{peerBio}</Text>
            ) : null}
          </View>
          {/* Stats */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{msgCount}</Text>
              <Text style={{ fontSize: 11, color: colors.textMuted }}>всего</Text>
            </View>
            <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{sentCount}</Text>
              <Text style={{ fontSize: 11, color: colors.textMuted }}>отправлено</Text>
            </View>
            <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
            <AppPressable style={{ alignItems: 'center', flex: 1 }} onPress={() => mediaCount > 0 && setMediaGalleryVisible(true)}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: mediaCount > 0 ? colors.accent : colors.text }}>{mediaCount}</Text>
              <Text style={{ fontSize: 11, color: colors.textMuted }}>медиа</Text>
            </AppPressable>
          </View>
          {firstMsgDate ? (
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
              <Text style={{ fontSize: 12, color: colors.textMuted }}>
                📅 Первое сообщение: <Text style={{ color: colors.text, fontWeight: '600' }}>{dayMonthLongYear(firstMsgDate)}</Text>
              </Text>
            </View>
          ) : null}

          {/* Media gallery modal */}
          <Modal visible={mediaGalleryVisible} transparent animationType="slide" onRequestClose={() => setMediaGalleryVisible(false)}>
            <AppPressable style={{ flex: 1, backgroundColor: scrim.viewer, justifyContent: 'flex-end' }} onPress={() => setMediaGalleryVisible(false)}>
              <AppPressable style={{ backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '80%', paddingBottom: 24 }} onPress={() => {}}>
                <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                  <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: colors.text }}>Медиафайлы</Text>
                  <AppPressable onPress={() => setMediaGalleryVisible(false)}>
                    <Ionicons name="close" size={22} color={colors.text} />
                  </AppPressable>
                </View>
                {mediaSkippedNotice(mediaGallery) ? (
                  <Text style={{ fontSize: 12, fontStyle: 'italic', color: colors.warning, paddingHorizontal: 16, paddingTop: 8 }}>
                    {mediaSkippedNotice(mediaGallery)}
                  </Text>
                ) : null}
                <ScrollView>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: 4 }}>
                    {galleryUris.map((uri, i) => (
                      // Пока вложение не расшифровано, адреса нет — плитка
                      // появится сама, когда файл окажется в кэше.
                      uri ? (
                        <Image
                          key={`${galleryCids[i]}_${i}`}
                          source={{ uri }}
                          style={{ width: '33.33%', aspectRatio: 1, padding: 2 }}
                          resizeMode="cover"
                        />
                      ) : null
                    ))}
                  </View>
                </ScrollView>
              </AppPressable>
            </AppPressable>
          </Modal>
          {/* Mutual groups */}

          {mutualGroups.length > 0 ? (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
              <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 8, fontWeight: '600' }}>ОБЩИЕ ГРУППЫ</Text>
              {mutualGroups.slice(0, 5).map((g) => (
                <View key={g.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: identityAvatar(g.id).fill, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: identityAvatar(g.id).ink, fontSize: 14, fontWeight: '700' }}>{nameInitial(g.name)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{g.name}</Text>
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>{membersLabel(g.memberCount)}</Text>
                  </View>
                </View>
              ))}
              {mutualGroups.length > 5 ? (
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>ещё {mutualGroups.length - 5}…</Text>
              ) : null}
            </View>
          ) : null}
          {/* Safety code */}
          {myPubB64 && myPubB64 !== peerB64 ? (
            <AppPressable
              style={{ paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
              onPress={() => {
                const code = computeSafetyCode(myPubB64, peerB64);
                Alert.alert(
                  'Ключ безопасности',
                  `Сравните этот код с кодом собеседника. Если коды совпадают — соединение защищено.\n\n${code}`,
                  [{ text: 'OK' }]
                );
              }}
            >
              <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>КЛЮЧ БЕЗОПАСНОСТИ</Text>
              <Text style={{ fontSize: 15, fontFamily: 'monospace', color: colors.text, letterSpacing: 1.5 }}>
                {computeSafetyCode(myPubB64, peerB64)}
              </Text>
            </AppPressable>
          ) : null}
          {/* Actions */}
          <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 }}
              onPress={() => { setRenameVisible(true); setNewName(displayName); }}
            >
              <Ionicons name="pencil-outline" size={22} color={colors.text} />
              <Text style={{ fontSize: 16, color: colors.text }}>Изменить имя</Text>
            </AppPressable>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 }}
              onPress={() => {
                if (initMuted) {
                  void setConversationMuted(peerB64, activeProfileId, false)
                    .then(() => muteUnset('chat', peerB64))
                    .then(() => onMuteChanged?.(false, null));
                } else {
                  const snooze = (ms: number | null) => async () => {
                    const u = ms === null ? null : Date.now() + ms;
                    await setConversationMutedUntil(peerB64, activeProfileId, u);
                    await muteSet('chat', peerB64, u !== null ? { untilMs: u } : undefined);
                    onMuteChanged?.(true, u);
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
              }}
            >
              <Ionicons name={initMuted ? 'notifications-outline' : 'notifications-off-outline'} size={22} color={colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, color: colors.text }}>{initMuted ? 'Включить звук' : 'Беззвучно…'}</Text>
                {initMuted && initMutedUntil ? (
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>до {dayMonthShortTime(initMutedUntil)}</Text>
                ) : initMuted ? (
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>навсегда</Text>
                ) : null}
              </View>
            </AppPressable>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 }}
              onPress={() => {
                const newVal = !notifyOnline;
                setNotifyOnline(newVal);
                void import('../../../../core/settings/privacyPrefs').then((m) => m.notifyOnlineSet(peerB64, newVal));
                if (newVal) showSuccess(`Уведомим, когда ${displayName} появится онлайн`);
              }}
            >
              <Ionicons name={notifyOnline ? 'notifications' : 'notifications-outline'} size={22} color={notifyOnline ? colors.accent : colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, color: colors.text }}>
                  {notifyOnline ? 'Уведомление: онлайн вкл.' : 'Уведомить когда онлайн'}
                </Text>
                {presence.bucket !== 'online' ? (
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>
                    {notifyOnline ? 'Получите уведомление при входе' : 'Сейчас не в сети'}
                  </Text>
                ) : (
                  <Text style={{ fontSize: 12, color: colors.success, marginTop: 1 }}>Сейчас онлайн</Text>
                )}
              </View>
              {notifyOnline ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
            </AppPressable>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 14, gap: 12 }}
              onPress={() => { setNoteDraft(contactNote); setNoteEditVisible(true); }}
            >
              <Ionicons name="document-text-outline" size={22} color={colors.text} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, color: colors.text }}>Заметка</Text>
                {contactNote ? (
                  <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }} numberOfLines={2}>{contactNote}</Text>
                ) : (
                  <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>Добавить личную заметку…</Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={{ marginTop: 4 }} />
            </AppPressable>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 }}
              onPress={() => {
                void (async () => {
                  try {
                    const { listAllChatMessages } = await import('../../../../core/storage/local');
                    const msgs = await listAllChatMessages({ contactPubB64: peerB64, ownerProfileId: activeProfileId });
                    // v4.32.604: заголовок обещает число сообщений, поэтому
                    // усечённая выгрузка врёт дважды. Либо всё, либо ничего.
                    if (!shouldApplyRows(msgs)) { showError('Не удалось прочитать переписку для экспорта'); return; }
                    const lines: string[] = [`Экспорт чата с ${displayName}`, `Дата: ${numericDate(Date.now())}`, `Сообщений: ${msgs.length}`, '─'.repeat(40), ''];
                    for (const m of msgs.slice().reverse()) {
                      const ts = fullDateTime(m.createdAt);
                      const sender = m.direction === 'out' ? 'Я' : displayName;
                      lines.push(`[${ts}] ${sender}: ${exportBody(m)}`);
                    }
                    // v4.32.310: имя `chat_<время>.txt` не подходило ни под один
                    // список уборки — расшифрованная переписка оседала в кэше
                    // навсегда. v4.32.313: и сама отдача теперь общая, см. cacheFiles.
                    const shared = await shareTextExport('chat', lines.join('\n'), `Чат с ${displayName}`, Date.now());
                    if (!shared) showError('Системное «Поделиться» недоступно');
                  } catch (e) {
                    showError(userErrorText(e, 'Ошибка экспорта'));
                  }
                })();
              }}
            >
              <Ionicons name="download-outline" size={22} color={colors.text} />
              <Text style={{ fontSize: 16, color: colors.text }}>Экспорт чата</Text>
            </AppPressable>
          </View>
        </AppPressable>
      </AppPressable>
      {/* Rename sub-modal */}
      <Modal visible={renameVisible} transparent animationType="fade" onRequestClose={() => setRenameVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: scrim.modal }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 20 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 12 }}>Изменить имя</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, color: colors.text, fontSize: 16, marginBottom: 16 }}
              value={newName}
              onChangeText={setNewName}
              autoFocus
              placeholderTextColor={colors.textMuted}
              placeholder="Новое имя…"
            />
            <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
              <AppPressable onPress={() => setRenameVisible(false)}>
                <Text style={{ color: colors.textMuted, fontSize: 15 }}>Отмена</Text>
              </AppPressable>
              <AppPressable onPress={() => void submitRename()}>
                <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>Сохранить</Text>
              </AppPressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      {/* Note edit sub-modal */}
      <Modal visible={noteEditVisible} transparent animationType="fade" onRequestClose={() => setNoteEditVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: scrim.modal }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 20 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 12 }}>Заметка о контакте</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, color: colors.text, fontSize: 15, marginBottom: 16, minHeight: 80, textAlignVertical: 'top' }}
              value={noteDraft}
              onChangeText={setNoteDraft}
              autoFocus
              multiline
              placeholderTextColor={colors.textMuted}
              placeholder="Личная заметка (видна только вам)…"
            />
            <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
              <AppPressable onPress={() => setNoteEditVisible(false)}>
                <Text style={{ color: colors.textMuted, fontSize: 15 }}>Отмена</Text>
              </AppPressable>
              {contactNote ? (
                <AppPressable onPress={() => {
                  // Строка удаляется целиком, а не затирается пустой: пустое
                  // значение — это всё ещё запись «здесь была заметка».
                  void import('../../../../core/storage/local').then((m) => m.kvDeleteScoped(activeProfileId, m.contactNoteKey(peerB64)));
                  setContactNote('');
                  setNoteEditVisible(false);
                }}>
                  <Text style={{ color: colors.error, fontSize: 15 }}>Удалить</Text>
                </AppPressable>
              ) : null}
              <AppPressable onPress={() => {
                // v4.32.552: раньше «Заметка сохранена» показывалось, не
                // дожидаясь записи, — и было неправдой всякий раз, когда
                // запись не удалась. Хуже того: не открывшаяся заметка
                // показывалась пустым полем, и сохранение пустоты уничтожало
                // текст. Теперь запись отклоняется, а человеку это сказано.
                const draft = noteDraft.trim();
                setNoteEditVisible(false);
                void (async () => {
                  const m = await import('../../../../core/storage/local');
                  const res = await m.kvUpdateSecretScoped(
                    activeProfileId,
                    m.contactNoteKey(peerB64),
                    () => draft
                  );
                  if (res === 'unreadable') { showError(SECRET_UNREADABLE_TEXT); return; }
                  if (res === 'failed') { showError('Не удалось сохранить заметку'); return; }
                  setContactNote(draft);
                  showSuccess('Заметка сохранена');
                })();
              }}>
                <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>Сохранить</Text>
              </AppPressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Modal>
  );
}
