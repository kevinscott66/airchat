/**
 * Реестр юзернеймов: захват, конфликт, переименование и справка.
 *
 * Отдельный процесс с собственной базой — `sync-api.test.js` закрывает свою в
 * `t.after`, и делить одну на два файла нельзя.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const test = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-username-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
const { app, syncDb } = require('./index');
const { RESERVED_USERNAMES, normalizeClaimableUsername } = require('./reserved-usernames');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function accountFor(fill) {
  const privateKey = new Uint8Array(32).fill(fill);
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey,
    publicKeyB64: Buffer.from(publicKey).toString('base64'),
    accountId: createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 32),
  };
}

function signed(account, op, overrides = {}) {
  const payload = {
    v: 1,
    op,
    accountId: account.accountId,
    publicKeyB64: account.publicKeyB64,
    accountPublicKeyB64: account.publicKeyB64,
    devicePublicKeyB64: account.publicKeyB64,
    deviceId: 'phone-1',
    deviceLabel: 'Test phone',
    deviceInfo: { platform: 'ios', model: 'Test iPhone', osVersion: '18.6', appVersion: '4.32.543' },
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('base64url'),
    ...overrides,
  };
  const raw = JSON.stringify(canonicalize(payload));
  return {
    payload: raw,
    signature: Buffer.from(ed25519.sign(Buffer.from(raw), account.privateKey)).toString('base64'),
  };
}

test('username registry claims globally and refuses a name held by another account', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const alice = accountFor(11);
  const bob = accountFor(12);

  const post = async (account, body) => fetch(`${base}/v1/sync/${account.accountId}/username/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  for (const account of [alice, bob]) {
    const enroll = await fetch(`${base}/v1/sync/${account.accountId}/devices/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed(account, 'enroll')),
    });
    assert.equal(enroll.status, 200);
  }

  const free = await fetch(`${base}/v1/username/kevin_s`);
  assert.equal(free.status, 200);
  assert.deepEqual(await free.json(), { username: 'kevin_s', taken: false });

  const claim = await post(alice, signed(alice, 'claim_username', { username: 'kevin_s', ownerProfileId: 0 }));
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), { ok: true, username: 'kevin_s' });

  const taken = await fetch(`${base}/v1/username/KEVIN_S`);
  assert.deepEqual(await taken.json(), { username: 'kevin_s', taken: true });

  // Чужой аккаунт то же имя не получает.
  const conflict = await post(bob, signed(bob, 'claim_username', { username: 'kevin_s', ownerProfileId: 0 }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'username_taken');

  // Свой же профиль повторно занимает то же имя без ошибки (идемпотентность).
  const again = await post(alice, signed(alice, 'claim_username', { username: 'kevin_s', ownerProfileId: 0 }));
  assert.equal(again.status, 200);

  // Переименование освобождает прежнее имя — иначе за каждым копились бы
  // брошенные записи.
  const renamed = await post(alice, signed(alice, 'claim_username', { username: 'kevin_s2', ownerProfileId: 0 }));
  assert.equal(renamed.status, 200);
  assert.equal((await (await fetch(`${base}/v1/username/kevin_s`)).json()).taken, false);
  const rescued = await post(bob, signed(bob, 'claim_username', { username: 'kevin_s', ownerProfileId: 0 }));
  assert.equal(rescued.status, 200);

  // Второй профиль той же seed-фразы — отдельный владелец имени.
  const second = await post(alice, signed(alice, 'claim_username', { username: 'kevin_s3', ownerProfileId: 1 }));
  assert.equal(second.status, 200);
  assert.equal((await (await fetch(`${base}/v1/username/kevin_s2`)).json()).taken, true);

  // Оставленные приложению и слишком короткие имена сервер не принимает даже
  // от собранного вручную клиента.
  for (const username of ['support', 'abc', 'Плохое', 'a'.repeat(33)]) {
    const rejected = await post(alice, signed(alice, 'claim_username', { username, ownerProfileId: 0 }));
    assert.equal(rejected.status, 401, `expected refusal for ${username}`);
  }

  // v4.32.548: оставленное приложению имя открывает подписанная бумага на
  // галочку — но именно подписанная. Самодельная, пустая и чрезмерно длинная
  // получают тот же отказ, что и запрос вовсе без неё: сервер проверяет
  // подпись сам, а не верит присланному «мне разрешено».
  const forged = JSON.stringify({
    payload: JSON.stringify({ did: 'did:key:z6Mk', kind: 'official', username: 'founder', v: 1 }),
    signature: Buffer.alloc(64).toString('base64'),
  });
  for (const badge of [forged, '', 'x'.repeat(2000), 42]) {
    const rejected = await post(alice, signed(alice, 'claim_username', {
      username: 'founder', ownerProfileId: 0, badge,
    }));
    assert.equal(rejected.status, 401, `expected refusal for badge ${String(badge).slice(0, 12)}`);
  }
  assert.equal((await (await fetch(`${base}/v1/username/founder`)).json()).taken, false);

  // Освобождение по запросу владельца.
  const release = await fetch(`${base}/v1/sync/${alice.accountId}/username/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed(alice, 'release_username', { ownerProfileId: 1 })),
  });
  assert.equal(release.status, 200);
  assert.equal((await (await fetch(`${base}/v1/username/kevin_s3`)).json()).taken, false);

  const malformed = await fetch(`${base}/v1/username/${encodeURIComponent('нет')}`);
  assert.equal(malformed.status, 400);
});

test('server reserved list matches the client one', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'core', 'identity', 'reservedUsernames.ts'),
    'utf8',
  );
  const block = source.slice(
    source.indexOf('RESERVED_USERNAMES: ReadonlySet<string> = new Set(['),
    source.indexOf(']);'),
  );
  const clientNames = new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(clientNames.size > 50, 'client list parsed');
  assert.deepEqual([...clientNames].sort(), [...RESERVED_USERNAMES].sort());
  assert.equal(normalizeClaimableUsername(' @Kevin_S '), 'kevin_s');
  assert.equal(normalizeClaimableUsername('support'), null);
});
