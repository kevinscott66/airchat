const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-account-probe-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
const { app, syncDb } = require('./index');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
function stableStringify(value) { return JSON.stringify(canonicalize(value)); }

function identity(fill) {
  const privateKey = new Uint8Array(32).fill(fill);
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey,
    publicKeyB64: Buffer.from(publicKey).toString('base64'),
    accountId: createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 32),
  };
}

const victim = identity(7);
const attacker = identity(9);

function enrollPayload(who, accountId) {
  const payload = {
    v: 1,
    op: 'enroll',
    accountId,
    publicKeyB64: who.publicKeyB64,
    accountPublicKeyB64: who.publicKeyB64,
    devicePublicKeyB64: who.publicKeyB64,
    deviceId: 'phone-1',
    deviceLabel: 'Test phone',
    deviceInfo: { platform: 'ios', model: 'Test iPhone', osVersion: '18.6', appVersion: '4.32.614' },
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('base64url'),
  };
  const raw = stableStringify(payload);
  const signature = Buffer.from(ed25519.sign(Buffer.from(raw), who.privateKey)).toString('base64');
  return { payload: raw, signature };
}

// v4.32.614: идентификатор аккаунта — это sha256 открытого ключа, а этот ключ
// лежит внутри did:key, которым человек делится с каждым собеседником. Значит,
// чужой идентификатор может назвать кто угодно. Сервер не должен по коду ответа
// подсказывать, заведена ли такая учётная запись здесь.
test('сервер отвечает одинаково на существующий и на несуществующий аккаунт', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await fetch(`${base}/v1/sync/${victim.accountId}/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(enrollPayload(victim, victim.accountId)),
  });
  assert.equal(created.status, 200);

  const missingAccountId = 'e'.repeat(32);
  const probeExisting = await fetch(`${base}/v1/sync/${victim.accountId}/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(enrollPayload(attacker, victim.accountId)),
  });
  const probeMissing = await fetch(`${base}/v1/sync/${missingAccountId}/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(enrollPayload(attacker, missingAccountId)),
  });

  assert.equal(probeExisting.status, probeMissing.status);
  assert.deepEqual(await probeExisting.json(), await probeMissing.json());
});
