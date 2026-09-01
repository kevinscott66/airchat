/**
 * Date separator helpers for ChatScreen (D.3.1 extract).
 *
 * v4.32.421: сама подпись уехала в ui/time/dateSeparator — она же рисуется в
 * группах, и копии разошлись. Здесь осталась расстановка разделителей.
 */
import type { ChatMessageRow } from '../../../core/storage/local';
import { formatDateSepLabel, isUsableTimestamp, startsNewDay } from '../../time/dateSeparator';

export { formatDateSepLabel };

export type DateSeparatorItem = { type: 'date_sep'; label: string; key: string };
export type ChatListItem = ChatMessageRow | DateSeparatorItem;

export function injectDateSeparators(msgs: ChatMessageRow[]): ChatListItem[] {
  if (msgs.length === 0) return [];
  const result: ChatListItem[] = [];
  for (let i = 0; i < msgs.length; i++) {
    result.push(msgs[i]);
    const curr = msgs[i];
    const next = msgs[i + 1];
    // v4.32.185 (Round-15 #6): skip separator for invalid ts.
    if (!isUsableTimestamp(curr.createdAt)) continue;
    if (startsNewDay(curr.createdAt, next && isUsableTimestamp(next.createdAt) ? next.createdAt : null)) {
      result.push({ type: 'date_sep', label: formatDateSepLabel(curr.createdAt), key: `sep_${curr.createdAt}` });
    }
  }
  return result;
}
