/**
 * Поиск упомянутого человека в адресной книге (v4.32.605).
 *
 * Упоминание в ленте, в комментарии и в личной переписке — это просто имя в
 * тексте, без адреса. Единственный список, где имя можно превратить в ключ, —
 * контакты: там лежит и канонический `peerUsername`, присланный самим
 * аккаунтом, и два имени — местная подпись (`displayName`) и то, как человек
 * назвал себя сам (`peerName`).
 *
 * Правило разрешения — общее с группами (`resolveMention`): сначала
 * неизменяемый username, потом имена. Имена не уникальны, поэтому при двух
 * совпадениях функция честно отвечает «непонятно кто», а не открывает первого
 * попавшегося.
 */
import { listContactsFor, type Contact } from './contacts';
import { resolveMention } from './mentionResolve';

export type MentionLookup =
  | { status: 'found'; peerPubB64: string; displayName: string }
  | { status: 'none' }
  | { status: 'ambiguous' };

type Candidate = { username?: string | null; displayName?: string | null; pub: string; label: string };

/** Один контакт даёт до двух кандидатов: своя подпись и самоназвание. */
export function contactCandidates(contacts: readonly Contact[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of contacts) {
    const label = c.displayName || c.peerName || '';
    out.push({ username: c.peerUsername, displayName: c.displayName, pub: c.peerPublicKey, label });
    if (c.peerName && c.peerName !== c.displayName) {
      out.push({ username: c.peerUsername, displayName: c.peerName, pub: c.peerPublicKey, label });
    }
  }
  return out;
}

/** Разрешение по готовому списку — без обращения к базе (для тестов и групп). */
export function lookupMentionAmong(raw: string, contacts: readonly Contact[]): MentionLookup {
  const hits = resolveMention(raw, contactCandidates(contacts));
  const pubs = new Set(hits.map((h) => h.pub));
  if (pubs.size === 0) return { status: 'none' };
  if (pubs.size > 1) return { status: 'ambiguous' };
  const first = hits[0];
  return { status: 'found', peerPubB64: first.pub, displayName: first.label || first.displayName || raw };
}

export async function lookupMention(raw: string, ownerProfileId: number): Promise<MentionLookup> {
  return lookupMentionAmong(raw, await listContactsFor(ownerProfileId));
}
