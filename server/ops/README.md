# Server operations

## Backups

`airchat-backup.js` runs daily through `airchat-backup.timer` at 03:20 UTC. It creates online backups of cloud-vault `sync.sqlite` and signaling `push-tokens.db`, copies account snapshot JSON files, runs `PRAGMA integrity_check` and records table counts, archives media, and retains the latest 14 backups in `/var/backups/airchat/<date>/`.

Install or update on the configured server:

```bash
scp server/ops/airchat-backup.* vps78:/tmp/
ssh vps78 'sudo install -d -m 700 /opt/airchat-ops /var/backups/airchat &&
  sudo install -m 644 /tmp/airchat-backup.js /opt/airchat-ops/ &&
  sudo install -m 644 /tmp/airchat-backup.service /tmp/airchat-backup.timer /etc/systemd/system/ &&
  sudo systemctl daemon-reload && sudo systemctl enable --now airchat-backup.timer'
```

Each backup has a SHA-256 manifest. A missing database or failed copy aborts creation; rotation runs only after the complete backup verifies and is atomically renamed out of staging. Hashing uses bounded memory. Before rotation, every non-deleted `sync_media` row in the copied SQLite database must have an archive member with the registered byte length; missing media directories or mismatches fail the backup. Payload files, manifest and staging directories are fsynced before rename, and the backup root is fsynced before retention deletes older copies. Older legacy backup directory names are preserved for manual retention review.

Verify before restoring:

```bash
node server/ops/airchat-backup.js --verify /var/backups/airchat/<date>
node --test server/ops/airchat-backup.test.js
```

The test restores real SQLite rows, account snapshots and media in a temporary directory and rejects incomplete or corrupted backups. This fixture drill is also part of CI; it is not evidence that a production backup has been restored.

To restore: verify the manifest, stop both services, save the current data directories separately, replace the database with the backup, remove adjacent `-wal`/`-shm` files, restore ownership (`airchat-vault` / `airchat-signal`) and mode 600, copy every `snapshots/*.json` to the vault data root and extract `media.tar.gz` there, then start both services and check their health and account recovery. SQLite files are individually consistent online snapshots; the two databases, root JSON snapshots and media are not a single cross-service transaction. Stop writes during backup when a single coordinated point in time is required. The current media schema records byte length but no content hash/version, so verification cannot distinguish a same-size concurrent replacement from the version referenced at SQLite snapshot time. It checks restore completeness, not cross-service point-in-time consistency. Media verification streams each required tar member into a bounded-memory scratch file; large archives may require significant temporary I/O and repeated decompression.

Backups on the same disk do not protect against losing the VPS. Off-host storage, such as rsync to another machine, remains a separate storage decision.
