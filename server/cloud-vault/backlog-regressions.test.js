const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SyncDatabase } = require('./sync-db');
const { assertFileStorageBudget } = require('./storage-budget');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-regression-'));
  const db = new SyncDatabase(path.join(dir, 'sync.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, dir };
}
function mutation(revision, ownerProfileId = 1, deleted = false) {
  return { mutationId: `m-${ownerProfileId}-${revision}`, entityKind: 'message', entityId: 'message', ownerProfileId, revision, deleted,
    ciphertextB64: deleted ? null : Buffer.from(`snapshot-${revision}`).toString('base64'), updatedAt: Date.now() };
}

test('snapshot compaction preserves retry, fresh device, profile isolation and tombstones', (t) => {
  const { db } = fixture(t);
  db.ensureAccount('account', 'owner'); db.ensureDevice('account', 'phone', null, null);
  db.push('account', 'phone', [mutation(1), mutation(1, 2)]);
  const first = db.pull('account', 'phone', null, 100);
  assert.deepEqual(db.pull('account', 'phone', null, 100).mutations, first.mutations);
  assert.equal(db.db.prepare('SELECT cursor FROM sync_device_cursors').get().cursor, 0);
  for (let revision = 2; revision <= 100; revision++) db.push('account', 'phone', [mutation(revision)], 2000);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM sync_mutations').get().n, 2);
  db.push('account', 'phone', [mutation(101, 1, true)], 2000);
  db.ensureDevice('account', 'new', null, null);
  const recovered = db.pull('account', 'new', null, 100);
  assert.equal(recovered.mutations.length, 2);
  assert.equal(recovered.mutations.find((m) => m.ownerProfileId === 1).deleted, true);
  assert.equal(recovered.mutations.find((m) => m.ownerProfileId === 2).revision, 1);
  assert.equal(db.pull('account', 'new', first.nextCursor, 100, 1).mutations[0].revision, 101);
});

test('empty tombstones cost storage and failed quota leaves prior snapshot intact', (t) => {
  const { db } = fixture(t);
  db.ensureAccount('account', 'owner'); db.ensureDevice('account', 'phone', null, null);
  assert.throws(() => db.push('account', 'phone', [mutation(1, 1, true)], 1), /sync_account_quota/);
  db.push('account', 'phone', [mutation(1)]);
  assert.throws(() => db.push('account', 'phone', [mutation(2)], 1), /sync_account_quota/);
  assert.equal(db.pull('account', 'phone', null, 100).mutations[0].revision, 1);
});

test('owner and revision survive revoke and GC; refresh never activates, registry fails closed', (t) => {
  const { db } = fixture(t);
  const put = (key, revision, action = 'publish') => db.putPublicPost('link', key, key, 'payload', 'sig', { expectedRevision: revision, action, maxOwners: 1 });
  assert.equal(put('a', 0).revision, 1);
  assert.equal(db.revokePublicPost('link', 'a', 1).revision, 2);
  assert.equal(put('b', 0).reason, 'public_post_owned');
  assert.equal(put('a', 1, 'refresh').reason, 'public_post_revision_conflict');
  assert.equal(put('a', 2, 'refresh').reason, 'public_post_inactive');
  assert.equal(put('a', 2).revision, 3);
  db.gcPublicPosts({ maxTotalBytes: 1 });
  assert.deepEqual(db.publicPostState('link', 'a'), { ok: true, revision: 4, active: false });
  assert.equal(put('b', 0).reason, 'public_post_owned');
  assert.equal(db.putPublicPost('new', 'b', 'b', 'x', 's', { maxOwners: 1 }).reason, 'public_post_owner_quota');
  assert.equal(put('a', 4).ok, true);
});

test('avatar delete wins against delayed or equal-time publication', (t) => {
  const { db } = fixture(t);
  const put = (ts) => db.putPublicAvatar('key', 'image/jpeg', Buffer.from('x'), ts, { maxTotalBytes: 100 });
  assert.equal(put(100).ok, true); db.deletePublicAvatar('key', 300);
  assert.equal(put(200).reason, 'stale'); assert.equal(put(300).reason, 'stale');
  assert.equal(db.getPublicAvatar('key'), null); assert.equal(put(301).ok, true);
});

test('nonce cleanup is indexed, bounded and keeps unexpired replay protection', (t) => {
  const { db } = fixture(t);
  const insert = db.db.prepare('INSERT INTO sync_nonces VALUES (?, ?, ?)');
  for (let i = 0; i < 600; i++) insert.run('a', String(i), 1);
  assert.equal(db.consumeNonce('a', 'fresh', 2000000), true);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM sync_nonces WHERE seen_at=1').get().n, 100);
  assert.equal(db.consumeNonce('a', 'fresh', 2000000), false);
  const plan = db.db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM sync_nonces WHERE seen_at < ? ORDER BY seen_at LIMIT 500').all(2);
  assert.ok(plan.some((r) => r.detail.includes('idx_sync_nonces_seen')));
});

test('file budget accounts all identities and reserve before temporary allocation', (t) => {
  const { dir } = fixture(t);
  const statfs = () => ({ bavail: 100000, bsize: 4096 });
  assert.throws(() => assertFileStorageBudget(dir, 1, { maxBytes: 1, reserveBytes: 0, statfs }), /storage_quota/);
  assert.throws(() => assertFileStorageBudget(dir, 1, { reserveBytes: 1, statfs: () => ({ bavail: 0, bsize: 4096 }) }), /storage_reserve/);
  assert.doesNotThrow(() => assertFileStorageBudget(dir, 1, { reserveBytes: 0, statfs }));
});

test('future schema refuses startup without downgrading version marker', (t) => {
  const { db, dir } = fixture(t);
  db.db.prepare("UPDATE sync_meta SET value='999' WHERE key='schema_version'").run();
  assert.throws(() => new SyncDatabase(path.join(dir, 'sync.sqlite')), /unsupported_sync_schema/);
  assert.equal(db.db.prepare("SELECT value FROM sync_meta WHERE key='schema_version'").get().value, '999');
});

test('fatal runtime error exits nonzero instead of continuing unhealthy', (t) => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fatal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'fatal.cjs');
  fs.writeFileSync(preload, "setImmediate(() => { throw new Error('synthetic-fatal'); });");
  const child = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'index.js')], {
    env: { ...process.env, CLOUD_VAULT_DIR: dir, SYNC_DB_FILE: path.join(dir, 'db.sqlite'), HOST: '127.0.0.1', PORT: '0' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 1); assert.match(child.stderr, /cloud-vault fatal synthetic-fatal/);
});

