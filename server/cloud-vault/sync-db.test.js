const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { SyncDatabase, validateMutation } = require('./sync-db');

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-sync-'));
  const db = new SyncDatabase(path.join(dir, 'sync.sqlite'));
  return { db, dir };
}

function mutation(overrides = {}) {
  return {
    mutationId: 'm-1',
    entityKind: 'message',
    entityId: 'message-1',
    ownerProfileId: 1,
    revision: 1,
    deleted: false,
    ciphertextB64: Buffer.from('opaque encrypted message').toString('base64'),
    updatedAt: Date.now(),
    ...overrides,
  };
}

test('validates opaque mutations and rejects plaintext-shaped data', () => {
  assert.ok(validateMutation(mutation()));
  assert.equal(validateMutation(mutation({ ciphertextB64: 'not base64?' })), null);
  // Метка об удалении с шифротекстом — новый формат (v4.32.523); с null —
  // старый, от клиентов, которые ещё не обновились. Принимаются оба.
  assert.ok(validateMutation(mutation({ deleted: true, ciphertextB64: null })));
  assert.ok(validateMutation(mutation({ deleted: true })));
  assert.equal(validateMutation(mutation({ deleted: false, ciphertextB64: null })), null);
});

test('push is idempotent and rejects stale entity revisions', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(db.ensureAccount('a'.repeat(32), 'owner-a'), { ok: true });
  assert.deepEqual(db.ensureDevice('a'.repeat(32), 'phone-1', null, 'Phone'), { ok: true });

  const firstMutation = mutation();
  const first = db.push('a'.repeat(32), 'phone-1', [firstMutation]);
  assert.deepEqual(first.acceptedMutationIds, ['m-1']);
  assert.deepEqual(first.rejectedMutationIds, []);

  const duplicate = db.push('a'.repeat(32), 'phone-1', [firstMutation]);
  assert.deepEqual(duplicate.acceptedMutationIds, ['m-1']);
  assert.deepEqual(duplicate.rejectedMutationIds, []);
  assert.throws(
    () => db.push('a'.repeat(32), 'phone-1', [mutation({ ciphertextB64: Buffer.from('different').toString('base64') })]),
    (error) => error.code === 'sync_mutation_conflict',
  );

  const stale = db.push('a'.repeat(32), 'phone-1', [mutation({ mutationId: 'm-0', revision: 1 })]);
  assert.deepEqual(stale.acceptedMutationIds, []);
  assert.deepEqual(stale.rejectedMutationIds, ['m-0']);
  assert.throws(
    () => db.push('a'.repeat(32), 'phone-1', [mutation({ mutationId: 'bad', deleted: 'no' })]),
    /invalid_sync_mutation/,
  );
});

test('pull is cursor based and preserves tombstones', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'b'.repeat(32);
  db.ensureAccount(account, 'owner-b');
  db.ensureDevice(account, 'tablet-1', null, 'Tablet');
  db.push(account, 'tablet-1', [mutation({ mutationId: 'm-1', entityId: 'p-1' })]);
  db.push(account, 'tablet-1', [mutation({
    mutationId: 'm-2', entityId: 'p-1', revision: 2, deleted: true, ciphertextB64: null,
  })]);

  const first = db.pull(account, 'tablet-1', null, 1);
  assert.equal(first.mutations.length, 1);
  assert.equal(first.mutations[0].deleted, false);
  assert.equal(first.hasMore, true);
  const second = db.pull(account, 'tablet-1', first.nextCursor, 1);
  assert.equal(second.mutations.length, 1);
  assert.equal(second.mutations[0].deleted, true);
  assert.equal(second.mutations[0].ciphertextB64, null);
  assert.equal(second.hasMore, false);
  const jumped = db.pull(account, 'tablet-1', '999999', 1);
  assert.equal(jumped.mutations.length, 0);
  assert.equal(jumped.nextCursor, second.nextCursor);
});

test('pull can isolate one local profile inside a seed-bound account', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'p'.repeat(32);
  db.ensureAccount(account, 'owner-p');
  db.ensureDevice(account, 'phone-1', null, 'Phone');
  db.ensureDevice(account, 'phone-2', null, 'Tablet');
  db.push(account, 'phone-1', [mutation({ mutationId: 'profile-one', ownerProfileId: 1, entityId: 'one' })]);
  db.push(account, 'phone-1', [mutation({ mutationId: 'profile-two', ownerProfileId: 2, entityId: 'two' })]);
  const result = db.pull(account, 'phone-2', null, 10, 2);
  assert.deepEqual(result.mutations.map((item) => item.ownerProfileId), [2]);
});

