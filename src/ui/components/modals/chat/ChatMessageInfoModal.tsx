import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import type { ChatMessageRow } from '../../../../core/storage/local';
import { primaryInk, scrim } from '../../../theme';
import { dayMonthShortTimeSec } from '../../../../core/time/ruDateTime';

// ─── Message Info Modal ───────────────────────────────────────────────────────
export function MessageInfoModal({
  msg,
  onClose,
}: {
  msg: ChatMessageRow | null;
  onClose: () => void;
}): React.ReactElement | null {
  const { colors } = useTheme();
  if (!msg) return null;
  const fmtTime = dayMonthShortTimeSec;
  const statusLabel = msg.status === 'read' ? 'Прочитано' : msg.status === 'delivered' ? 'Доставлено' : 'Отправлено';
  const statusIcon = msg.status === 'read' ? 'checkmark-done' : msg.status === 'delivered' ? 'checkmark-done-outline' : 'checkmark-outline';
  const statusColor = msg.status === 'read' ? colors.accent : colors.textSecondary;
  return (
    <Modal visible={!!msg} transparent animationType="fade" onRequestClose={onClose}>
      <AppPressable style={{ flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', padding: 24 }} onPress={onClose}>
        <AppPressable onPress={() => {/* stop */}} style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 20 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17, marginBottom: 16 }}>Сведения о сообщении</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Ionicons name="send-outline" size={18} color={colors.accent} style={{ marginRight: 10 }} />
            <View>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>Отправлено</Text>
              <Text style={{ color: colors.text, fontSize: 14 }}>{fmtTime(msg.createdAt)}</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Ionicons name={statusIcon} size={18} color={statusColor} style={{ marginRight: 10 }} />
            <View>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>{statusLabel}</Text>
              {msg.status === 'delivered' || msg.status === 'read' ? (
                <Text style={{ color: statusColor, fontSize: 14 }}>{fmtTime(msg.createdAt)}</Text>
              ) : null}
            </View>
          </View>
          {msg.editedAt ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Ionicons name="pencil-outline" size={18} color={colors.textMuted} style={{ marginRight: 10 }} />
              <View>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>Изменено</Text>
                <Text style={{ color: colors.text, fontSize: 14 }}>{fmtTime(msg.editedAt)}</Text>
              </View>
            </View>
          ) : null}
          {msg.cid ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <Ionicons name="cloud-done-outline" size={18} color={colors.textMuted} style={{ marginRight: 10 }} />
              <Text style={{ color: colors.textMuted, fontSize: 12, flex: 1 }} numberOfLines={1}>CID: {msg.cid.slice(0, 32)}…</Text>
            </View>
          ) : null}
          {msg.text && msg.text.trim().length > 0 ? (() => {
            const t = msg.text.trim();
            const words = t.split(/\s+/).filter(Boolean).length;
            const chars = t.length;
            return (
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 8, marginBottom: 4 }}>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{chars}</Text>
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>символов</Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{words}</Text>
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>слов</Text>
                </View>
              </View>
            );
          })() : null}
          <AppPressable onPress={onClose} style={{ marginTop: 16, backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center' }}>
            <Text style={{ color: primaryInk(colors).text, fontWeight: '700' }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}
