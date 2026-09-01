import React from 'react';
import { View, Text } from 'react-native';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { identityAvatar, scrim } from '../../../theme';
import type { GroupMessageRow, GroupMemberRow } from '../../../../core/storage/local';
import { contactLabel, nameInitial } from '../../../../core/social/contactLabel';
import { shortIdentity } from '../../../identity/shortId';
import { UNREADABLE_VIEWERS_TEXT } from '../../../../core/storage/unreadableText';

export interface GroupSeenByModalProps {
  msg: GroupMessageRow | null;
  allMembers: GroupMemberRow[];
  onClose: () => void;
}

function GroupSeenByModalImpl({ msg, allMembers, onClose }: GroupSeenByModalProps): React.ReactElement | null {
  const { colors } = useTheme();
  if (!msg) return null;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <AppPressable style={{ flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', alignItems: 'center', padding: 24 }} onPress={onClose}>
        <AppPressable onPress={() => {}} style={{ borderRadius: 14, paddingVertical: 20, paddingHorizontal: 24, minWidth: 220, maxWidth: 340, backgroundColor: colors.surface, gap: 10 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Прочитали</Text>
          {(msg.seenBy ?? []).map((pub) => {
            const member = allMembers.find((m) => m.peerPubB64 === pub);
            const name = contactLabel(member?.displayName, shortIdentity(pub));
            // v4.32.409: кружок — различитель личности, а не общая заливка.
            const circle = identityAvatar(pub);
            return (
              <View key={pub} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: circle.fill, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: circle.ink, fontWeight: '700', fontSize: 14 }}>{nameInitial(name)}</Text>
                </View>
                <Text style={{ fontSize: 15, color: colors.text }}>{name}</Text>
              </View>
            );
          })}
          {/* v4.32.591: непрочитанный столбец — не то же самое, что пустой
              список. Раньше здесь стояло «Никто ещё не прочитал» при
              записанных прочтениях, и опровергнуть это было нечем. */}
          {msg.seenUnreadable ? (
            <Text style={{ color: colors.warning, fontSize: 14 }}>{UNREADABLE_VIEWERS_TEXT}</Text>
          ) : (msg.seenBy?.length ?? 0) === 0 ? (
            <Text style={{ color: colors.textMuted, fontSize: 14 }}>Никто ещё не прочитал</Text>
          ) : null}
          <AppPressable
            onPress={onClose}
            style={{ marginTop: 8, paddingHorizontal: 24, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignSelf: 'center' }}
          >
            <Text style={{ color: colors.text, fontSize: 14 }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

export const GroupSeenByModal = React.memo(GroupSeenByModalImpl);
