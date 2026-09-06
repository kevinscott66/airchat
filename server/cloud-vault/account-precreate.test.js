const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-precreate-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
const { app, syncDb } = require('./index');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function identity(fill) {
  const privateKey = new Uint8Array(32).fill(fill);
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey,
    publicKeyB64: Buffer.from(publicKey).toString('base64'),
    accountId: createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 32),
  };
}

const victim = identity(3);
const attacker = identity(5);

// v4.32.614: ключ аккаунта и ключ, которым подписан запрос, — разные поля.
// Открытый ключ владельца известен каждому его собеседнику (он внутри did:key),
// поэтому назвать чужой accountPublicKeyB64 может кто угодно. Заводить по
// такому запросу учётную запись нельзя: она появляется только при привязке
// устройства, где подписывает её собственный ключ.
test('чужой запрос синхронизации не заводит учётную запись', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const payload = {
    v: 1,
    op: 'pull',
    accountId: victim.accountId,
    accountPublicKeyB64: victim.publicKeyB64,
    publicKeyB64: attacker.publicKeyB64,
    devicePublicKeyB64: attacker.publicKeyB64,
    deviceId: 'attacker-1',
    cursor: null,
    limit: 50,
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('base64url'),
  };
  const raw = JSON.stringify(canonicalize(payload));
  const signature = Buffer.from(ed25519.sign(Buffer.from(raw), attacker.privateKey)).toString('base64');

  const response = await fetch(`${base}/v1/sync/${victim.accountId}/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: raw, signature }),
  });
  assert.equal(response.status, 403);
  assert.equal(syncDb.hasAccount(victim.accountId), false);
});
