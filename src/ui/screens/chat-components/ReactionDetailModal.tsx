import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Buffer } from 'buffer';
import type { Contact } from '../../../core/social/contacts';
import { contactLabel, nameInitial } from '../../../core/social/contactLabel';
import { AppModal as Modal } from '../../components/AppModal';
import { AppPressable } from '../../components/AppPressable';
import { useTheme } from '../../ThemeContext';
import { avatarShape, badgeTint, radius, scrim } from '../../theme';
import { shortIdentity } from '../../identity/shortId';

// ─── Reaction detail modal (who reacted) ─────────────────────────────────────
export function ReactionDetailModal({
  target,
  contacts,
  myDid,
  onClose,
}: {
  target: { activeEmoji: string; map: Record<string, string[]> } | null;
  contacts: Contact[];
  myDid: string;
  onClose: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.409: активная вкладка эмодзи. Лист лежит на поверхности.
  const tabTint = useMemo(() => badgeTint(colors, 'accent', colors.surface), [colors]);
  const { parseDidKey: parseDid } = require('../../../core/identity/did') as typeof import('../../../core/identity/did');
  const [activeTab, setActiveTab] = useState<string>('');

  // Update active tab when target changes
  useEffect(() => {
    if (target) setActiveTab(target.activeEmoji);
  }, [target]);

  function didToName(did: string): string {
    if (did === myDid) return 'Вы';
    try {
      const pk = parseDid(did);
      if (!pk) return shortIdentity(did);
      const b64 = Buffer.from(pk).toString('base64');
      const c = contacts.find((x) => x.peerPublicKey === b64);
      return contactLabel(c?.displayName, shortIdentity(did));
    } catch {
      return shortIdentity(did);
    }
  }

  const entries = Object.entries(target?.map ?? {}).filter(([, d]) => d.length > 0);
  const activeDids = (target?.map ?? {})[activeTab] ?? [];

  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <AppPressable style={rdStyles.overlay} onPress={onClose}>
        <AppPressable style={[rdStyles.sheet, { backgroundColor: colors.surface }]} onPress={(e) => e.stopPropagation()}>
          {/* Emoji tabs */}
          {entries.length > 1 ? (
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
              {entries.map(([emoji, dids]) => (
                <AppPressable
                  key={emoji}
                  onPress={() => setActiveTab(emoji)}
                  style={[
                    rdStyles.tab,
                    { borderColor: activeTab === emoji ? colors.accent : colors.border, backgroundColor: activeTab === emoji ? tabTint.fill : 'transparent' },
                  ]}
                >
                  <Text style={{ fontSize: 18 }}>{emoji}</Text>
                  <Text style={{ fontSize: 12, color: activeTab === emoji ? tabTint.ink : colors.textMuted, marginLeft: 4, fontWeight: '600' }}>{dids.length}</Text>
                </AppPressable>
              ))}
            </View>
          ) : (
            <Text style={[rdStyles.heading, { color: colors.text }]}>
              {activeTab || (target?.activeEmoji ?? '')} Реакция
            </Text>
          )}
          {/* Users list */}
          <View style={{ width: '100%', maxHeight: 200 }}>
            <ScrollView showsVerticalScrollIndicator={false}>
              {activeDids.map((did) => (
                <View key={did} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 }}>
                  <View style={{ ...avatarShape(32), backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 14 }}>{nameInitial(didToName(did))}</Text>
                  </View>
                  <Text style={{ color: colors.text, fontSize: 15 }}>{didToName(did)}</Text>
                </View>
              ))}
              {activeDids.length === 0 ? (
                <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 14, paddingVertical: 12 }}>Нет данных</Text>
              ) : null}
            </ScrollView>
          </View>
          <AppPressable style={[rdStyles.closeBtn, { borderColor: colors.border }]} onPress={onClose} accessibilityRole="button">
            <Text style={{ color: colors.accent }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}
const rdStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', alignItems: 'center', padding: 24 },
  sheet: { borderRadius: radius.lg, paddingVertical: 20, paddingHorizontal: 24, width: 300, maxWidth: '90%', alignItems: 'center', gap: 10 },
  heading: { fontSize: 28, marginBottom: 6 },
  tab: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.xl, borderWidth: 1.5 },
  name: { fontSize: 15, textAlign: 'center' },
  closeBtn: { marginTop: 8, paddingHorizontal: 24, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1 },
});
