const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const test = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-sync-api-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
const { app, runMediaGc, syncDb } = require('./index');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

const privateKey = new Uint8Array(32).fill(7);
const publicKeyB64 = Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64');
const accountId = createHash('sha256').update(Buffer.from(ed25519.getPublicKey(privateKey))).digest('hex').slice(0, 32);

async function signedPayload(op, overrides = {}, signingKey = privateKey) {
  const payload = {
    v: 1,
    op,
    accountId,
    publicKeyB64,
    accountPublicKeyB64: publicKeyB64,
    devicePublicKeyB64: publicKeyB64,
    deviceId: 'phone-1',
    deviceLabel: 'Test phone',
    deviceInfo: {
      platform: 'ios',
      model: 'Test iPhone',
      osVersion: '18.6',
      appVersion: '4.32.527',
    },
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('base64url'),
    ...overrides,
  };
  const raw = stableStringify(payload);
  const signature = Buffer.from(ed25519.sign(Buffer.from(raw), signingKey)).toString('base64');
  return { payload: raw, signature };
}

function mutation(id = 'api-m1') {
  return {
    mutationId: id,
    entityKind: 'profile',
    entityId: 'profile-1',
    ownerProfileId: 1,
    revision: 1,
    deleted: false,
    ciphertextB64: Buffer.from('encrypted').toString('base64'),
    updatedAt: Date.now(),
  };
}

