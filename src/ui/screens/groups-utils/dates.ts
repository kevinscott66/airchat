/**
 * Date separator helpers for GroupsScreen (D.4.1 extract).
 *
 * v4.32.421: подпись уехала в ui/time/dateSeparator, здесь осталась
 * расстановка разделителей.
 */
import type { GroupMessageRow } from '../../../core/storage/local';
import { formatDateSepLabel, isUsableTimestamp, startsNewDay } from '../../time/dateSeparator';
import { unreadSeparatorIndex } from './unreadSeparator';

/**
 * v4.32.421: та же подпись, что и в личных чатах. Своя копия здесь отстала на
 * одну правку — защиту от испорченной отметки времени, — и подписывала
 * разделитель «undefined».
 */
export const formatGrpDateSepLabel = formatDateSepLabel;

export type GrpDateSepItem = { type: 'date_sep'; label: string; key: string };
export type GrpUnreadSepItem = { type: 'unread_sep'; key: string };
export type GrpListItem = GroupMessageRow | GrpDateSepItem | GrpUnreadSepItem;

export function injectGrpDateSeparators(msgs: GroupMessageRow[], initialUnreadCount = 0): GrpListItem[] {
  if (msgs.length === 0) return [];
  const result: GrpListItem[] = [];
  // v4.32.529: массив идёт «новые первыми» (ORDER BY created_at DESC + inverted),
  // поэтому полоса встаёт сразу за непрочитанными, а не с другого конца.
  const sepIdx = unreadSeparatorIndex(msgs.length, initialUnreadCount);
  const pushUnreadSep = (): void => {
    result.push({ type: 'unread_sep', key: 'unread_sep' });
  };
  for (let i = 0; i < msgs.length; i++) {
    if (i === sepIdx) pushUnreadSep();
    result.push(msgs[i]);
    const curr = msgs[i];
    const next = msgs[i + 1];
    // v4.32.421: испорченная отметка не получает разделителя — как и в личных
    // чатах с v4.32.185. Здесь этой проверки не было, и ключ `gsep_NaN`
    // повторялся у каждого такого сообщения.
    if (!isUsableTimestamp(curr.createdAt)) continue;
    if (startsNewDay(curr.createdAt, next && isUsableTimestamp(next.createdAt) ? next.createdAt : null)) {
      result.push({ type: 'date_sep', label: formatGrpDateSepLabel(curr.createdAt), key: `gsep_${curr.createdAt}` });
    }
  }
  // Непрочитанных не меньше, чем загружено: вся видимая лента новая, полоса —
  // над ней. Прежде этот случай терял полосу целиком.
  if (sepIdx === msgs.length) pushUnreadSep();
  return result;
}
