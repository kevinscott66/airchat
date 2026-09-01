import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { KeyboardHost } from '../../KeyboardHost';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { primaryInk } from '../../../theme';
import type { KeyPairBytes } from '../../../../core/crypto/keyManager';
import { listContacts, type Contact } from '../../../../core/social/contacts';
import { groupSendProblem, groupSendProblemShort } from '../../../../core/social/groupSendOutcome';
import { getMessagingService } from '../../../../core/social/messaging';
import {
  listGroups,
  insertGroupMessage,
  touchGroupConversation,
  type GroupRow,
} from '../../../../core/storage/local';
import { profileManager } from '../../../../core/identity/profileManager';
import { showError, showSuccess } from '../../userFeedback';
import { ruPlural } from '../../../utils/plural';
import { contactLabel, nameInitial } from '../../../../core/social/contactLabel';
import { shortIdentity } from '../../../identity/shortId';
import { userErrorText } from '../../userErrorText';

// ─── Forward Message Modal ────────────────────────────────────────────────────
export function ForwardModal({
  visible,
  text,
  pair,
  onClose,
  onForwarded,
}: {
  visible: boolean;
  text: string;
  pair: KeyPairBytes;
  onClose: () => void;
  onForwarded: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [sending, setSending] = useState(false);
  const [fwdSearch, setFwdSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fwdComment, setFwdComment] = useState('');
  const pid = profileManager.getActiveProfile()?.id ?? 1;

  useEffect(() => {
    if (!visible) return;
    setFwdSearch('');
    setSelected(new Set());
    setFwdComment('');
    void listContacts().then(setContacts);
    void listGroups(pid).then(setGroups);
  }, [visible, pid]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sendToSelected = async () => {
    if (sending || selected.size === 0) return;
    setSending(true);
    try {
      const svc = getMessagingService();
      const myPub = Buffer.from(pair.publicKey).toString('base64');
      const myName = (await import('../../../../core/identity/ownProfile').then((m) => m.getOwnDisplayName())) ?? 'Я';
      const { v4: uuidv4 } = await import('uuid');
      const comment = fwdComment.trim();
      const msgText = comment ? `${comment}\n\n${text}` : text;
      // v4.32.270: считаем реально ушедшее, а не размер выделения. Раньше
      // «Переслано в N чатов» печаталось по selected.size — независимо от того,
      // отказала ли группа в праве писать и был ли вообще транспорт для лички.
      let sent = 0;
      const denied: string[] = [];
      for (const id of selected) {
        const contact = contacts.find((c) => c.peerPublicKey === id);
        const group = groups.find((g) => g.id === id);
        if (contact) {
          // v4.32.335: до этой версии личка считалась отправленной по факту
          // вызова. sendMessage возвращает null, когда отправки не было —
          // контакт заблокирован или упёрлись в часовой лимит, — и такой
          // контакт всё равно попадал в «Переслано в N чатов». Ровно то, что
          // v4.32.270 починил для групп, но не для лички, хотя в комментарии
          // рядом было написано обратное.
          const id = svc ? await svc.sendMessage(contact.peerPublicKey, msgText) : null;
          if (id) sent += 1;
          else denied.push(`«${contactLabel(contact.displayName, shortIdentity(contact.peerPublicKey))}» — не удалось отправить`);
        } else if (group) {
          // v4.32.270: список групп в пересылке — все группы подряд, включая
          // те, где писать нельзя: канал без прав администратора, «только для
          // админов», роль restricted, бан. Раньше строка писалась в историю и
          // показывалось «Переслано», а рассылка молча отказывала: у автора
          // сообщение есть, в группе его нет, и узнать об этом было неоткуда.
          const { fanoutGroupMessage, groupSendVerdict } = await import('../../../../core/social/groupMessaging');
          const verdict = await groupSendVerdict(group.id, myPub, msgText);
          if (!verdict.allowed) {
            denied.push(`«${group.name}» — ${verdict.reason.toLowerCase()}`);
            continue;
          }
          const row = { id: uuidv4(), groupId: group.id, senderPubB64: myPub, senderName: myName, text: msgText, mediaCids: null, replyToId: null, replyToPreview: null, reactions: null, createdAt: Date.now(), ownerProfileId: pid };
          await insertGroupMessage(row);
          await touchGroupConversation(group.id, pid, msgText.slice(0, 120), false, myName, false, myPub);
          // v4.32.450: вердикт выше отвечает на «можно ли», а рассылка — на
          // «ушло ли». Между ними связь могла пропасть, и «Переслано в 3 чата»
          // считало такой чат наравне с остальными.
          const problem = groupSendProblem(
            await fanoutGroupMessage(group.id, msgText, myName, myPub, row.id)
          );
          if (problem) denied.push(`«${group.name}» — ${groupSendProblemShort(problem)}`);
          else sent += 1;
        }
      }
      if (sent > 0) showSuccess(`Переслано в ${sent} ${ruPlural(sent, ['чат', 'чата', 'чатов'])}`);
      if (denied.length > 0) showError(`Не отправлено: ${denied.join('; ')}`);
      onForwarded();
      onClose();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось переслать'));
    } finally {
      setSending(false);
    }
  };

  type FwdItem = { kind: 'contact'; c: Contact } | { kind: 'group'; g: GroupRow } | { kind: 'section'; label: string };
  const lq = fwdSearch.toLowerCase();
  const filteredContacts = lq ? contacts.filter((c) => (c.displayName ?? '').toLowerCase().includes(lq)) : contacts;
  const filteredGroups = lq ? groups.filter((g) => g.name.toLowerCase().includes(lq)) : groups;
  const listData: FwdItem[] = [
    ...(filteredContacts.length > 0 ? [{ kind: 'section' as const, label: 'Личные чаты' }] : []),
    ...filteredContacts.map((c): FwdItem => ({ kind: 'contact', c })),
    ...(filteredGroups.length > 0 ? [{ kind: 'section' as const, label: 'Группы и каналы' }] : []),
    ...filteredGroups.map((g): FwdItem => ({ kind: 'group', g })),
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardHost variant="modal">
      <View style={[fwdStyles.root, { backgroundColor: colors.background }]}>
        <View style={[fwdStyles.header, { borderBottomColor: colors.border }]}>
          <AppPressable onPress={onClose} style={fwdStyles.cancelBtn}>
            <Text style={{ color: colors.accent }}>Отмена</Text>
          </AppPressable>
          <Text style={[fwdStyles.title, { color: colors.text }]}>Переслать</Text>
          {selected.size > 0 ? (
            <AppPressable onPress={() => void sendToSelected()} style={[fwdStyles.cancelBtn, { alignItems: 'flex-end' }]} disabled={sending}>
              {sending ? <ActivityIndicator size="small" color={colors.accent} /> : <Ionicons name="send" size={20} color={colors.accent} />}
            </AppPressable>
          ) : (
            <View style={{ width: 60 }} />
          )}
        </View>
        {selected.size > 0 ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.surfaceHigh }}>
            <Text style={{ fontSize: 13, color: colors.accent, fontWeight: '600' }}>
              Выбрано: {selected.size} {selected.size === 1 ? 'чат' : selected.size < 5 ? 'чата' : 'чатов'}
            </Text>
          </View>
        ) : null}
        <View style={[fwdStyles.preview, { backgroundColor: colors.surfaceHigh }]}>
          <Text style={[fwdStyles.previewText, { color: colors.textSecondary }]} numberOfLines={3}>{text}</Text>
        </View>
        <View style={[fwdStyles.searchBar, { backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}>
          <Ionicons name="search" size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
          <TextInput
            value={fwdSearch}
            onChangeText={setFwdSearch}
            placeholder="Поиск…"
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, color: colors.text, fontSize: 15 }}
          />
          {fwdSearch ? (
            <AppPressable onPress={() => setFwdSearch('')}><Ionicons name="close-circle" size={16} color={colors.textMuted} /></AppPressable>
          ) : null}
        </View>
        <FlatList
          data={listData}
          keyExtractor={(item, i) =>
            item.kind === 'contact' ? item.c.peerPublicKey
            : item.kind === 'group' ? item.g.id
            : `sec_${i}`
          }
          renderItem={({ item }) => {
            if (item.kind === 'section') {
              return <Text style={[fwdStyles.section, { color: colors.textMuted }]}>{item.label}</Text>;
            }
            const id = item.kind === 'contact' ? item.c.peerPublicKey : item.g.id;
            const name = item.kind === 'contact' ? item.c.displayName : item.g.name;
            const isSelected = selected.has(id);
            return (
              <AppPressable
                style={[fwdStyles.row, { borderBottomColor: colors.border }]}
                onPress={() => toggleSelect(id)}
              >
                <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: isSelected ? colors.primary : colors.surfaceHigh, borderWidth: isSelected ? 0 : 1, borderColor: colors.border }}>
                  {isSelected ? <Ionicons name="checkmark" size={16} color={primaryInk(colors).text} /> : <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textMuted }}>{nameInitial(name)}</Text>}
                </View>
                <Text style={[fwdStyles.name, { color: colors.text, flex: 1, marginLeft: 10 }]}>{name}</Text>
              </AppPressable>
            );
          }}
          ListEmptyComponent={
            <Text style={[fwdStyles.empty, { color: colors.textMuted }]}>Нет контактов</Text>
          }
        />
        {selected.size > 0 ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceHigh, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 6, minHeight: 40 }}>
              <Ionicons name="chatbubble-outline" size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
              <TextInput
                value={fwdComment}
                onChangeText={setFwdComment}
                placeholder="Добавить комментарий…"
                placeholderTextColor={colors.textMuted}
                style={{ flex: 1, color: colors.text, fontSize: 14, maxHeight: 80 }}
                multiline
                returnKeyType="default"
              />
              {fwdComment.length > 0 ? (
                <AppPressable onPress={() => setFwdComment('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                </AppPressable>
              ) : null}
            </View>
            <AppPressable
              style={{ backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' }}
              onPress={() => void sendToSelected()}
              disabled={sending}
            >
              {sending
                ? <ActivityIndicator color={primaryInk(colors).text} />
                : <Text style={{ color: primaryInk(colors).text, fontSize: 16, fontWeight: '600' }}>
                    Переслать в {selected.size} {selected.size === 1 ? 'чат' : selected.size < 5 ? 'чата' : 'чатов'}
                  </Text>
              }
            </AppPressable>
          </View>
        ) : null}
      </View>
      </KeyboardHost>
    </Modal>
  );
}

const fwdStyles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cancelBtn: { width: 60 },
  title: { fontSize: 17, fontWeight: '600' },
  preview: { margin: 16, borderRadius: 10, padding: 12 },
  previewText: { fontSize: 14, fontStyle: 'italic' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  name: { fontSize: 16 },
  section: { fontSize: 12, fontWeight: '600', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
  searchBar: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 8 },
});