test('signed sync API pushes, pulls and revokes devices', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const unclaimedLegacyId = 'e'.repeat(32);
  const legacyClaim = await fetch(`${base}/v1/sync/${unclaimedLegacyId}/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('enroll', {
      accountId: unclaimedLegacyId,
      legacyAccountId: undefined,
    })),
  });
  assert.equal(legacyClaim.status, 426);
  const legacyEnrollment = await fetch(`${base}/v1/sync/${accountId}/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('enroll')),
  });
  assert.equal(legacyEnrollment.status, 200);
  const pushEnvelope = await signedPayload('push', { mutations: [mutation()] });
  const push = await fetch(`${base}/v1/sync/${accountId}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-ipcountry': 'RU', 'cf-ipcity': 'Moscow' },
    body: JSON.stringify(pushEnvelope),
  });
  assert.equal(push.status, 200);
  assert.deepEqual((await push.json()).acceptedMutationIds, ['api-m1']);

  const envelope = {
    v: 1,
    accountId,
    savedAt: Date.now(),
    saltB64: Buffer.alloc(16, 3).toString('base64'),
    iters: 180_000,
    blobB64: Buffer.from('opaque-vault').toString('base64'),
  };
  const vaultPut = await fetch(`${base}/v1/cloud-vault/${accountId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('put', { envelope })),
  });
  assert.equal(vaultPut.status, 200);

  const legacyGet = await fetch(`${base}/v1/cloud-vault/${accountId}?payload=leak&signature=leak`);
  assert.equal(legacyGet.status, 410);
  const vaultGet = await fetch(`${base}/v1/cloud-vault/${accountId}/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('get')),
  });
  assert.equal(vaultGet.status, 200);
  assert.deepEqual(await vaultGet.json(), envelope);

  const devicePrivateKey = new Uint8Array(32).fill(9);
  const devicePublicKeyB64 = Buffer.from(ed25519.getPublicKey(devicePrivateKey)).toString('base64');
  const enrollment = await fetch(`${base}/v1/sync/${accountId}/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('enroll', {
      deviceId: 'phone-2',
      devicePublicKeyB64,
    })),
  });
  assert.equal(enrollment.status, 200);
  const duplicateEnrollment = await fetch(`${base}/v1/sync/${accountId}/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('enroll', {
      deviceId: 'phone-3',
      devicePublicKeyB64,
    })),
  });
  assert.equal(duplicateEnrollment.status, 403);
  const devicePull = await fetch(`${base}/v1/sync/${accountId}/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('pull', {
      publicKeyB64: devicePublicKeyB64,
      devicePublicKeyB64,
      deviceId: 'phone-2',
      cursor: null,
      limit: 1,
    }, devicePrivateKey)),
  });
  assert.equal(devicePull.status, 200);

  const replay = await fetch(`${base}/v1/sync/${accountId}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pushEnvelope),
  });
  assert.equal(replay.status, 401);

  const pull = await fetch(`${base}/v1/sync/${accountId}/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('pull', { cursor: null, limit: 10 })),
  });
  assert.equal(pull.status, 200);
  assert.equal((await pull.json()).mutations[0].ciphertextB64, Buffer.from('encrypted').toString('base64'));

  const mediaId = 'a'.repeat(32);
  const mediaCiphertextB64 = Buffer.from('opaque-encrypted-media').toString('base64');
  const mediaPut = await fetch(`${base}/v1/sync/${accountId}/media/put`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_put', {
      mediaId,
      ciphertextB64: mediaCiphertextB64,
      mime: 'audio/ogg',
    })),
  });
  assert.equal(mediaPut.status, 200);
  assert.deepEqual(await mediaPut.json(), { ok: true, mediaId, bytes: Buffer.byteLength('opaque-encrypted-media') });

  const mediaGetBeforeDelete = await fetch(`${base}/v1/sync/${accountId}/media/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_get', { mediaId })),
  });
  assert.equal(mediaGetBeforeDelete.status, 200);
  assert.deepEqual(await mediaGetBeforeDelete.json(), { mediaId, ciphertextB64: mediaCiphertextB64 });

  const unregisteredMediaId = 'c'.repeat(32);
  const mediaDir = path.join(dataDir, 'media', accountId);
  fs.mkdirSync(mediaDir, { recursive: true });
  const unregisteredFile = path.join(mediaDir, `${unregisteredMediaId}.bin`);
  fs.writeFileSync(unregisteredFile, 'unconfirmed-reference');
  assert.deepEqual((await runMediaGc(accountId, Date.now() + 1, 0)).deleted, 0);
  assert.equal(fs.existsSync(unregisteredFile), true);
  const unregisteredGet = await fetch(`${base}/v1/sync/${accountId}/media/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_get', { mediaId: unregisteredMediaId })),
  });
  assert.equal(unregisteredGet.status, 404);

  const reference = await fetch(`${base}/v1/sync/${accountId}/media/reference`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_reference', {
      mediaId,
      referenceId: 'message-api-1',
      present: true,
    })),
  });
  assert.equal(reference.status, 200);

  const deleteWhileReferenced = await fetch(`${base}/v1/sync/${accountId}/media/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_delete', { mediaId })),
  });
  assert.equal(deleteWhileReferenced.status, 200);
  assert.deepEqual(await deleteWhileReferenced.json(), {
    ok: true,
    mediaId,
    pending: true,
    activeReferences: 1,
  });
  assert.deepEqual((await runMediaGc(accountId, Date.now() + 1, 0)).deleted, 0);

  const release = await fetch(`${base}/v1/sync/${accountId}/media/reference`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_reference', {
      mediaId,
      referenceId: 'message-api-1',
      present: false,
    })),
  });
  assert.equal(release.status, 200);

  const gc = await fetch(`${base}/v1/sync/${accountId}/media/gc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_gc')),
  });
  assert.equal(gc.status, 200);
  assert.deepEqual(await gc.json(), { ok: true, deleted: 0 });
  assert.deepEqual((await runMediaGc(accountId, Date.now() + 1, 0)).deleted, 1);

  const mediaGet = await fetch(`${base}/v1/sync/${accountId}/media/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_get', { mediaId })),
  });
  assert.equal(mediaGet.status, 404);

  const missingMedia = await fetch(`${base}/v1/sync/${accountId}/media/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('media_get', { mediaId: 'b'.repeat(32) })),
  });
  assert.equal(missingMedia.status, 404);

  const devices = await fetch(`${base}/v1/sync/${accountId}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('list_devices')),
  });
  assert.equal(devices.status, 200);
  const devicesBody = await devices.json();
  assert.equal(devicesBody.devices.length, 2);
  assert.equal(devicesBody.devices[0].deviceModel, 'Test iPhone');
  assert.equal(devicesBody.devices[0].platform, 'ios');
  assert.equal(devicesBody.devices[0].countryCode, 'RU');
  assert.equal(devicesBody.devices[0].city, 'Moscow');

  const revoke = await fetch(`${base}/v1/sync/${accountId}/devices/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('revoke_device', { targetDeviceId: 'phone-2' })),
  });
  assert.equal(revoke.status, 200);
  assert.deepEqual(await revoke.json(), { ok: true });

  const revoked = await fetch(`${base}/v1/sync/${accountId}/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('pull', { deviceId: 'phone-2', cursor: null, limit: 1 })),
  });
  const revokedBody = await revoked.text();
  assert.equal(revoked.status, 403, revokedBody);

  const revokedVaultGet = await fetch(`${base}/v1/cloud-vault/${accountId}/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('get', { deviceId: 'phone-2' })),
  });
  assert.equal(revokedVaultGet.status, 403);

  // Existing v1 cloud data remains readable through the v2 public-key-bound
  // route during migration, without allowing a new legacy claim.
  const legacyPrivateKey = new Uint8Array(32).fill(8);
  const legacyPublicKeyB64 = Buffer.from(ed25519.getPublicKey(legacyPrivateKey)).toString('base64');
  const migratedAccountId = createHash('sha256')
    .update(Buffer.from(ed25519.getPublicKey(legacyPrivateKey))).digest('hex').slice(0, 32);
  const legacyVaultId = 'f'.repeat(32);
  syncDb.ensureAccount(legacyVaultId, legacyPublicKeyB64);
  syncDb.ensureDevice(legacyVaultId, 'legacy-device', legacyPublicKeyB64, 'Legacy phone');
  const legacyEnvelope = {
    ...envelope,
    accountId: legacyVaultId,
  };
  fs.writeFileSync(path.join(dataDir, `${legacyVaultId}.json`), JSON.stringify({
    v: 1,
    ownerPublicKeyB64: legacyPublicKeyB64,
    envelope: legacyEnvelope,
  }), { mode: 0o600 });
  const aliasedLegacyGet = await fetch(`${base}/v1/cloud-vault/${migratedAccountId}/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await signedPayload('get', {
      accountId: migratedAccountId,
      legacyAccountId: legacyVaultId,
      publicKeyB64: legacyPublicKeyB64,
      accountPublicKeyB64: legacyPublicKeyB64,
      devicePublicKeyB64: legacyPublicKeyB64,
      deviceId: 'legacy-device',
    }, legacyPrivateKey)),
  });
  assert.equal(aliasedLegacyGet.status, 200);
  assert.deepEqual(await aliasedLegacyGet.json(), legacyEnvelope);
});
