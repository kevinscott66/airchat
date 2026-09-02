import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Buffer } from 'buffer';
import { v4 as uuidv4 } from 'uuid';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../../ThemeContext';
import { announceCtl } from '../../../groupControlAnnounce';
import { primaryInk, radius } from '../../../theme';
import type { KeyPairBytes } from '../../../../core/crypto/keyManager';
import { listContacts, type Contact } from '../../../../core/social/contacts';
import {
  createGroup,
  getGroup,
  upsertGroupMember,
  recountGroupMembers,
  type GroupRow,
  type GroupType,
} from '../../../../core/storage/local';
import { profileManager } from '../../../../core/identity/profileManager';
import { getOwnDisplayName } from '../../../../core/identity/ownProfile';
import { showError, showSuccess } from '../../userFeedback';
import { insertGroupSysMessage } from '../../../utils/groupSysMessage';
import { displayNameOrNull } from '../../../../core/social/sysLineGuard';
import { userErrorText } from '../../userErrorText';
import {
  OWN_GROUP_DESC_MAX,
  OWN_GROUP_NAME_MAX,
  normalizeOwnGroupDescription,
  normalizeOwnGroupName,
} from '../../../../core/social/groupNameRule';

export function CreateGroupModal({
  visible,
  pair,
  onClose,
  onCreated,
}: {
  visible: boolean;
  pair?: KeyPairBytes;
  onClose: () => void;
  onCreated: (group: GroupRow) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<GroupType>('group');
  const [busy, setBusy] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedPeers, setSelectedPeers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (visible && pair) {
      const myPubB64 = Buffer.from(pair.publicKey).toString('base64');
      void listContacts().then((all) =>
        setContacts(all.filter((c) => c.peerPublicKey !== myPubB64))
      );
    }
  }, [visible, pair]);

  const reset = () => { setName(''); setDescription(''); setType('group'); setSelectedPeers(new Set()); };

  const submit = async () => {
    /**
     * v4.32.379: название и описание чистятся тем же правилом, что и пришедшие
     * по сети (см. groupNameRule). Здесь их не чистили вовсе и не ограничивали
     * по длине — при том, что оба уезжают приглашением, а приглашение с
     * названием, от которого после чистки ничего не остаётся, получатель
     * отбрасывает целиком. То есть группа с названием из одних невидимых
     * символов создавалась, показывала выбранных участников в своём списке — а
     * на их устройствах не заводилась вообще, и их сообщения молча пропадали
     * как «неизвестная группа». Ровно то, что чинили в v4.32.231, только
     * заходом со своей стороны.
     */
    const cleanName = normalizeOwnGroupName(name);
    const cleanDesc = normalizeOwnGroupDescription(description);
    if (!cleanName) { Alert.alert('AirChat', 'Введите название'); return; }
    if (!pair) { Alert.alert('AirChat', 'Нет активного профиля'); return; }
    setBusy(true);
    try {
      const pid = profileManager.getActiveProfile()?.id ?? 1;
      const id = uuidv4();
      await createGroup(id, pid, cleanName, type, cleanDesc || undefined);
      // Add self as owner
      const myPubB64 = Buffer.from(pair.publicKey).toString('base64');
      await upsertGroupMember({
        groupId: id, peerPubB64: myPubB64, role: 'owner',
        displayName: 'Вы', joinedAt: Date.now(), ownerProfileId: pid,
      });
      // Add selected contacts
      for (const pubB64 of selectedPeers) {
        const ct = contacts.find((c) => c.peerPublicKey === pubB64);
        await upsertGroupMember({
          groupId: id, peerPubB64: pubB64, role: 'member',
          displayName: displayNameOrNull(ct?.displayName), joinedAt: Date.now(), ownerProfileId: pid,
        });
      }
      // v4.32.267: не «1 + выбранные», а пересчёт по записанным строкам —
      // иначе контакт, попавший в выбор дважды (совпавший ключ), считался бы
      // двумя участниками, хотя строка в group_members у него одна.
      await recountGroupMembers(id, pid);
      // System welcome message
      const myDisplayNameCreate = (await getOwnDisplayName()) ?? 'Вы';
      // createdAt на миллисекунду раньше: строка «создал(а) группу» обязана
      // стоять выше первого настоящего сообщения.
      await insertGroupSysMessage(id, pid, Buffer.from(pair.publicKey).toString('base64'), `${myDisplayNameCreate} создал(а) группу «${cleanName}»`, Date.now() - 1);
      // v4.32.231: выбор контактов при создании группы был декорацией — они
      // записывались только в БД создателя, их устройства о группе не знали и
      // отбрасывали входящие сообщения как «unknown_group». Рассылаем
      // приглашение со снимком группы.
      if (selectedPeers.size) {
        const { sendGroupInvite } = await import('../../../../core/social/groupMessaging');
        const invited = [...selectedPeers].map((pubB64) => ({
          pub: pubB64,
          name: displayNameOrNull(contacts.find((c) => c.peerPublicKey === pubB64)?.displayName),
        }));
        // v4.32.451: приглашение уходит фоном (окно не должно ждать сети), но
        // молча больше не пропадает: не ушло — человек узнает, что выбранные
        // контакты группы у себя не увидят и их сообщения к нему не придут.
        announceCtl(sendGroupInvite(id, cleanName, type, invited, [...selectedPeers], myDisplayNameCreate));
      }
      const group = await getGroup(id, pid);
      if (group) { showSuccess('Группа создана'); onCreated(group); }
      reset();
      onClose();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось создать группу'));
    } finally {
      setBusy(false);
    }
  };

  const togglePeer = (pubB64: string) => {
    setSelectedPeers((prev) => {
      const next = new Set(prev);
      if (next.has(pubB64)) next.delete(pubB64); else next.add(pubB64);
      return next;
    });
  };

  // v4.32.227 (BUG-10): presentationStyle="pageSheet" не поддерживается на
  // Android — при первом visible=true native-контейнер пересоздаётся и первый
  // тап «теряется» (кнопка «+» открывала модалку только со второго раза).
  // На Android используем дефолтный full-screen modal; pageSheet — только iOS.
  return (
    <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[cgStyles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
          <View style={[cgStyles.header, { borderBottomColor: colors.border }]}>
            <AppPressable onPress={() => { reset(); onClose(); }} style={cgStyles.side}>
              <Text style={{ color: colors.accent, fontSize: 16 }}>Отмена</Text>
            </AppPressable>
            <Text style={[cgStyles.title, { color: colors.text }]}>Новая группа</Text>
            <AppPressable onPress={() => void submit()} style={[cgStyles.side, { alignItems: 'flex-end' }]} disabled={busy}>
              {busy ? <ActivityIndicator color={colors.accent} /> : (
                <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>Создать</Text>
              )}
            </AppPressable>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={cgStyles.body} keyboardShouldPersistTaps="handled">
            {/* Type selector */}
            <View style={[cgStyles.typeRow, { borderColor: colors.border }]}>
              {(['group', 'channel'] as GroupType[]).map((t) => (
                <AppPressable
                  key={t}
                  style={[cgStyles.typeBtn, { borderColor: colors.mutedFill }, type === t && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={() => setType(t)}
                >
                  <Ionicons
                    name={t === 'channel' ? 'megaphone-outline' : 'people-outline'}
                    size={16}
                    color={type === t ? primaryInk(colors).text : colors.text}
                    style={{ marginRight: 4 }}
                  />
                  <Text style={{ color: type === t ? primaryInk(colors).text : colors.text, fontWeight: '500' }}>
                    {t === 'channel' ? 'Канал' : 'Группа'}
                  </Text>
                </AppPressable>
              ))}
            </View>
            <Text style={[cgStyles.label, { color: colors.textSecondary }]}>Название *</Text>
            <TextInput
              style={[cgStyles.input, { color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
              value={name}
              onChangeText={setName}
              placeholder={type === 'channel' ? 'Название канала' : 'Название группы'}
              placeholderTextColor={colors.textMuted}
              maxLength={OWN_GROUP_NAME_MAX}
            />
            <Text style={[cgStyles.label, { color: colors.textSecondary }]}>Описание</Text>
            <TextInput
              style={[cgStyles.input, { color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
              value={description}
              onChangeText={setDescription}
              placeholder="Необязательно"
              placeholderTextColor={colors.textMuted}
              maxLength={OWN_GROUP_DESC_MAX}
              multiline
            />
            {type === 'group' && contacts.length > 0 ? (
              <>
                <Text style={[cgStyles.label, { color: colors.textSecondary }]}>Добавить участников</Text>
                {contacts.map((c) => (
                  <AppPressable
                    key={c.peerPublicKey}
                    style={[cgStyles.contactRow, { borderColor: colors.border }]}
                    onPress={() => togglePeer(c.peerPublicKey)}
                  >
                    <View style={[cgStyles.checkbox, { borderColor: colors.mutedFill }, selectedPeers.has(c.peerPublicKey) && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
                      {selectedPeers.has(c.peerPublicKey) ? <Ionicons name="checkmark" size={14} color={primaryInk(colors).text} /> : null}
                    </View>
                    <Text style={{ color: colors.text, fontSize: 15, flex: 1 }}>{c.displayName}</Text>
                  </AppPressable>
                ))}
              </>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const cgStyles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  side: { minWidth: 70 },
  title: { fontSize: 17, fontWeight: '600' },
  body: { padding: 20, gap: 8 },
  label: { fontSize: 13, marginBottom: 2, marginTop: 12 },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  // v4.32.418: контуры незанятой кнопки и пустого квадратика были вписаны
  // как '#444' и '#666' — в тёмной теме это 1.80:1 и 3.06:1 к поверхности,
  // то есть невыбранный тип группы почти не виден. Цвет переехал на место
  // вызова и берётся из `mutedFill` — токена «заливка, которую видно».
  typeBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.xl, backgroundColor: 'transparent', borderWidth: 1 },
  contactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