test('version five live copies are backfilled into persistent ownership on reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-v5-'));
  const filename = path.join(dir, 'sync.sqlite');
  let db = new SyncDatabase(filename);
  try {
    db.putPublicPost('old-link', 'owner', 'key', 'body', 'sig');
    db.db.exec("DROP TABLE public_post_owners; DROP TABLE public_avatar_deletions; UPDATE sync_meta SET value='5' WHERE key='schema_version'");
    db.close(); db = new SyncDatabase(filename);
    assert.deepEqual(db.publicPostState('old-link', 'key'), { ok: true, revision: 1, active: true });
    assert.equal(db.db.prepare("SELECT value FROM sync_meta WHERE key='schema_version'").get().value, '6');
    db.deletePublicPostByKey('old-link', 'key');
    assert.equal(db.putPublicPost('old-link', 'other', 'other', 'body', 'sig').reason, 'public_post_owned');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SQLite global page ceiling rejects allocation beyond its configured capacity', (t) => {
  const { db } = fixture(t);
  db.db.exec('CREATE TABLE quota_fixture (bytes BLOB)');
  const pages = db.db.prepare('PRAGMA page_count').get().page_count;
  db.db.exec(`PRAGMA max_page_count = ${pages + 1}`);
  assert.throws(() => db.db.prepare('INSERT INTO quota_fixture VALUES (?)').run(Buffer.alloc(1024 * 1024)), /full/i);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM quota_fixture').get().n, 0);
});