test('profile-scoped pulls keep cursors separate from the account cursor', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'r'.repeat(32);
  db.ensureAccount(account, 'owner-r');
  db.ensureDevice(account, 'phone-1', null, 'Phone');
  db.push(account, 'phone-1', [mutation({ mutationId: 'profile-1', entityId: 'one', ownerProfileId: 1 })]);
  db.push(account, 'phone-1', [mutation({ mutationId: 'profile-2', entityId: 'two', ownerProfileId: 2 })]);

  const profilePull = db.pull(account, 'phone-1', null, 10, 1);
  assert.deepEqual(profilePull.mutations.map((item) => item.mutationId), ['profile-1']);
  const accountPull = db.pull(account, 'phone-1', null, 10);
  assert.deepEqual(accountPull.mutations.map((item) => item.mutationId), ['profile-1', 'profile-2']);
  const cursors = db.db.prepare(`
    SELECT owner_profile_id AS ownerProfileId, cursor
    FROM sync_device_cursors WHERE account_id = ? AND device_id = ?
    ORDER BY owner_profile_id
  `).all(account, 'phone-1');
  assert.deepEqual(cursors.map((cursor) => ({ ...cursor })), [
    { ownerProfileId: 0, cursor: 2 },
    { ownerProfileId: 1, cursor: 1 },
  ]);
});

test('enforces a per-account ciphertext quota before committing a batch', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'q'.repeat(32);
  db.ensureAccount(account, 'owner-q');
  db.ensureDevice(account, 'phone-1', null, 'Phone');
  assert.throws(
    () => db.push(account, 'phone-1', [mutation({ mutationId: 'quota', ciphertextB64: 'MTIzNDU2' })], 5),
    (error) => error.code === 'sync_account_quota',
  );
  assert.equal(db.latestCursor(account), null);
});

test('entity revisions are isolated between local profiles', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'e'.repeat(32);
  db.ensureAccount(account, 'owner-e');
  db.ensureDevice(account, 'phone-1', null, 'Phone');
  const first = db.push(account, 'phone-1', [mutation({
    mutationId: 'profile-1-message', entityId: 'shared-id', ownerProfileId: 1,
  })]);
  const second = db.push(account, 'phone-1', [mutation({
    mutationId: 'profile-2-message', entityId: 'shared-id', ownerProfileId: 2,
  })]);
  assert.deepEqual(first.rejectedMutationIds, []);
  assert.deepEqual(second.rejectedMutationIds, []);
  assert.deepEqual(second.acceptedMutationIds, ['profile-2-message']);
});

test('migrates pre-profile entity heads without losing revision history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-sync-migrate-'));
  const filename = path.join(dir, 'sync.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE sync_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    CREATE TABLE sync_accounts (
      account_id TEXT PRIMARY KEY NOT NULL,
      owner_public_key_b64 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE sync_entity_heads (
      account_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      mutation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (account_id, entity_kind, entity_id)
    );
  `);
  legacy.prepare('INSERT INTO sync_accounts VALUES (?, ?, ?, ?)').run(
    'f'.repeat(32), 'owner-f', Date.now(), Date.now(),
  );
  legacy.prepare('INSERT INTO sync_entity_heads VALUES (?, ?, ?, ?, ?, ?)').run(
    'f'.repeat(32), 'message', 'legacy-message', 4, 'legacy-mutation', 7,
  );
  legacy.close();

  const db = new SyncDatabase(filename);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const columns = db.db.prepare('PRAGMA table_info(sync_entity_heads)').all();
  assert.ok(columns.some((column) => column.name === 'owner_profile_id'));
  db.ensureAccount('f'.repeat(32), 'owner-f');
  db.ensureDevice('f'.repeat(32), 'phone-1', null, 'Phone');
  const stale = db.push('f'.repeat(32), 'phone-1', [mutation({
    mutationId: 'new-stale', entityId: 'legacy-message', revision: 4,
  })]);
  assert.deepEqual(stale.rejectedMutationIds, ['new-stale']);
});

test('migrates session metadata columns and keeps coarse device details', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-sync-devices-migrate-'));
  const filename = path.join(dir, 'sync.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE sync_accounts (
      account_id TEXT PRIMARY KEY NOT NULL,
      owner_public_key_b64 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE sync_devices (
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_public_key_b64 TEXT,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      PRIMARY KEY (account_id, device_id)
    );
  `);
  legacy.close();

  const db = new SyncDatabase(filename);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const columns = new Set(db.db.prepare('PRAGMA table_info(sync_devices)').all().map((column) => column.name));
  for (const column of ['platform', 'device_model', 'os_version', 'app_version', 'country_code', 'city']) {
    assert.ok(columns.has(column), `missing ${column}`);
  }
  const account = 'g'.repeat(32);
  db.ensureAccount(account, 'owner-g');
  db.ensureDevice(account, 'phone-1', null, 'AirChat', {
    platform: 'ios', model: 'iPhone 17', osVersion: '19.0', appVersion: '4.32.527',
  }, { countryCode: 'RU', city: 'Moscow' });
  const [device] = db.listDevices(account);
  assert.equal(device.deviceId, 'phone-1');
  assert.equal(device.label, 'AirChat');
  assert.equal(device.platform, 'ios');
  assert.equal(device.deviceModel, 'iPhone 17');
  assert.equal(device.osVersion, '19.0');
  assert.equal(device.appVersion, '4.32.527');
  assert.equal(device.countryCode, 'RU');
  assert.equal(device.city, 'Moscow');
  assert.equal(device.revokedAt, null);
  assert.ok(Number.isSafeInteger(device.createdAt));
  assert.ok(Number.isSafeInteger(device.lastSeenAt));
});

