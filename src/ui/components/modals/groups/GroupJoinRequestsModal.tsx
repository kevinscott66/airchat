import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { type GroupJoinRequest } from '../../../../core/storage/local';
import { nameInitial } from '../../../../core/social/contactLabel';
import { contrastingInk, identityAvatar, scrim } from '../../../theme';
import { shortIdentity } from '../../../identity/shortId';
import { numericDate } from '../../../../core/time/ruDateTime';
import { shownName } from '../../../../core/social/unreadableName';
import { UNREADABLE_MESSAGE_TEXT } from '../../../../core/storage/unreadableText';

export interface GroupJoinRequestsModalProps {
  visible: boolean;
  onClose: () => void;
  groupId: string;
  joinRequests: GroupJoinRequest[];
  onApprove: (req: GroupJoinRequest) => void;
  onReject: (req: GroupJoinRequest) => void;
}

function GroupJoinRequestsModalImpl({ visible, onClose, joinRequests, onApprove, onReject }: GroupJoinRequestsModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  const stopPropagation = useCallback(() => { /* prevent dismiss */ }, []);
  const pendingCount = joinRequests.length;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <AppPressable style={[styles.memberSheet, { backgroundColor: colors.surface, maxHeight: '80%' }]} onPress={stopPropagation}>
          {mounted ? (
            <>
              <View style={[styles.sheetHandle, { backgroundColor: colors.textMuted }]} />
              <Text style={[styles.headerName, { color: colors.text, marginBottom: 12 }]}>Запросы на вступление ({pendingCount})</Text>
              <FlatList
                data={joinRequests}
                keyExtractor={(r) => r.id}
                renderItem={({ item }) => (
                  <View style={[styles.row, { borderBottomColor: colors.border }]}>
                    <View style={[styles.avatar, { backgroundColor: identityAvatar(item.requesterPubB64).fill }]}>
                      <Text style={[styles.avatarLetter, { color: identityAvatar(item.requesterPubB64).ink }]}>{nameInitial(item.requesterName)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      {/* v4.32.594: заявку принимают, глядя на имя и на
                          сопроводительное сообщение. Непрочитанное имя молча
                          подменялось коротким ключом, а непрочитанное
                          сообщение не рисовалось вовсе — решение принималось
                          по неполной картинке, и об этом никто не сообщал. */}
                      <Text style={[styles.name, { color: item.requesterNameUnreadable ? colors.warning : colors.text }]}>
                        {shownName(item.requesterName, item.requesterNameUnreadable, shortIdentity(item.requesterPubB64))}
                      </Text>
                      {item.messageUnreadable ? (
                        <Text style={{ color: colors.warning, fontSize: 12 }}>{UNREADABLE_MESSAGE_TEXT}</Text>
                      ) : item.message ? (
                        <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={2}>{item.message}</Text>
                      ) : null}
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>{numericDate(item.createdAt)}</Text>
                    </View>
                    <AppPressable
                      style={{ backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginRight: 4 }}
                      onPress={() => onApprove(item)}
                    >
                      <Text style={{ color: contrastingInk(colors.primary), fontSize: 13, fontWeight: '600' }}>Принять</Text>
                    </AppPressable>
                    <AppPressable
                      style={{ backgroundColor: colors.surfaceHigh, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
                      onPress={() => onReject(item)}
                    >
                      <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>Отклонить</Text>
                    </AppPressable>
                  </View>
                )}
                ListEmptyComponent={<Text style={{ color: colors.textMuted, textAlign: 'center', paddingVertical: 24 }}>Нет запросов</Text>}
                style={{ maxHeight: 400 }}
              />
              <AppPressable style={styles.closeBtn} onPress={onClose}>
                <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>Закрыть</Text>
              </AppPressable>
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
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontSize: 18, fontWeight: '600' },
  name: { fontSize: 15, fontWeight: '500' },
  closeBtn: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
});

export const GroupJoinRequestsModal = memo(GroupJoinRequestsModalImpl);
