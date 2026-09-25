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
import { ruPlural } from '../../../utils/plural';
import { UNREADABLE_VIEWERS_TEXT } from '../../../../core/storage/unreadableText';
import { groupSendProblemText, type GroupSendProblem } from '../../../../core/social/groupSendOutcome';

/**
 * v4.32.951: «Отправлено» здесь стояло безусловно, над временем создания
 * строки. Своя строка в группе пишется ДО рассылки, и её отказ до этой версии
 * жил ровно столько, сколько висела плашка, — окно сведений о сообщении,
 * которое не получил никто, писало «Отправлено» и время. То же слово в личной
 * переписке давно условное: там соседнее окно пишет «Создано», пока сообщение
 * не покинуло устройство (см. ChatMessageInfoModal).
 *
 * Отметка приходит снаружи: она лежит не в строке сообщения, а в записи
 * профиля (groupSendProblemStore), и читает её экран группы — тот же, что
 * открывает это окно.
 */
export function GrpMessageInfoModal({
  msg,
  problem,
  onClose,
}: {
  msg: GroupMessageRow | null;
  /** Отметка «не ушло», если рассылка этого сообщения не состоялась. */
  problem?: GroupSendProblem | null;
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
            <Ionicons
              name={problem ? 'alert-circle-outline' : 'send-outline'}
              size={18}
              color={problem ? colors.error : colors.accent}
              style={{ marginRight: 10 }}
            />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>{problem ? 'Создано' : 'Отправлено'}</Text>
              <Text style={{ color: colors.text, fontSize: 14 }}>{fmtTime(msg.createdAt)}</Text>
            </View>
          </View>

          {problem ? (
            <Text style={{ color: colors.error, fontSize: font.sm, marginBottom: 12 }}>
              {groupSendProblemText(problem)}
            </Text>
          ) : null}

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
              {/* v4.32.909: то же самое, что в личной переписке, — окно у них
                  общее по смыслу и различалось только числами. */}
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>{charCount}</Text>
                <Text style={{ fontSize: font.xs, color: colors.textMuted }}>
                  {ruPlural(charCount, ['символ', 'символа', 'символов'])}
                </Text>
              </View>
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>{wordCount}</Text>
                <Text style={{ fontSize: font.xs, color: colors.textMuted }}>
                  {ruPlural(wordCount, ['слово', 'слова', 'слов'])}
                </Text>
              </View>
            </View>
          ) : null}

          <AppPressable onPress={onClose} style={{ marginTop: 8, backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }} accessibilityRole="button">
            <Text style={{ color: primaryInk(colors).text, fontWeight: '700' }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}
