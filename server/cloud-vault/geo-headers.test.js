/**
 * Страна сессии не берётся с клиента (v4.32.614).
 *
 * До этого guard читал `req.socket.remoteAddress` и верил заголовкам
 * `cf-*`, если сосед по сокету — loopback. За Nginx сосед всегда loopback,
 * то есть верил всегда: любой клиент называл свою страну сам, и «Активные
 * сессии» показывали не откуда пришли, а что написали. Теперь заголовкам
 * верят только с TRUST_GEO_HEADERS=1 — обратная половина в sync-api.test.js.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const test = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-geo-hdr-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
delete process.env.TRUST_GEO_HEADERS;
const { app, syncDb } = require('./index');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

const privateKey = new Uint8Array(32).fill(11);
const publicKey = ed25519.getPublicKey(privateKey);
const publicKeyB64 = Buffer.from(publicKey).toString('base64');
const accountId = createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 32);

function signed(op, overrides = {}) {
  const payload = {
    v: 1,
    op,
    accountId,
    publicKeyB64,
    accountPublicKeyB64: publicKeyB64,
    devicePublicKeyB64: publicKeyB64,
    deviceId: 'phone-1',
    deviceLabel: 'Телефон',
    deviceInfo: { platform: 'ios', model: 'iPhone', osVersion: '18.0', appVersion: '4.32.614' },
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('base64url'),
    ...overrides,
  };
  const text = JSON.stringify(canonicalize(payload));
  return {
    payload: text,
    signature: Buffer.from(ed25519.sign(Buffer.from(text, 'utf8'), privateKey)).toString('base64'),
  };
}

test('подставленные cf-заголовки не становятся страной сессии', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const spoofed = {
    'content-type': 'application/json',
    'cf-ipcountry': 'NL',
    'cf-ipcity': 'Amsterdam',
  };

  const enroll = await fetch(`${base}/v1/sync/${accountId}/devices/enroll`, {
    method: 'POST',
    headers: spoofed,
    body: JSON.stringify(signed('enroll')),
  });
  assert.equal(enroll.status, 200);

  const devices = await fetch(`${base}/v1/sync/${accountId}/devices`, {
    method: 'POST',
    headers: spoofed,
    body: JSON.stringify(signed('list_devices')),
  });
  assert.equal(devices.status, 200);
  const body = await devices.json();
  assert.equal(body.devices.length, 1);
  assert.notEqual(body.devices[0].countryCode, 'NL');
  assert.equal(body.devices[0].city, null);
});