test('migrates legacy device cursors into an account-scoped cursor', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-sync-cursors-migrate-'));
  const filename = path.join(dir, 'sync.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE sync_accounts (
      account_id TEXT PRIMARY KEY NOT NULL,
      owner_public_key_b64 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE sync_devices (
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_public_key_b64 TEXT,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      PRIMARY KEY (account_id, device_id)
    );
    CREATE TABLE sync_device_cursors (
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, device_id)
    );
  `);
  legacy.prepare('INSERT INTO sync_accounts VALUES (?, ?, ?, ?)').run(
    't'.repeat(32), 'owner-t', Date.now(), Date.now(),
  );
  legacy.prepare('INSERT INTO sync_devices VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    't'.repeat(32), 'phone-1', null, 'Phone', Date.now(), Date.now(), null,
  );
  legacy.prepare('INSERT INTO sync_device_cursors VALUES (?, ?, ?, ?)').run(
    't'.repeat(32), 'phone-1', 7, Date.now(),
  );
  legacy.close();

  const db = new SyncDatabase(filename);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const columns = db.db.prepare('PRAGMA table_info(sync_device_cursors)').all();
  assert.ok(columns.some((column) => column.name === 'owner_profile_id'));
  assert.deepEqual({ ...db.db.prepare(
    'SELECT owner_profile_id, cursor FROM sync_device_cursors WHERE account_id = ? AND device_id = ?',
  ).get('t'.repeat(32), 'phone-1') }, { owner_profile_id: 0, cursor: 7 });
});

test('account keys and revoked devices cannot be reused', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'c'.repeat(32);
  assert.deepEqual(db.ensureAccount(account, 'owner-c'), { ok: true });
  assert.deepEqual(db.ensureAccount(account, 'other-owner'), { ok: false, reason: 'account_key_mismatch' });
  assert.deepEqual(db.ensureDevice(account, 'phone-1', 'key-1', null), { ok: true });
  assert.equal(db.revokeDevice(account, 'phone-1'), true);
  assert.deepEqual(db.ensureDevice(account, 'phone-1', 'key-1', null), { ok: false, reason: 'device_revoked' });
});

test('serializes first account claims and limits active devices without blocking idle clients', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-sync-device-policy-'));
  const filename = path.join(dir, 'sync.sqlite');
  const first = new SyncDatabase(filename);
  const second = new SyncDatabase(filename);
  t.after(() => {
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const account = 'h'.repeat(32);
  assert.deepEqual(first.ensureAccount(account, 'owner-h'), { ok: true });
  assert.deepEqual(second.ensureAccount(account, 'owner-h'), { ok: true });
  assert.deepEqual(first.ensureDevice(account, 'phone-1', 'key-h-1', 'Phone', null, null, true, {
    now: 1_000, maxActiveDevices: 2, idleTtlMs: 1_000,
  }), { ok: true });
  assert.deepEqual(first.ensureDevice(account, 'phone-2', 'key-h-2', 'Tablet', null, null, true, {
    now: 1_000, maxActiveDevices: 2, idleTtlMs: 1_000,
  }), { ok: true });
  assert.deepEqual(first.ensureDevice(account, 'laptop-1', 'key-h-3', 'Laptop', null, null, true, {
    now: 1_000, maxActiveDevices: 2, idleTtlMs: 1_000,
  }), { ok: false, reason: 'device_limit_exceeded' });

  // Idle devices stop consuming active slots. A known device can return with
  // the same key, so the TTL does not require a client-side migration.
  assert.deepEqual(first.ensureDevice(account, 'laptop-1', 'key-h-3', 'Laptop', null, null, true, {
    now: 3_000, maxActiveDevices: 2, idleTtlMs: 1_000,
  }), { ok: true });
  assert.deepEqual(first.ensureDevice(account, 'phone-1', 'key-h-1', 'Phone', null, null, false, {
    now: 3_000, maxActiveDevices: 2, idleTtlMs: 1_000,
  }), { ok: true });
  assert.deepEqual(first.ensureDevice(account, 'phone-2', 'key-h-2', 'Tablet', null, null, false, {
    now: 3_000, maxActiveDevices: 2, idleTtlMs: 1_000,
  }), { ok: false, reason: 'device_limit_exceeded' });
  const devices = first.listDevices(account, { now: 3_000, idleTtlMs: 1_000 });
  assert.deepEqual(devices.map((device) => [device.deviceId, device.active]), [
    ['phone-1', true],
    ['phone-2', false],
    ['laptop-1', true],
  ]);
});

test('compacts mutations only through every active device cursor', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'i'.repeat(32);
  db.ensureAccount(account, 'owner-i');
  db.ensureDevice(account, 'phone-1', null, 'Phone');
  db.ensureDevice(account, 'phone-2', null, 'Tablet');
  db.push(account, 'phone-1', [mutation({ mutationId: 'gc-1', entityId: 'gc-1' })]);
  db.push(account, 'phone-1', [mutation({ mutationId: 'gc-2', entityId: 'gc-2' })]);

  const firstPull = db.pull(account, 'phone-1', null, 100);
  assert.equal(firstPull.mutations.length, 2);
  assert.equal(db.compactSyncMutations(account).deleted, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM sync_mutations WHERE account_id = ?').get(account).count, 2);

  const secondPull = db.pull(account, 'phone-2', null, 100);
  assert.equal(secondPull.mutations.length, 2);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM sync_mutations WHERE account_id = ?').get(account).count, 0);
  const compacted = db.compactSyncMutations(account);
  assert.equal(compacted.deleted, 0);
  assert.equal(compacted.activeDevices, 2);
  assert.equal(db.latestCursor(account), secondPull.nextCursor);

  // A stale pull cannot move the device cursor backwards after compaction.
  db.pull(account, 'phone-2', '0', 100);
  assert.equal(db.db.prepare(
    'SELECT cursor FROM sync_device_cursors WHERE account_id = ? AND device_id = ?',
  ).get(account, 'phone-2').cursor, Number(secondPull.nextCursor));
});

test('media GC requires an explicit delete request and no active references', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'm'.repeat(32);
  const mediaId = '1'.repeat(32);
  db.ensureAccount(account, 'owner-m');
  db.registerMedia(account, mediaId, 123, 1000);

  assert.deepEqual(db.mediaGcCandidates(account, 2000), []);
  assert.deepEqual(db.setMediaReference(account, mediaId, 'message-1', true, 1100), { ok: true });
  assert.deepEqual(db.requestMediaDelete(account, mediaId, 1200), {
    ok: true,
    activeReferences: 1,
  });
  assert.deepEqual(db.mediaGcCandidates(account, 2200), []);

  assert.deepEqual(db.setMediaReference(account, mediaId, 'message-1', false, 1300), { ok: true });
  const candidates = db.mediaGcCandidates(account, 2200);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mediaId, mediaId);
  assert.equal(db.markMediaDeleted(account, mediaId, 2300), true);
  assert.equal(db.mediaGcCandidates(account, 3000).length, 0);
  assert.equal(db.getMedia(account, mediaId).deletedAt, 2300);
  assert.deepEqual(db.setMediaReference(account, mediaId, 'message-2', true, 2400), {
    ok: false,
    reason: 'media_deleted',
  });
});

test('media deletion is guarded against missing requests and active references', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 's'.repeat(32);
  const mediaId = '3'.repeat(32);
  db.ensureAccount(account, 'owner-s');
  db.registerMedia(account, mediaId, 10, 1000);
  assert.equal(db.markMediaDeleted(account, mediaId, 1100), false);
  db.requestMediaDelete(account, mediaId, 1200);
  db.setMediaReference(account, mediaId, 'message-1', true, 1300);
  assert.equal(db.markMediaDeleted(account, mediaId, 1400), false);
  db.setMediaReference(account, mediaId, 'message-1', false, 1500);
  assert.equal(db.markMediaDeleted(account, mediaId, 1600), true);
});

test('re-uploading a media id cancels a pending delete', (t) => {
  const { db, dir } = makeDb();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = 'n'.repeat(32);
  const mediaId = '2'.repeat(32);
  db.ensureAccount(account, 'owner-n');
  db.registerMedia(account, mediaId, 10, 1000);
  db.requestMediaDelete(account, mediaId, 1100);
  db.registerMedia(account, mediaId, 20, 1200);
  const media = db.getMedia(account, mediaId);
  assert.equal(media.bytes, 20);
  assert.equal(media.deleteRequestedAt, null);
  assert.equal(media.deletedAt, null);
  assert.deepEqual(db.mediaGcCandidates(account, 5000), []);
});
