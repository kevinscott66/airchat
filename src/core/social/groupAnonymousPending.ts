import { kvUpdateSecretScoped } from '../storage/local';
import { scopedKvTryGetSecretFor } from '../storage/profileScopedKv';

const KEY = 'groups:anonymous_pending_v1';
type Entry = { groupId: string; peers: string[] };
type Entries = Record<string, Entry>;
function parse(raw: string | null): Entries {
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Не удалось прочитать подтверждения группы.');
  const result: Entries = Object.create(null);
  for (const [id, entry] of Object.entries(value)) {
    const e = entry as Entry;
    if (!e || typeof e.groupId !== 'string' || !Array.isArray(e.peers) || e.peers.length > 200 || e.peers.some(p => typeof p !== 'string')) throw new Error('Некорректные подтверждения группы.');
    result[id] = e;
  }
  return result;
}
export async function beginAnonymousPending(pid: number, groupId: string, msgId: string, peers: string[]): Promise<void> {
  const result = await kvUpdateSecretScoped(pid, KEY, raw => {
    const entries = parse(raw);
    // Completed records remain until the next send so a late UI status write cannot undo an ACK.
    for (const [id, entry] of Object.entries(entries)) if (!entry.peers.length && id !== msgId) delete entries[id];
    if (!entries[msgId] && Object.keys(entries).length >= 200) throw new Error('Слишком много сообщений ждут подтверждения.');
    entries[msgId] = { groupId, peers: [...new Set(peers)] };
    return JSON.stringify(entries);
  });
  if (result !== 'written') throw new Error('Не удалось сохранить ожидание подтверждения.');
}
export async function anonymousPendingCount(pid: number, msgId: string): Promise<number | null> {
  const read = await scopedKvTryGetSecretFor(pid, KEY);
  if (read === null) return null;
  return parse(read.value)[msgId]?.peers.length ?? null;
}
export async function acceptAnonymousAck(pid: number, groupId: string, msgId: string, signer: string): Promise<boolean> {
  let complete = false;
  const result = await kvUpdateSecretScoped(pid, KEY, raw => {
    const entries = parse(raw);
    const entry = entries[msgId];
    if (!entry || entry.groupId !== groupId || !entry.peers.includes(signer)) return raw;
    entry.peers = entry.peers.filter(peer => peer !== signer);
    complete = entry.peers.length === 0;
    return JSON.stringify(entries);
  });
  return result === 'written' && complete;
}
