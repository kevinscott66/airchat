import { v4 as uuidv4 } from 'uuid';
import { clearGroupAnonymousGrant, updateGroupMemberRole, getGroupRead, listGroupMembersRead, updateGroupAnonymousGrant, getGroupMessageTargetRead } from '../storage/local';
import { lookupValue } from '../utils/lookupResult';
import { getMessagingService } from './messaging';
import type { GroupRecipient } from './groupRecipient';
import type { EnvelopeIntake } from '../transport/envelopeIntake';
import type { GroupMsgEnvelope } from './groupMessaging';
import { GROUP_CTL_PREFIX } from './groupControlEnvelope';
import { canGrantAnonymous, canUseAnonymous, signAnonymousGrant, verifyAnonymousGrant } from './groupAnonymousPolicy';
import { groupControlTsFresh } from './controlWatermark';
import { acceptAnonymousAck } from './groupAnonymousPending';
import { forgetGroupSendProblemsFor } from './groupSendProblemStore';

type AnonymousControl =
  | { kind: 'state_request'; nonce: string; target: string }
  | { kind: 'state'; nonce: string; target: string; at: number; grants: { target: string; revision: number; proof: string | null }[] }
  | { kind: 'grant'; proof: string }
  | { kind: 'post'; revision: number; message: GroupMsgEnvelope }
  | { kind: 'ack'; msgId: string };

export function anonymousControlText(groupId: string, body: AnonymousControl): string {
  return GROUP_CTL_PREFIX + JSON.stringify({ groupId, op: 'anonymous_v1', ts: Date.now(), body: JSON.stringify(body) });
}

// Nonce binds a state response to a current request; archived owner responses cannot
// restore revoked permissions on a newly invited device. Never classify silence as unsupported.
const stateRequests = new Map<string, { nonce: string; at: number }>();
const stateConfirmed = new Map<string, number>();
export async function requestAnonymousState(groupId: string, recipient?: GroupRecipient, target?: string): Promise<void> {
  const svc = getMessagingService();
  if (!svc) return;
  const rcpt = recipient ?? await svc.groupRecipient();
  const requestedTarget = target ?? rcpt.myPub;
  const key = `${rcpt.pid}:${groupId}:${requestedTarget}`;
  if (Date.now() - (stateRequests.get(key)?.at ?? 0) < 60_000) return;
  const members = await listGroupMembersRead(groupId, rcpt.pid);
  const owner = members?.find(m => m.role === 'owner');
  if (!owner || owner.peerPubB64 === rcpt.myPub) return;
  const nonce = uuidv4();
  if (stateRequests.size >= 128) stateRequests.delete(stateRequests.keys().next().value!);
  stateRequests.set(key, { nonce, at: Date.now() });
  await svc.sendMessage(owner.peerPubB64, anonymousControlText(groupId, { kind: 'state_request', nonce, target: requestedTarget }));
}

export async function ownAnonymousPermission(groupId: string): Promise<{ allowed: boolean; revision: number }> {
  const svc = getMessagingService();
  if (!svc) return { allowed: false, revision: 0 };
  const rcpt = await svc.groupRecipient();
  const members = await listGroupMembersRead(groupId, rcpt.pid);
  if (!members) throw new Error('Не удалось прочитать права участников.');
  const owner = members.find(m => m.role === 'owner');
  const mine = members.find(m => m.peerPubB64 === rcpt.myPub);
  if (!owner || !mine) return { allowed: false, revision: 0 };
  const grant = await verifyAnonymousGrant(mine.anonymousGrant, groupId, owner.peerPubB64, mine.peerPubB64);
  const fresh = grant && grant.revision === mine.anonymousRevision && await groupControlTsFresh(`m:${mine.peerPubB64}`, groupId, rcpt.pid, grant.issuedAt);
  return { allowed: !!fresh && canUseAnonymous(mine.role, grant), revision: grant?.revision ?? 0 };
}

