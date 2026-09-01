import type { MeshMessageId } from './types';

export type MeshReceiptKind = 'accepted' | 'forwarded' | 'delivered';

export type MeshReceipt = {
  messageId: MeshMessageId;
  kind: MeshReceiptKind;
  byPeerDid: string;
  at: number;
};

export function createReceipt(
  messageId: MeshMessageId,
  kind: MeshReceiptKind,
  byPeerDid: string,
  at: number = Date.now()
): MeshReceipt {
  return { messageId, kind, byPeerDid, at };
}
