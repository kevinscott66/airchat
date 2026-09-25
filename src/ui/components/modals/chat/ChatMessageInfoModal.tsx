import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import type { ChatMessageRow, MessageRoute } from '../../../../core/storage/local';
import { font, primaryInk, radius, scrim } from '../../../theme';
import { dayMonthShortTimeSec } from '../../../../core/time/ruDateTime';
import { ruPlural } from '../../../utils/plural';
import { isPlainCid } from '../../../../core/cid';
import { shortIdentity } from '../../../identity/shortId';
import { copyText } from '../../../copyText';
import { COPIED_TEXT, COPY_FINGERPRINT_ACTION } from '../../../clipboardText';

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
 * ссылки на отправленное — это ещё очередь, а не отправка.
 *
 * v4.32.915: развилка осталась на `!!msg.cid` — на ЛЮБОЙ ссылке, которую вернул
 * путь отправки, включая `fallback:`. Это и значит «ушло с устройства»: по
 * локальной сети или через реле оно ушло не менее честно, чем в IPFS. Строка
 * отпечатка ниже теперь показывается только для настоящего CID, поэтому
 * прежняя оговорка «строку CID окно показывает ниже» больше не верна.
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
  /**
   * Настоящий адрес содержимого — или ничего (v4.32.915).
   *
   * `msg.cid` хранит не только CID: путь отправки кладёт туда `local:<время>`
   * для заметок себе и `fallback:<id сообщения>` для всего, что ушло по
   * локальной сети, через WebRTC или через реле. На телефоне IPFS выключен,
   * так что `fallback:` — обычный случай, а не редкий. Различать их дом умеет
   * с v4.32.432: `isPlainCid`, один на девять прежних самодельных проверок.
   */
  const netCid: string | null = isPlainCid(msg.cid) ? msg.cid : null;
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
          {netCid ? (
            /* v4.32.915: было «CID: {msg.cid.slice(0, 32)}…» на любом значении.
               Три беды в одной строке. Первая — слово: «CID» единственное во
               всём окне не переведено, тогда как соседние строки переведены
               нарочно (маршруты в v4.32.563, состояния в v4.32.886, счётчики в
               v4.32.909). Вторая — ложь: у заметки себе там стоит
               `local:1700000000000`, у сообщения, ушедшего по локальной сети, —
               `fallback:<uuid>`, и ни то ни другое не CID и не адрес в сети;
               на телефоне, где IPFS выключен, это как раз обычный случай.
               Третья — строку нельзя унести: обрезана многоточием, не
               выделяется, а именно за этим к идентификатору и приходят.
               Теперь строка есть только у настоящего CID, зовётся по-русски и
               копируется нажатием. Сокращение — общедомовое `shortIdentity`:
               оно ставит многоточие, только если что-то правда выброшено, и
               показывает оба конца, а не одну голову. */
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}
              accessibilityLabel={COPY_FINGERPRINT_ACTION}
              onPress={() => { void copyText(netCid, COPIED_TEXT); }}
            >
              <Ionicons name="cloud-done-outline" size={18} color={colors.textMuted} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>Отпечаток в сети</Text>
                <Text style={{ color: colors.text, fontSize: font.sm }} numberOfLines={1}>{shortIdentity(netCid, 10)}</Text>
              </View>
              <Ionicons name="copy-outline" size={16} color={colors.textMuted} style={{ marginLeft: 10 }} />
            </AppPressable>
          ) : null}
          {msg.text && msg.text.trim().length > 0 ? (() => {
            const t = msg.text.trim();
            const words = t.split(/\s+/).filter(Boolean).length;
            const chars = t.length;
            return (
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 8, marginBottom: 4 }}>
                {/* v4.32.909: число и слово под ним стоят столбиком и читаются
                    одной строкой — «1 символов», «2 слов». Формы в доме уже
                    есть (ruPlural, v4.32.421), и соседние счётчики их зовут. */}
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{chars}</Text>
                  <Text style={{ fontSize: font.xs, color: colors.textMuted }}>
                    {ruPlural(chars, ['символ', 'символа', 'символов'])}
                  </Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{words}</Text>
                  <Text style={{ fontSize: font.xs, color: colors.textMuted }}>
                    {ruPlural(words, ['слово', 'слова', 'слов'])}
                  </Text>
                </View>
              </View>
            );
          })() : null}
          <AppPressable onPress={onClose} style={{ marginTop: 16, backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }} accessibilityRole="button">
            <Text style={{ color: primaryInk(colors).text, fontWeight: '700' }}>Закрыть</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}
