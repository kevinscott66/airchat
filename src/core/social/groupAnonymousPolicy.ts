import { Buffer } from 'buffer';
import { signJson, verifySignedJson } from '../crypto/signature';
import { isPubKeyB64 } from '../crypto/pubKeyFormat';
import type { KeyPairBytes } from '../crypto/keyManager';

export const GROUP_ANONYMOUS_VERSION = 1;
export type AnonymousGrant = {
  version: 1;
  groupId: string;
  owner: string;
  target: string;
  allowed: boolean;
  revision: number;
  issuedAt: number;
};
export type SignedAnonymousGrant = { payload: string; signature: string };

export function canGrantAnonymous(actorRole: string | undefined, targetRole: string | undefined): boolean {
  return actorRole === 'owner' && (targetRole === 'owner' || targetRole === 'admin');
}
export function canUseAnonymous(role: string | undefined, grant: AnonymousGrant | null): boolean {
  return (role === 'owner' || role === 'admin') && grant?.allowed === true;
}

/** Owner signature survives forwarding inside an invite; inviter authority is insufficient. */
export async function signAnonymousGrant(pair: KeyPairBytes, grant: AnonymousGrant): Promise<string> {
  const owner = Buffer.from(pair.publicKey).toString('base64');
  if (grant.owner !== owner) throw new Error('Разрешение должен подписать владелец группы.');
  return JSON.stringify(await signJson(pair, grant));
}

export async function verifyAnonymousGrant(raw: unknown, groupId: string, owner: string, target?: string): Promise<AnonymousGrant | null> {
  if (typeof raw !== 'string' || raw.length > 4096 || !isPubKeyB64(owner)) return null;
  try {
    const signed = JSON.parse(raw) as SignedAnonymousGrant;
    if (!signed || typeof signed !== 'object') return null;
    const p = await verifySignedJson(new Uint8Array(Buffer.from(owner, 'base64')), signed, 2048);
    if (!p || p.version !== GROUP_ANONYMOUS_VERSION || p.groupId !== groupId || p.owner !== owner ||
      !isPubKeyB64(p.target) || (target !== undefined && p.target !== target) ||
      typeof p.allowed !== 'boolean' || !Number.isSafeInteger(p.revision) || (p.revision as number) <= 0 || !Number.isSafeInteger(p.issuedAt) || (p.issuedAt as number) <= 0) return null;
    return p as AnonymousGrant;
  } catch { return null; }
}
