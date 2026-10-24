'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createBackup, verifyBackup } = require('./airchat-backup');
test('restore drill includes both databases and opaque account snapshots; missing/corrupt artifacts fail verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-backup-'));
  try {
    const vault = path.join(dir, 'vault'); fs.mkdirSync(vault);
    const signalDb = path.join(dir, 'push-tokens.db');
    for (const file of [path.join(vault, 'sync.sqlite'), signalDb]) {
      const db = new DatabaseSync(file); db.exec('CREATE TABLE fixture(id TEXT); INSERT INTO fixture VALUES (\'preserved\')'); db.close();
    }
    fs.writeFileSync(path.join(vault, 'account.json'), JSON.stringify({ envelope: { ciphertext: 'opaque-fixture' } }));
    fs.mkdirSync(path.join(vault, 'media'));
    fs.writeFileSync(path.join(vault, 'media', 'opaque.bin'), Buffer.from([1, 7, 255]));
    const root = path.join(dir, 'backups');
    const dest = await createBackup({ root, vault, signalDb });
    const manifest = verifyBackup(dest);
    assert.equal(manifest.snapshots, 1);
    assert.equal(manifest.files.find(x => x.name === 'sync.sqlite').tables.fixture, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'snapshots/account.json'))).envelope.ciphertext, 'opaque-fixture');
    const restored = new DatabaseSync(path.join(dest, 'sync.sqlite'), { readOnly: true });
    assert.equal(restored.prepare('SELECT id FROM fixture').get().id, 'preserved'); restored.close();
    const mediaRestore = path.join(dir, 'restored'); fs.mkdirSync(mediaRestore);
    execFileSync('tar', ['-xzf', path.join(dest, 'media.tar.gz'), '-C', mediaRestore]);
    assert.deepEqual(fs.readFileSync(path.join(mediaRestore, 'media/opaque.bin')), Buffer.from([1, 7, 255]));
    const incomplete = { ...manifest, files: manifest.files.filter(entry => entry.name !== 'push-tokens.db') };
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(incomplete));
    assert.throws(() => verifyBackup(dest), /incomplete manifest/);
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dest, 'snapshots/account.json'), '{}');
    assert.throws(() => verifyBackup(dest), /checksum/);
    fs.unlinkSync(signalDb);
    await assert.rejects(createBackup({ root, vault, signalDb }));
    assert.equal(fs.readdirSync(root).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('copied database media inventory must exist at expected size before rotation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-backup-media-'));
  try {
    const vault = path.join(dir, 'vault'); fs.mkdirSync(vault);
    const signalDb = path.join(dir, 'push-tokens.db');
    const account = 'a'.repeat(32), mediaId = 'b'.repeat(32);
    const db = new DatabaseSync(path.join(vault, 'sync.sqlite'));
    db.exec('CREATE TABLE sync_media(account_id TEXT, media_id TEXT, bytes INTEGER, deleted_at INTEGER)');
    db.prepare('INSERT INTO sync_media VALUES (?, ?, 3, NULL)').run(account, mediaId); db.close();
    const signal = new DatabaseSync(signalDb); signal.exec('CREATE TABLE fixture(id TEXT)'); signal.close();
    const media = path.join(vault, 'media', account); fs.mkdirSync(media, { recursive: true });
    const blob = path.join(media, `${mediaId}.bin`); fs.writeFileSync(blob, 'abc');
    const options = { root: path.join(dir, 'backups'), vault, signalDb, keep: 1 };
    const good = await createBackup(options);
    assert.ok(verifyBackup(good));
    fs.writeFileSync(blob, 'wrong-size');
    await assert.rejects(createBackup(options), /media inventory size mismatch/);
    assert.deepEqual(fs.readdirSync(options.root), [path.basename(good)]);
    fs.rmSync(path.join(vault, 'media'), { recursive: true });
    await assert.rejects(createBackup(options), /required media archive missing/);
    assert.deepEqual(fs.readdirSync(options.root), [path.basename(good)]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('durability failure never rotates the previous verified backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-backup-fsync-'));
  const originalSync = fs.fsyncSync;
  try {
    const vault = path.join(dir, 'vault'); fs.mkdirSync(vault);
    const signalDb = path.join(dir, 'push-tokens.db');
    for (const file of [path.join(vault, 'sync.sqlite'), signalDb]) {
      const db = new DatabaseSync(file); db.exec('CREATE TABLE fixture(id TEXT)'); db.close();
    }
    const options = { root: path.join(dir, 'backups'), vault, signalDb, keep: 1 };
    const good = await createBackup(options);
    fs.fsyncSync = () => { throw new Error('synthetic durability failure'); };
    await assert.rejects(createBackup(options), /synthetic durability failure/);
    assert.deepEqual(fs.readdirSync(options.root), [path.basename(good)]);
    fs.fsyncSync = originalSync;
    assert.ok(verifyBackup(good));
  } finally { fs.fsyncSync = originalSync; fs.rmSync(dir, { recursive: true, force: true }); }
});
