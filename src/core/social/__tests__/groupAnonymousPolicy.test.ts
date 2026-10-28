import { ed25519 } from '@noble/curves/ed25519.js';
import { Buffer } from 'buffer';
import { canGrantAnonymous, canUseAnonymous, signAnonymousGrant, verifyAnonymousGrant, type AnonymousGrant } from '../groupAnonymousPolicy';

const secretKey = new Uint8Array(32).fill(7);
const pair = { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
const owner = Buffer.from(pair.publicKey).toString('base64');
const target = Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(8))).toString('base64');
const grant: AnonymousGrant = { version: 1, groupId: 'group-test', owner, target, allowed: true, revision: 1, issuedAt: 1000 };

it('only owner can grant to owner/admin; ordinary members are ineligible', () => {
  expect(canGrantAnonymous('owner', 'owner')).toBe(true);
  expect(canGrantAnonymous('owner', 'admin')).toBe(true);
  expect(canGrantAnonymous('admin', 'admin')).toBe(false);
  expect(canGrantAnonymous('owner', 'member')).toBe(false);
  expect(canGrantAnonymous('member', 'owner')).toBe(false);
});
it('demotion or revocation blocks use even when an old grant exists', () => {
  expect(canUseAnonymous('admin', grant)).toBe(true);
  expect(canUseAnonymous('owner', { ...grant, target: owner })).toBe(true);
  for (const role of ['member', 'banned', 'restricted', undefined]) expect(canUseAnonymous(role, grant)).toBe(false);
  expect(canUseAnonymous('admin', { ...grant, allowed: false })).toBe(false);
  expect(canUseAnonymous('owner', null)).toBe(false);
});
it('verifies owner signature bound to group and target, rejects forged payload', async () => {
  const signed = await signAnonymousGrant(pair, grant);
  expect(await verifyAnonymousGrant(signed, grant.groupId, owner, target)).toEqual(grant);
  expect(await verifyAnonymousGrant(signed, 'other-group', owner, target)).toBeNull();
  expect(await verifyAnonymousGrant(signed, grant.groupId, owner, owner)).toBeNull();
  expect(await verifyAnonymousGrant(signed, grant.groupId, target, target)).toBeNull();
  const forged = JSON.parse(signed);
  forged.payload = forged.payload.replace('"revision":1', '"revision":2');
  expect(await verifyAnonymousGrant(JSON.stringify(forged), grant.groupId, owner)).toBeNull();
});
it('rejects invalid version, timestamp and non-monotonic revision even with valid owner signature', async () => {
  for (const change of [{ version: 2 }, { revision: 0 }, { revision: 1.1 }, { issuedAt: 0 }, { issuedAt: Number.MAX_SAFE_INTEGER + 1 }]) {
    const signed = await signAnonymousGrant(pair, { ...grant, ...change } as AnonymousGrant);
    expect(await verifyAnonymousGrant(signed, grant.groupId, owner)).toBeNull();
  }
});
