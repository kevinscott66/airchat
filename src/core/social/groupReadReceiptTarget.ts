import { isGroupSysMessage } from './groupSysLine';

/** Local control events have no remote author (often senderPubB64 is empty).
 * They must not consume the per-sender slot or trigger a DM session lookup.
 */
export function isGroupReadReceiptTarget(
  message: { senderPubB64: string; text: string },
  myPubB64: string,
): boolean {
  return !!message.senderPubB64.trim() && message.senderPubB64 !== myPubB64 && !isGroupSysMessage(message.text);
}
