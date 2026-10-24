#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DatabaseSync, backup } = require('node:sqlite');

function digest(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function inspectDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('database integrity failed');
    const counts = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      counts[name] = Number(db.prepare('SELECT count(*) n FROM "' + name.replaceAll('"', '""') + '"').get().n);
    }
    return counts;
  } finally { db.close(); }
}
function syncPath(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function mediaInventory(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_media'").get()) return [];
    return db.prepare('SELECT account_id, media_id, bytes FROM sync_media WHERE deleted_at IS NULL').all().map(row => {
      if (!/^[a-f0-9]{32}$/.test(row.account_id) || !/^[a-f0-9]{32}$/.test(row.media_id) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('invalid media inventory');
      return { name: `media/${row.account_id}/${row.media_id}.bin`, bytes: row.bytes };
    });
  } finally { db.close(); }
}
function verifyMediaArchive(dir, required) {
  if (!required.length) return;
  const archive = path.join(dir, 'media.tar.gz');
  if (!fs.existsSync(archive)) throw new Error('required media archive missing');
  // Extract individual members only to stdout: archive paths can never write
  // outside the verification scratch file, including symlinks/absolute names.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-backup-verify-'));
  try {
    const file = path.join(scratch, 'blob');
    for (const entry of required) {
      const fd = fs.openSync(file, 'w', 0o600);
      try { execFileSync('tar', ['-xOzf', archive, entry.name], { stdio: ['ignore', fd, 'pipe'] }); }
      finally { fs.closeSync(fd); }
      if (fs.statSync(file).size !== entry.bytes) throw new Error('media inventory size mismatch');
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
function verifyBackup(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  if (m.version !== 1 || !Array.isArray(m.files) || m.files.length < 2) throw new Error('incomplete manifest');
  const names = new Set(m.files.map(entry => entry.name));
  if (names.size !== m.files.length || !['sync.sqlite', 'push-tokens.db'].every(name => m.files.some(entry => entry.name === name && entry.tables))) throw new Error('incomplete manifest');
  for (const entry of m.files) {
    if (typeof entry.name !== 'string' || path.isAbsolute(entry.name) || entry.name.split('/').includes('..')) throw new Error('unsafe manifest path');
    const file = path.join(dir, entry.name);
    if (!fs.statSync(file).isFile() || digest(file) !== entry.sha256) throw new Error('backup checksum mismatch');
    if (entry.tables && JSON.stringify(inspectDatabase(file)) !== JSON.stringify(entry.tables)) throw new Error('backup table counts mismatch');
  }
  if (m.files.filter(x => x.name.startsWith('snapshots/')).length !== m.snapshots) throw new Error('snapshot count mismatch');
  const required = mediaInventory(path.join(dir, 'sync.sqlite'));
  if (required.length && !names.has('media.tar.gz')) throw new Error('required media archive missing');
  verifyMediaArchive(dir, required);
  return m;
}
async function createBackup(options = {}) {
  const root = options.root ?? process.env.AIRCHAT_BACKUP_DIR ?? '/var/backups/airchat';
  const vault = options.vault ?? process.env.CLOUD_VAULT_DIR ?? '/var/lib/airchat-cloud-vault';
  const signal = options.signalDb ?? process.env.PUSH_TOKEN_DB ?? '/var/lib/airchat-signaling/push-tokens.db';
  const keep = Number(options.keep ?? process.env.AIRCHAT_BACKUP_KEEP ?? 14);
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('backup retention must be a positive integer');
  const databases = [path.join(vault, 'sync.sqlite'), signal];
  for (const db of databases) if (!fs.statSync(db).isFile()) throw new Error('required database missing');
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(root, '.partial-'));
  const manifest = { version: 1, createdAt: new Date().toISOString(), snapshots: 0, files: [] };
  const record = (name, extra = {}) => {
    const file = path.join(staging, name); fs.chmodSync(file, 0o600);
    manifest.files.push({ name, bytes: fs.statSync(file).size, sha256: digest(file), ...extra });
  };
  try {
    for (const [i, src] of databases.entries()) {
      const name = ['sync.sqlite', 'push-tokens.db'][i];
      const dest = path.join(staging, name);
      const db = new DatabaseSync(src, { readOnly: true });
      try { await backup(db, dest); } finally { db.close(); }
      record(name, { tables: inspectDatabase(dest) });
    }
    fs.mkdirSync(path.join(staging, 'snapshots'), { mode: 0o700 });
    // Vault replaces snapshots atomically; copyFile reads one complete version.
    for (const entry of fs.readdirSync(vault, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) throw new Error('snapshot is not a regular file');
      const name = 'snapshots/' + entry.name;
      fs.copyFileSync(path.join(vault, entry.name), path.join(staging, name));
      JSON.parse(fs.readFileSync(path.join(staging, name)));
      record(name); manifest.snapshots += 1;
    }
    const media = path.join(vault, 'media');
    if (fs.existsSync(media)) {
      execFileSync('tar', ['-C', vault, '-czf', path.join(staging, 'media.tar.gz'), 'media']);
      record('media.tar.gz');
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    verifyBackup(staging);
    const dest = path.join(root, stamp);
    // Durability precedes visibility and retention: a successful rename alone
    // does not persist newly copied bytes across a machine/power failure.
    for (const entry of manifest.files) syncPath(path.join(staging, entry.name));
    syncPath(path.join(staging, 'manifest.json'));
    syncPath(path.join(staging, 'snapshots'));
    syncPath(staging);
    fs.renameSync(staging, dest);
    syncPath(root);
    // Only successful, verified backups participate in retention.
    const completed = fs.readdirSync(root).filter(n => /^\d{8}T\d{9}Z$/.test(n)).sort();
    for (const old of completed.slice(0, Math.max(0, completed.length - keep))) fs.rmSync(path.join(root, old), { recursive: true });
    syncPath(root);
    return dest;
  } catch (e) { fs.rmSync(staging, { recursive: true, force: true }); throw e; }
}
if (require.main === module) {
  const work = process.argv[2] === '--verify' ? Promise.resolve().then(() => verifyBackup(process.argv[3])) : createBackup();
  work.then(() => console.log('backup verified')).catch(e => { console.error('backup failed:', e.message); process.exitCode = 1; });
}
module.exports = { createBackup, verifyBackup };
