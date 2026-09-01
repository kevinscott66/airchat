import { publicKeyToDidKey, didFromPubB64 } from '../identity/did';
import { fetchProfileByCid } from '../identity/profile';
import type { KeyPairBytes } from '../crypto/keyManager';
import { isPlainCid } from '../cid';
import { log } from '../logger';
import { getContactProfileCid } from './contacts';
import type { EncryptedMessage, IPFSMessageStore } from './messageStore';

/** Stable key for a DM thread (two did:key strings, lexicographic). */
export function dmPairKey(didA: string, didB: string): string {
  return [didA, didB].sort().join(':');
}

export type MessageSyncDeps = {
  pair: KeyPairBytes;
  peerPublicKeyB64: string;
  limit: number;
  store: IPFSMessageStore;
  /** Import one message CID (decrypt + SQLite) — typically MessagingService.receiveCid */
  importCid: (cid: string) => Promise<void>;
};

/**
 * Walk the DM DAG from the peer's published profile tip (conversationTips[pairKey]),
 * oldest → newest, skipping duplicates via importCid / chatMessageExists.
 */
export async function syncDmHistoryFromProfile(deps: MessageSyncDeps): Promise<void> {
  const { pair, peerPublicKeyB64, limit, store, importCid } = deps;
  const myDid = publicKeyToDidKey(pair.publicKey);
  const peerDid = didFromPubB64(peerPublicKeyB64);
  if (!peerDid) {
    log.warn('message_sync_bad_peer_pub');
    return;
  }
  const pairKey = dmPairKey(myDid, peerDid);

  const profileCid = await getContactProfileCid(peerPublicKeyB64);
  if (!profileCid) {
    log.info('message_sync_no_profile_cid', { peerDid });
    return;
  }

  const profile = await fetchProfileByCid(profileCid);
  const head = profile?.conversationTips?.[pairKey];
  if (!head) {
    log.info('message_sync_no_tip', { pairKey });
    return;
  }
  // v4.32.197 (Round-27 #8): validate head CID shape. Compromised peer
  // profile can set head to a huge/garbage string that store.getMessage(head)
  // would still try to fetch. Round-26 guarded previousMessageCid in the
  // walk; the entry point needs the same check.
  const headLen = head.length;
  if (!isPlainCid(head)) {
    log.warn('message_sync_bad_head', { pairKey, headLen });
    return;
  }

  const chain: string[] = [];
  let cur: string | null = head;
  let guard = 0;
  const maxSteps = Math.max(limit, 128);

  while (cur && chain.length < limit && guard < maxSteps) {
    chain.push(cur);
    const em: EncryptedMessage | null = await store.getMessage(cur);
    if (!em) {
      log.warn('message_sync_missing_block', { cid: cur });
      break;
    }
    // v4.32.196 (Round-26 #9): validate previousMessageCid shape before
    // walking the DAG. Compromised peer profile can stuff arbitrary strings
    // (huge, with control chars) that otherwise flow back into
    // store.getMessage() and stall the fetch with garbage paths.
    cur = isPlainCid(em.previousMessageCid) ? em.previousMessageCid : null;
    guard += 1;
  }

  const oldestFirst = [...chain].reverse();
  for (const cid of oldestFirst) {
    try {
      await importCid(cid);
    } catch (e) {
      log.warn('message_sync_import_failed', {
        cid,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
