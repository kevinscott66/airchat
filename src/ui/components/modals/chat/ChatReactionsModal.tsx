import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { font, radius, scrim } from '../../../theme';

const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '👏', '🎉', '💯'];

// ─── Reactions Modal ──────────────────────────────────────────────────────────
export function ReactionsModal({
  visible,
  onClose,
  onSelect,
  recentEmojis = [],
  onMoreEmojis,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  recentEmojis?: string[];
  onMoreEmojis?: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <AppPressable style={rmStyles.overlay} onPress={onClose}>
        <View style={[rmStyles.panel, { backgroundColor: colors.surface }]}>
          {recentEmojis.length > 0 && (
            <>
              <Text style={[rmStyles.sectionLabel, { color: colors.textMuted }]}>Недавние</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={rmStyles.row}>
                {recentEmojis.map((e) => (
                  <AppPressable key={`r_${e}`} style={rmStyles.emojiBtn} onPress={() => { onSelect(e); onClose(); }}>
                    <Text style={rmStyles.emoji}>{e}</Text>
                  </AppPressable>
                ))}
              </ScrollView>
              <View style={[rmStyles.divider, { backgroundColor: colors.border }]} />
            </>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={rmStyles.row}>
            {REACTION_EMOJIS.map((e) => (
              <AppPressable
                key={e}
                style={rmStyles.emojiBtn}
                onPress={() => { onSelect(e); onClose(); }}
              >
                <Text style={rmStyles.emoji}>{e}</Text>
              </AppPressable>
            ))}
            {onMoreEmojis ? (
              <AppPressable
                style={[rmStyles.emojiBtn, rmStyles.moreBtnWrapper]}
                onPress={() => { onClose(); onMoreEmojis(); }}
              >
                <View style={[rmStyles.moreBtn, { backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}>
                  <Ionicons name="add" size={22} color={colors.text} />
                </View>
              </AppPressable>
            ) : null}
          </ScrollView>
        </View>
      </AppPressable>
    </Modal>
  );
}

const rmStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: scrim.modal },
  panel: { borderRadius: radius.xl, padding: 12 },
  row: { gap: 4, paddingHorizontal: 4 },
  emojiBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 26 },
  sectionLabel: { fontSize: font.xs, fontWeight: '600', paddingHorizontal: 6, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6, marginHorizontal: 4 },
  moreBtnWrapper: {},
  moreBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
