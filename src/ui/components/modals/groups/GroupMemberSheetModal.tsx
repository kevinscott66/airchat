import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { type GroupMemberRow } from '../../../../core/storage/local';
import { nameInitial } from '../../../../core/social/contactLabel';
import { shownName } from '../../../../core/social/unreadableName';
import { roleLabel, roleTone } from '../../../../core/social/groupRolePolicy';
import { avatarShape, contrastingInk, font, identityAvatar, mono, radius, scrim } from '../../../theme';
import { shortIdentity } from '../../../identity/shortId';

export interface GroupMemberSheetModalProps {
  member: GroupMemberRow | null;
  onClose: () => void;
  amAdmin: boolean;
  myPubB64: string;
  onOpenDm?: (peerPubB64: string, displayName: string) => void;
  onToggleAdmin: (member: GroupMemberRow) => void;
  /**
   * Ограничить отправку сообщений (role='restricted') или снять ограничение.
   * v4.32.258: роль «только чтение» стала назначаемой, но добраться до неё
   * можно было лишь командой /mute в поле ввода — то есть зная, что такая
   * команда есть. Карточка участника, основной способ модерации, о ней
   * молчала, и единственной мерой к болтуну оставалось исключение.
   */
  onToggleMute: (member: GroupMemberRow) => void;
  onKick: (member: GroupMemberRow) => void;
  /**
   * Можно ли модерировать этого участника моей ролью (canModerate из
   * groupModerationPolicy). v4.32.255: «Исключить» показывалось всегда, в том
   * числе на владельце группы и на другом администраторе, — а такой конверт
   * у всех получателей отбрасывается. Кнопка, которая заведомо не сработает,
   * не должна показываться.
   */
  canModerateMember: (member: GroupMemberRow) => boolean;
}

function GroupMemberSheetModalImpl({
  member,
  onClose,
  amAdmin,
  myPubB64,
  onOpenDm,
  onToggleAdmin,
  onToggleMute,
  onKick,
  canModerateMember,
}: GroupMemberSheetModalProps) {
  const visible = !!member;
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  const stopPropagation = useCallback(() => { /* prevent dismiss */ }, []);
  /**
   * Одно условие на все три действия модерации. Раньше «Назначить» и
   * «Исключить» проверяли каждое своё, слегка разное (у первого была лишняя
   * проверка role !== 'owner', которую canModerate и так делает), — а третьего
   * действия не было вовсе.
   */
  const canModerateThis =
    !!member && amAdmin && member.peerPubB64 !== myPubB64 && canModerateMember(member);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <AppPressable style={[styles.memberSheet, { backgroundColor: colors.surface }]} onPress={stopPropagation}>
          {mounted && member ? (
            <>
              <View style={[styles.sheetHandle, { backgroundColor: colors.textMuted }]} />
              {(() => {
                const avatar = identityAvatar(member.peerPubB64);
                return (
                  <View style={[styles.avatar, { ...avatarShape(64), alignSelf: 'center', backgroundColor: avatar.fill }]}>
                    <Text style={{ color: avatar.ink, fontSize: 26, fontWeight: '600' }}>{nameInitial(member.displayName)}</Text>
                  </View>
                );
              })()}
              {/* v4.32.595: имя, которое не открылось ключом, подписывается
                  пометкой — карточка участника открывается ради решения о нём. */}
              <Text style={[styles.headerName, { color: member.displayNameUnreadable ? colors.warning : colors.text, textAlign: 'center', marginTop: 8 }]}>
                {shownName(member.displayName, member.displayNameUnreadable, shortIdentity(member.peerPubB64))}
              </Text>
              {roleLabel(member.role) ? (
                <Text style={[styles.role, { color: colors[roleTone(member.role) ?? 'textMuted'], textAlign: 'center', marginBottom: 4 }]}>
                  {roleLabel(member.role)}
                </Text>
              ) : null}
              <Text style={{ color: colors.textMuted, fontSize: font.xs, textAlign: 'center', fontFamily: mono, marginBottom: 16 }}>{shortIdentity(member.peerPubB64, 12)}</Text>
              <View style={{ gap: 8, paddingHorizontal: 16, paddingBottom: 24 }}>
                <AppPressable
                  style={[styles.sheetBtn, { backgroundColor: colors.primary }]}
                  onPress={() => {
                    const name = member.displayName ?? shortIdentity(member.peerPubB64);
                    onClose();
                    if (onOpenDm) {
                      onOpenDm(member.peerPubB64, name);
                    } else {
                      void Share.share({ message: member.peerPubB64 });
                    }
                  }}
                >
                  <Ionicons name="chatbubble-outline" size={18} color={contrastingInk(colors.primary)} />
                  <Text style={{ color: contrastingInk(colors.primary), fontSize: 14, fontWeight: '600', marginLeft: 6 }}>Написать</Text>
                </AppPressable>
                {canModerateThis ? (
                  <>
                    <AppPressable
                      style={[styles.actionRow, { backgroundColor: colors.surfaceHigh }]}
                      onPress={() => onToggleAdmin(member)}
                    >
                      <Ionicons
                        name={member.role === 'admin' ? 'remove-circle-outline' : 'shield-checkmark-outline'}
                        size={19}
                        color={colors.text}
                      />
                      <Text style={[styles.actionLabel, { color: colors.text }]}>
                        {member.role === 'admin' ? 'Снять права администратора' : 'Назначить администратором'}
                      </Text>
                    </AppPressable>
                    <AppPressable
                      style={[styles.actionRow, { backgroundColor: colors.surfaceHigh }]}
                      onPress={() => onToggleMute(member)}
                    >
                      <Ionicons
                        name={member.role === 'restricted' ? 'chatbox-ellipses-outline' : 'ban-outline'}
                        size={19}
                        color={colors.text}
                      />
                      <Text style={[styles.actionLabel, { color: colors.text }]}>
                        {member.role === 'restricted' ? 'Разрешить писать' : 'Запретить писать'}
                      </Text>
                    </AppPressable>
                    <AppPressable
                      style={[styles.actionRow, { backgroundColor: colors.surfaceHigh }]}
                      onPress={() => { onKick(member); onClose(); }}
                    >
                      {/* v4.32.383: было '#ff3b30' — системный красный Apple,
                          задуманный как заливка: на белом фоне светлой темы
                          3.2:1 при пороге 4.5:1. `error` в палитре для того и
                          заведён. */}
                      <Ionicons name="person-remove-outline" size={19} color={colors.error} />
                      <Text style={[styles.actionLabel, { color: colors.error }]}>Исключить из группы</Text>
                    </AppPressable>
                  </>
                ) : null}
              </View>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: scrim.modal },
  memberSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 12, paddingHorizontal: 16 },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  headerName: { fontSize: 17, fontWeight: '600' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  role: { fontSize: 12, marginTop: 1 },
  sheetBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: radius.lg, paddingVertical: 12 },
  /**
   * Действия модерации идут списком, а не в ряд: их стало три, и в одну
   * строку помещались только огрызки подписей («Снять», «Назначить»), по
   * которым не понять, что именно снимут.
   */
  actionRow: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.lg, paddingVertical: 13, paddingHorizontal: 14 },
  actionLabel: { fontSize: 15, fontWeight: '500', marginLeft: 10 },
});

export const GroupMemberSheetModal = memo(GroupMemberSheetModalImpl);