/** Local permission writes are only reachable after the same owner check as network writes. */
export async function setGroupAnonymousPermission(groupId: string, target: string, allowed: boolean): Promise<void> {
  const svc = getMessagingService();
  if (!svc) throw new Error('Служба сообщений недоступна.');
  const rcpt = await svc.groupRecipient();
  const group = lookupValue(await getGroupRead(groupId, rcpt.pid));
  const members = await listGroupMembersRead(groupId, rcpt.pid);
  if (!group || group.type !== 'group' || !members) throw new Error('Не удалось прочитать группу.');
  const actor = members.find(m => m.peerPubB64 === rcpt.myPub);
  const member = members.find(m => m.peerPubB64 === target);
  if (!canGrantAnonymous(actor?.role, member?.role)) throw new Error('Только владелец может разрешить анонимность администраторам.');
  const issuedAt = Date.now() + 1;
  if (allowed && !(await groupControlTsFresh(`m:${target}`, groupId, rcpt.pid, issuedAt))) throw new Error('Недавнее изменение роли ещё синхронизируется. Повторите позже.');
  const proof = await signAnonymousGrant(rcpt.pair, {
    version: 1, groupId, owner: rcpt.myPub, target, allowed,
    revision: (member?.anonymousRevision ?? 0) + 1, issuedAt,
  });
  if (!(await updateGroupAnonymousGrant(groupId, rcpt.pid, target, proof, (member?.anonymousRevision ?? 0) + 1))) throw new Error('Права изменились. Откройте участников заново.');
  const outcomes = await Promise.all(members.filter(m => m.peerPubB64 !== rcpt.myPub && m.role !== 'banned')
    .map(m => svc.sendMessage(m.peerPubB64, anonymousControlText(groupId, { kind: 'grant', proof })).catch(() => null)));
  if (outcomes.some(v => !v)) throw new Error('Разрешение сохранено, но не все участники приняли обновление. Повторите изменение при восстановлении связи.');
}

