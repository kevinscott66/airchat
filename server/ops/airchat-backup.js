#!/usr/bin/env node
/**
 * Ежедневная копия серверных данных AirChat (запускается airchat-backup.timer).
 *
 * SQLite копируется через online backup API (node:sqlite), а не cp: база в
 * WAL-режиме, и копия файла посреди записи может оказаться несогласованной.
 * Каждая копия проверяется PRAGMA integrity_check. Медиа — tar.gz.
 *
 * Это защита от порчи данных и ошибок выкладки, не от потери диска: копии
 * лежат на той же машине. Выносить их наружу — отдельный шаг (см. README).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync, backup } = require('node:sqlite');

const ROOT = process.env.AIRCHAT_BACKUP_DIR || '/var/backups/airchat';
const KEEP = Number(process.env.AIRCHAT_BACKUP_KEEP || 14);
const DATABASES = [
  '/var/lib/airchat-cloud-vault/sync.sqlite',
  '/var/lib/airchat-signaling/push-tokens.db',
];
const MEDIA_DIR = '/var/lib/airchat-cloud-vault/media';

async function main() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const dir = path.join(ROOT, stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const src of DATABASES) {
    if (!fs.existsSync(src)) {
      console.log(`skip ${src}: нет файла`);
      continue;
    }
    const dest = path.join(dir, path.basename(src));
    const db = new DatabaseSync(src, { readOnly: true });
    try {
      await backup(db, dest);
    } finally {
      db.close();
    }
    const check = new DatabaseSync(dest, { readOnly: true });
    const result = check.prepare('PRAGMA integrity_check').get();
    check.close();
    const verdict = Object.values(result)[0];
    if (verdict !== 'ok') throw new Error(`${dest}: integrity_check = ${verdict}`);
    fs.chmodSync(dest, 0o600);
    console.log(`ok ${src} → ${dest} (${fs.statSync(dest).size} B)`);
  }

  if (fs.existsSync(MEDIA_DIR)) {
    const dest = path.join(dir, 'media.tar.gz');
    execFileSync('tar', ['-C', path.dirname(MEDIA_DIR), '-czf', dest, path.basename(MEDIA_DIR)]);
    fs.chmodSync(dest, 0o600);
    console.log(`ok ${MEDIA_DIR} → ${dest} (${fs.statSync(dest).size} B)`);
  }

  const all = fs.readdirSync(ROOT).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    fs.rmSync(path.join(ROOT, old), { recursive: true, force: true });
    console.log(`rotate ${old}`);
  }
}

main().catch((err) => {
  console.error(`backup failed: ${err.stack || err}`);
  process.exit(1);
});
