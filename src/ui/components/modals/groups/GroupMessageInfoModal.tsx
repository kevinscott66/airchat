import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { POLL_PREFIX, type GroupMessageRow } from '../../../../core/storage/local';
import { isVoiceMessage } from '../../../../core/social/voiceEnvelope';
import { isDocMessage } from '../../../../core/social/docEnvelope';
import { font, primaryInk, radius, scrim } from '../../../theme';
import { dayMonthShortTimeSec } from '../../../../core/time/ruDateTime';
import { UNREADABLE_VIEWERS_TEXT } from '../../../../core/storage/unreadableText';

export function GrpMessageInfoModal({
  msg,
  onClose,
}: {
  msg: GroupMessageRow | null;
  onClose: () => void;
}): React.ReactElement | null {
  const { colors } = useTheme();
  if (!msg) return null;
  const fmtTime = dayMonthShortTimeSec;
  const isPoll = msg.text.startsWith(POLL_PREFIX);
  const isVoice = isVoiceMessage(msg.text);
  const isDoc = isDocMessage(msg.text);
  const charCount = isPoll || isVoice || isDoc ? null : msg.text.trim().length;
  const wordCount = charCount !== null ? msg.text.trim().split(/\s+/).filter(Boolean).length : null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <AppPressable style={{ flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', padding: 24 }} onPress={onClose}>
        <AppPressable onPress={(e) => e.stopPropagation()} style={{ backgroundColor: colors.surface, borderRadius: radius.xl, padding: 20 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17, marginBottom: 16 }}>Сведения о сообщении</Text>

          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Ionicons name="send-outline" size={18} color={colors.accent} style={{ marginRight: 10 }} />
            <View>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>Отправлено</Text>
              <Text style={{ color: colors.text, fontSize: 14 }}>{fmtTime(msg.createdAt)}</Text>
            </View>
          </View>

          {msg.senderName ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Ionicons name="person-outline" size={18} color={colors.textMuted} style={{ marginRight: 10 }} />
              <View>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>Отправитель</Text>
                <Text style={{ color: colors.text, fontSize: 14 }}>{msg.senderName}</Text>
              </View>
            </View>
          ) : null}

          {msg.seenUnreadable ? (
            // v4.32.591: число прочитавших неизвестно — столбец не открылся
            // ключом данных. Ноль здесь был бы выдуманным.
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Ionicons name="eye-off-outline" size={18} color={colors.warning} style={{ marginRight: 10 }} />
              <View>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>Просмотров</Text>
                <Text style={{ color: colors.warning, fontSize: 14 }}>{UNREADABLE_VIEWERS_TEXT}</Text>
              </View>
            </View>
          ) : (msg.seenBy?.length ?? 0) > 0 ? (
            // v4.32.226: REAL views = distinct seen_by readers (read-receipt backed),
            // not the old blind per-open view_count counter.
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Ionicons name="eye-outline" size={18} color={colors.textMuted} style={{ marginRight: 10 }} />
              <View>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>Просмотров</Text>
                <Text style={{ color: colors.text, fontSize: 14 }}>{msg.seenBy!.length}</Text>
              </View>
            </View>
          ) : null}

          {charCount !== null && wordCount !== null ? (
            <View style={{ flexDirection: 'row', gap: 20, marginTop: 4, marginBottom: 12 }}>
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>{charCount}</Text>
                <Text style={{ fontSize: font.xs, color: colors.textMuted }}>символов</Text>
              </View>
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>{wordCount}</Text>
                <Text style={{ fontSize: font.xs, color: colors.textMuted }}>слов</Text>
              </View>
            </View>
          ) : null}

          <AppPressable onPress={onClose} style={{ marginTop: 8, backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}>
            <Text style={{ color: primaryInk(colors).text, fontWeight: '700' }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}
