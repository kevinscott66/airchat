import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import type { ChatMessageRow, MessageRoute } from '../../../../core/storage/local';
import { font, primaryInk, radius, scrim } from '../../../theme';
import { dayMonthShortTimeSec } from '../../../../core/time/ruDateTime';

/**
 * Как назвать маршрут человеку (v4.32.563).
 *
 * Названия транспортов — внутренние; человеку важно другое: понадобился ли
 * для этого сообщения интернет и кто мог его увидеть по дороге. Поэтому
 * `lan` — это «по локальной сети», а не «LAN», и подпись прямо говорит, что
 * наружу оно не выходило.
 */
const ROUTE_LABELS: Record<MessageRoute, { title: string; hint: string; icon: 'globe-outline' | 'wifi-outline' | 'swap-horizontal-outline' | 'radio-outline' }> = {
  ipfs: { title: 'Через сеть', hint: 'Опубликовано и подтверждено', icon: 'globe-outline' },
  lan: { title: 'По локальной сети', hint: 'Напрямую, без интернета', icon: 'wifi-outline' },
  internet: { title: 'Через реле', hint: 'Интернет, сервер пересылки', icon: 'swap-horizontal-outline' },
  wifi_direct: { title: 'Wi-Fi Direct', hint: 'Напрямую между устройствами', icon: 'radio-outline' },
};

/**
 * Как назвать состояние сообщения человеку (v4.32.886).
 *
 * Пузырь эти состояния различает давно: часы «в очереди», крутилка
 * «отправляется», галочка, две галочки, красный кружок «нажмите для повтора».
 * Окно сведений же знало ровно два слова — «Прочитано» и «Доставлено», — а всё
 * остальное сваливало в «Отправлено» с галочкой. То есть у сообщения, которое
 * рядом в переписке горит красным и не ушло никуда, окно писало «Отправлено».
 *
 * Слова взяты те же, что у иконки, и поводы разделены так же: «отправлено» без
 * CID — это ещё очередь, а не отправка (строку CID окно показывает ниже, и без
 * этой развилки она противоречила бы подписи).
 */
function statusView(
  status: string,
  hasCid: boolean
): { label: string; icon: React.ComponentProps<typeof Ionicons>['name']; tone: 'muted' | 'accent' | 'error' } {
  switch (status) {
    case 'read':
      return { label: 'Прочитано', icon: 'checkmark-done', tone: 'accent' };
    case 'delivered':
      return { label: 'Доставлено', icon: 'checkmark-done-outline', tone: 'muted' };
    case 'sent':
      return hasCid
        ? { label: 'Отправлено', icon: 'checkmark-outline', tone: 'muted' }
        : { label: 'В очереди на отправку', icon: 'cloud-upload-outline', tone: 'muted' };
    case 'sending':
      return { label: 'Отправляется…', icon: 'ellipsis-horizontal', tone: 'muted' };
    case 'failed':
      return { label: 'Не отправлено', icon: 'alert-circle-outline', tone: 'error' };
    default:
      return { label: 'Ожидает отправки', icon: 'time-outline', tone: 'muted' };
  }
}

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
  const view = statusView(msg.status, !!msg.cid);
  const statusLabel = view.label;
  const statusIcon = view.icon;
  const statusColor =
    view.tone === 'accent' ? colors.accent : view.tone === 'error' ? colors.error : colors.textSecondary;
  // Первая строка показывает время создания строки. Называть его отправкой
  // можно только у того, что действительно ушло: у неотправленного это тот
  // самый обман, ради которого и заведён statusView.
  const leftDevice = msg.status === 'sent' || msg.status === 'delivered' || msg.status === 'read';
  return (
    <Modal visible={!!msg} transparent animationType="fade" onRequestClose={onClose}>
      <AppPressable style={{ flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', padding: 24 }} onPress={onClose}>
        <AppPressable onPress={() => {/* stop */}} style={{ backgroundColor: colors.surface, borderRadius: radius.xl, padding: 20 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17, marginBottom: 16 }}>Сведения о сообщении</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Ionicons name="send-outline" size={18} color={colors.accent} style={{ marginRight: 10 }} />
            <View>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>{leftDevice ? 'Отправлено' : 'Создано'}</Text>
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
          {msg.transport && ROUTE_LABELS[msg.transport] ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Ionicons name={ROUTE_LABELS[msg.transport].icon} size={18} color={colors.textMuted} style={{ marginRight: 10 }} />
              <View>
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>{ROUTE_LABELS[msg.transport].title}</Text>
                <Text style={{ color: colors.text, fontSize: font.sm }}>{ROUTE_LABELS[msg.transport].hint}</Text>
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
                  <Text style={{ fontSize: font.xs, color: colors.textMuted }}>символов</Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{words}</Text>
                  <Text style={{ fontSize: font.xs, color: colors.textMuted }}>слов</Text>
                </View>
              </View>
            );
          })() : null}
          <AppPressable onPress={onClose} style={{ marginTop: 16, backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}>
            <Text style={{ color: primaryInk(colors).text, fontWeight: '700' }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}
