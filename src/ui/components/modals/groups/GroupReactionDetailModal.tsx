import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { avatarShape, badgeTint, radius, scrim } from '../../../theme';
import type { GroupMemberRow } from '../../../../core/storage/local';
import { nameInitial } from '../../../../core/social/contactLabel';
import { shortIdentity } from '../../../identity/shortId';

export function GroupReactionDetailModal({
  target,
  myPubB64,
  allMembers,
  onClose,
}: {
  target: { activeEmoji: string; map: Record<string, string[]> } | null;
  myPubB64: string;
  allMembers: GroupMemberRow[];
  onClose: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.409: плашка выбранной вкладки — от поверхности окна, счётчик — от плашки.
  const tabTint = badgeTint(colors, 'accent', colors.surface);
  const [activeTab, setActiveTab] = useState(target?.activeEmoji ?? '');
  useEffect(() => { if (target) setActiveTab(target.activeEmoji); }, [target]);

  const entries = Object.entries(target?.map ?? {}).filter(([, u]) => u.length > 0);
  const activeUsers = (target?.map ?? {})[activeTab] ?? [];

  function pubToName(pub: string): string {
    if (pub === myPubB64) return 'Вы';
    return allMembers.find((m) => m.peerPubB64 === pub)?.displayName ?? shortIdentity(pub);
  }

  return (
    <Modal transparent animationType="fade" visible={target !== null} onRequestClose={onClose}>
      <AppPressable style={{ flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', alignItems: 'center', padding: 24 }} onPress={onClose}>
        <AppPressable onPress={(e) => e.stopPropagation()} style={{ borderRadius: radius.lg, paddingVertical: 20, paddingHorizontal: 24, width: 300, maxWidth: '90%', alignItems: 'center', gap: 10, backgroundColor: colors.surface }}>
          {/* Emoji tabs */}
          {entries.length > 1 ? (
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
              {entries.map(([emoji, users]) => (
                <AppPressable
                  key={emoji}
                  onPress={() => setActiveTab(emoji)}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.xl, borderWidth: 1.5, borderColor: activeTab === emoji ? colors.accent : colors.border, backgroundColor: activeTab === emoji ? tabTint.fill : 'transparent' }}
                >
                  <Text style={{ fontSize: 18 }}>{emoji}</Text>
                  <Text style={{ fontSize: 12, color: activeTab === emoji ? tabTint.ink : colors.textMuted, marginLeft: 4, fontWeight: '600' }}>{users.length}</Text>
                </AppPressable>
              ))}
            </View>
          ) : (
            <Text style={{ fontSize: 28 }}>{activeTab}</Text>
          )}
          {/* Users */}
          <View style={{ width: '100%', maxHeight: 200 }}>
            <ScrollView showsVerticalScrollIndicator={false}>
              {activeUsers.map((pub) => (
                <View key={pub} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 }}>
                  <View style={{ ...avatarShape(32), backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 14 }}>{nameInitial(pubToName(pub))}</Text>
                  </View>
                  <Text style={{ color: colors.text, fontSize: 15 }}>{pubToName(pub)}</Text>
                </View>
              ))}
              {activeUsers.length === 0 ? (
                <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 14, paddingVertical: 12 }}>Нет данных</Text>
              ) : null}
            </ScrollView>
          </View>
          <AppPressable onPress={onClose} style={{ marginTop: 4, paddingHorizontal: 24, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }}>
            <Text style={{ color: colors.text, fontSize: 14 }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}