export async function handleAnonymousControl(groupId: string, raw: string, rcpt: GroupRecipient, signer: string): Promise<EnvelopeIntake> {
  let body: AnonymousControl;
  try { body = JSON.parse(raw) as AnonymousControl; } catch { return 'consumed'; }
  if (!body || typeof body !== 'object') return 'consumed';
  const read = await getGroupRead(groupId, rcpt.pid);
  if (read.state === 'failed') return 'deferred';
  const group = lookupValue(read);
  if (!group || group.type !== 'group') return 'consumed';
  const members = await listGroupMembersRead(groupId, rcpt.pid);
  if (!members) return 'deferred';
  const actor = members.find(m => m.peerPubB64 === signer);
  const owner = members.find(m => m.role === 'owner');
  if (!actor || actor.role === 'banned' || !owner) return 'consumed';
  if (body.kind === 'state_request') {
    if (rcpt.myPub !== owner.peerPubB64 || typeof body.nonce !== 'string' || body.nonce.length > 64 || !body.nonce || !members.some(m => m.peerPubB64 === body.target)) return 'consumed';
    const grants = members.filter(m => m.peerPubB64 === body.target).map(m => ({ target: m.peerPubB64, revision: m.anonymousRevision ?? 0, proof: canGrantAnonymous('owner', m.role) ? m.anonymousGrant ?? null : null }));
    const queued = await getMessagingService()?.sendMessage(signer, anonymousControlText(groupId, { kind: 'state', nonce: body.nonce, target: body.target, at: Date.now(), grants }));
    return queued ? 'consumed' : 'deferred';
  }
  if (body.kind === 'state') {
    const key = `${rcpt.pid}:${groupId}:${body.target}`;
    const pending = stateRequests.get(key);
    if (signer !== owner.peerPubB64 || !pending || pending.nonce !== body.nonce || Date.now() - pending.at > 60_000 ||
      !Number.isSafeInteger(body.at) || Math.abs(Date.now() - body.at) > 5 * 60_000 || !Array.isArray(body.grants) || body.grants.length !== 1 || body.grants[0]?.target !== body.target) return 'consumed';
    // Fresh owner attestation also establishes admin role absent from legacy invites.
    // A newer membership decision wins over this snapshot.
    for (const entry of body.grants) {
      if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.revision) || entry.revision < 0) continue;
      const current = members.find(m => m.peerPubB64 === entry.target);
      if (!current || !(await groupControlTsFresh(`m:${entry.target}`, groupId, rcpt.pid, body.at))) continue;
      if (entry.proof === null) {
        await clearGroupAnonymousGrant(groupId, rcpt.pid, entry.target, entry.revision);
        continue;
      }
      const proof = entry.proof;
      const grant = await verifyAnonymousGrant(proof, groupId, signer);
      if (!grant || grant.issuedAt > body.at || grant.target !== entry.target || grant.revision !== entry.revision) continue;
      const target = members.find(m => m.peerPubB64 === grant.target);
      if (!target || target.role === 'banned' || grant.revision <= (target.anonymousRevision ?? 0) ||
        !(await groupControlTsFresh(`m:${grant.target}`, groupId, rcpt.pid, grant.issuedAt))) continue;
      if (target.role === 'member') await updateGroupMemberRole(groupId, target.peerPubB64, 'admin', rcpt.pid);
      await updateGroupAnonymousGrant(groupId, rcpt.pid, grant.target, proof, grant.revision);
    }
    stateRequests.delete(key);
    if (stateConfirmed.size >= 128) stateConfirmed.delete(stateConfirmed.keys().next().value!);
    stateConfirmed.set(key, Date.now());
    return 'consumed';
  }
  if (body.kind === 'grant') {
    if (actor.role !== 'owner' || owner.peerPubB64 !== signer) return 'consumed';
    const grant = await verifyAnonymousGrant(body.proof, groupId, signer);
    if (!grant || grant.issuedAt > Date.now() + 5 * 60_000) return 'consumed';
    const target = members.find(m => m.peerPubB64 === grant.target);
    if (!target || !canGrantAnonymous(actor.role, target.role)) return 'consumed';
    if (grant.revision <= (target.anonymousRevision ?? 0)) return 'consumed';
    if (grant.allowed && !(await groupControlTsFresh(`m:${grant.target}`, groupId, rcpt.pid, grant.issuedAt))) return 'consumed';
    await updateGroupAnonymousGrant(groupId, rcpt.pid, grant.target, body.proof, grant.revision);
    return 'consumed';
  }
  if (body.kind === 'ack') {
    if (typeof body.msgId !== 'string' || !body.msgId || body.msgId.length > 128) return 'consumed';
    if (await acceptAnonymousAck(rcpt.pid, groupId, body.msgId, signer)) await forgetGroupSendProblemsFor(rcpt.pid, [body.msgId]);
    return 'consumed';
  }
  if (body.kind !== 'post' || !Number.isSafeInteger(body.revision) || !body.message || typeof body.message !== 'object') return 'consumed';
  const message = body.message;
  if (message.groupId !== groupId || message.senderPubB64 !== signer) return 'consumed';
  const grant = await verifyAnonymousGrant(actor.anonymousGrant, groupId, owner.peerPubB64, signer);
  if (!canUseAnonymous(actor.role, grant) || grant?.revision !== body.revision || grant.revision !== actor.anonymousRevision ||
    !(await groupControlTsFresh(`m:${signer}`, groupId, rcpt.pid, grant.issuedAt))) {
    // An invitation or an out-of-order grant can precede authorization state.
    // Retry only while current owner state is unknown; known denials are consumed.
    if ((stateConfirmed.get(`${rcpt.pid}:${groupId}:${signer}`) ?? 0) < message.ts && (actor.anonymousRevision ?? 0) < body.revision) {
      void requestAnonymousState(groupId, rcpt, signer).catch(() => {});
      return 'deferred';
    }
    return 'consumed';
  }
  const { handleIncomingGroupEnvelope, encodeGroupMsgEnvelope } = await import('./groupMessaging');
  const outcome = await handleIncomingGroupEnvelope(encodeGroupMsgEnvelope({ ...message, senderName: group.name }), rcpt, signer, true);
  if (outcome === 'deferred') return outcome;
  // ACK only a persisted authorized message, never a merely parsed or rejected envelope.
  const stored = await getGroupMessageTargetRead(message.msgId, rcpt.pid);
  if (stored.state === 'failed') return 'deferred';
  const row = lookupValue(stored);
  if (row?.groupId === groupId && row.senderPubB64 === signer && row.authorAsGroup) {
    const queued = await getMessagingService()?.sendMessage(signer, anonymousControlText(groupId, { kind: 'ack', msgId: message.msgId }));
    if (!queued) return 'deferred';
  }
  return 'consumed';
}
