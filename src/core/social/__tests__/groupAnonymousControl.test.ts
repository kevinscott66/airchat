import { ed25519 } from '@noble/curves/ed25519.js';
import { Buffer } from 'buffer';
import { signAnonymousGrant } from '../groupAnonymousPolicy';
import { handleAnonymousControl, requestAnonymousState, setGroupAnonymousPermission } from '../groupAnonymousControl';
import * as db from '../../storage/local';
import { groupControlTsFresh } from '../controlWatermark';
import { handleIncomingGroupEnvelope } from '../groupMessaging';
import { getMessagingService } from '../messaging';

jest.mock('uuid', () => ({ v4: () => 'test-nonce' }));
jest.mock('../../storage/local', () => ({ getGroupRead: jest.fn(), listGroupMembersRead: jest.fn(), updateGroupAnonymousGrant: jest.fn(), clearGroupAnonymousGrant: jest.fn(), getGroupMessageTargetRead: jest.fn(), updateGroupMemberRole: jest.fn() }));
jest.mock('../messaging', () => ({ getMessagingService: jest.fn() }));
jest.mock('../controlWatermark', () => ({ groupControlTsFresh: jest.fn() }));
jest.mock('../groupAnonymousPending', () => ({ acceptAnonymousAck: jest.fn() }));
jest.mock('../groupSendProblemStore', () => ({ forgetGroupSendProblemsFor: jest.fn() }));
jest.mock('../groupMessaging', () => ({ handleIncomingGroupEnvelope: jest.fn(), encodeGroupMsgEnvelope: JSON.stringify }));
const pair = (n: number) => { const secretKey = new Uint8Array(32).fill(n); return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }; };
const op = pair(10), ap = pair(11), mp = pair(12);
const pub = (p: ReturnType<typeof pair>) => Buffer.from(p.publicKey).toString('base64');
const owner = pub(op), admin = pub(ap), member = pub(mp);
const rcpt = { pid: 710, pair: mp, myPub: member };
let members: Array<{ peerPubB64: string; role: string; anonymousRevision?: number; anonymousGrant?: string | null }>;
const sendMessage = jest.fn().mockResolvedValue('queued');
async function proof(allowed = true, revision = 1) {
  return signAnonymousGrant(op, { version: 1, groupId: 'g', owner, target: admin, allowed, revision, issuedAt: Date.now() - 1000 });
}
const post = () => JSON.stringify({ kind: 'post', revision: 1, message: { groupId: 'g', msgId: 'm', senderPubB64: admin, senderName: 'PRIVATE', text: 'hello', ts: Date.now() - 100 } });
beforeEach(async () => {
  jest.clearAllMocks();
  sendMessage.mockResolvedValue('queued');
  members = [{ peerPubB64: owner, role: 'owner' }, { peerPubB64: admin, role: 'admin', anonymousRevision: 1, anonymousGrant: await proof() }, { peerPubB64: member, role: 'member' }];
  (db.getGroupRead as jest.Mock).mockResolvedValue({ state: 'found', value: { id: 'g', type: 'group', name: 'Group' } });
  (db.listGroupMembersRead as jest.Mock).mockImplementation(async () => members);
  (db.updateGroupAnonymousGrant as jest.Mock).mockResolvedValue(true);
  (groupControlTsFresh as jest.Mock).mockResolvedValue(true);
  (handleIncomingGroupEnvelope as jest.Mock).mockResolvedValue('consumed');
  (db.getGroupMessageTargetRead as jest.Mock).mockResolvedValue({ state: 'found', value: { groupId: 'g', senderPubB64: admin, authorAsGroup: true } });
  (getMessagingService as jest.Mock).mockReturnValue({ groupRecipient: async () => rcpt, sendMessage });
});
it('authorized message uses group identity and ACK follows persistence', async () => {
  expect(await handleAnonymousControl('g', post(), rcpt, admin)).toBe('consumed');
  expect(handleIncomingGroupEnvelope).toHaveBeenCalledWith(expect.stringContaining('"senderName":"Group"'), rcpt, admin, true);
  expect(sendMessage).toHaveBeenCalledWith(admin, expect.stringContaining('ack'));
});
it.each(['member', 'restricted', 'banned'])('current %s role cannot reuse an old signed grant', async role => {
  members[1].role = role;
  await handleAnonymousControl('g', post(), rcpt, admin);
  expect(handleIncomingGroupEnvelope).not.toHaveBeenCalled();
});
it('revoked grant, mismatched signer and stale membership proof cannot publish', async () => {
  members[1].anonymousGrant = await proof(false);
  await handleAnonymousControl('g', post(), rcpt, admin);
  members[1].anonymousGrant = await proof();
  await handleAnonymousControl('g', post(), rcpt, member);
  (groupControlTsFresh as jest.Mock).mockResolvedValue(false);
  await handleAnonymousControl('g', post(), rcpt, admin);
  expect(handleIncomingGroupEnvelope).not.toHaveBeenCalled();
});
it('admin cannot grant and owner cannot replay an older revision', async () => {
  const body = JSON.stringify({ kind: 'grant', proof: await proof(true, 2) });
  await handleAnonymousControl('g', body, rcpt, admin);
  await handleAnonymousControl('g', JSON.stringify({ kind: 'grant', proof: await proof() }), rcpt, owner);
  expect(db.updateGroupAnonymousGrant).not.toHaveBeenCalled();
  await handleAnonymousControl('g', body, rcpt, owner);
  expect(db.updateGroupAnonymousGrant).toHaveBeenCalledWith('g', rcpt.pid, admin, expect.any(String), 2);
});
it('local ordinary member cannot mutate permissions', async () => {
  await expect(setGroupAnonymousPermission('g', admin, true)).rejects.toThrow('Только владелец');
  expect(db.updateGroupAnonymousGrant).not.toHaveBeenCalled();
});
it('missing authorization defers queued post and requests owner state', async () => {
  members[1].anonymousRevision = 0; members[1].anonymousGrant = null;
  expect(await handleAnonymousControl('g', post(), { ...rcpt, pid: 711 }, admin)).toBe('deferred');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sendMessage).toHaveBeenCalledWith(owner, expect.stringContaining('state_request'));
});
it('unsolicited or non-owner state never promotes a member', async () => {
  members[1].role = 'member'; members[1].anonymousRevision = 0;
  const body = JSON.stringify({ kind: 'state', target: admin, nonce: 'stolen', at: Date.now(), grants: [{ target: admin, revision: 1, proof: await proof() }] });
  await handleAnonymousControl('g', body, rcpt, owner);
  await handleAnonymousControl('g', body, rcpt, admin);
  expect(db.updateGroupMemberRole).not.toHaveBeenCalled();
});
it('fresh nonce-bound owner state bootstraps an invited admin once', async () => {
  const recipient = { ...rcpt, pid: 712 };
  await requestAnonymousState('g', recipient, admin);
  const outer = JSON.parse(sendMessage.mock.calls[0][1].slice(sendMessage.mock.calls[0][1].indexOf('{')));
  const request = JSON.parse(outer.body);
  members[1].role = 'member'; members[1].anonymousRevision = 0;
  const body = JSON.stringify({ kind: 'state', target: admin, nonce: request.nonce, at: Date.now(), grants: [{ target: admin, revision: 1, proof: await proof() }] });
  await handleAnonymousControl('g', body, recipient, owner);
  expect(db.updateGroupMemberRole).toHaveBeenCalledWith('g', admin, 'admin', recipient.pid);
  jest.clearAllMocks();
  await handleAnonymousControl('g', body, recipient, owner);
  expect(db.updateGroupMemberRole).not.toHaveBeenCalled();
});

it('persisted post defers when ACK cannot enter outbox, so retry can confirm it', async () => {
 sendMessage.mockResolvedValue(null);
 expect(await handleAnonymousControl('g', post(), rcpt, admin)).toBe('deferred');
 expect(handleIncomingGroupEnvelope).toHaveBeenCalled();
});
