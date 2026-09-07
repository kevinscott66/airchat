import type { MeshMessageId } from './types';

const seenIds = new Set<MeshMessageId>();
const SEEN_MAX = 5000;

export function markSeenOrDuplicate(id: MeshMessageId): boolean {
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  if (seenIds.size > SEEN_MAX) {
    const it = seenIds.values();
    seenIds.delete(it.next().value as MeshMessageId);
  }
  return false;
}
