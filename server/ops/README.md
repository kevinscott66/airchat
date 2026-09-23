# Server operations

## Backups

`airchat-backup.js` runs daily through `airchat-backup.timer` at 03:20 UTC. It creates online backups of cloud-vault `sync.sqlite` and signaling `push-tokens.db`, runs `PRAGMA integrity_check` on each, archives media, and retains the latest 14 backups in `/var/backups/airchat/<date>/`.

Install or update on the configured server:

```bash
scp server/ops/airchat-backup.* vps78:/tmp/
ssh vps78 'sudo install -d -m 700 /opt/airchat-ops /var/backups/airchat &&
  sudo install -m 644 /tmp/airchat-backup.js /opt/airchat-ops/ &&
  sudo install -m 644 /tmp/airchat-backup.service /tmp/airchat-backup.timer /etc/systemd/system/ &&
  sudo systemctl daemon-reload && sudo systemctl enable --now airchat-backup.timer'
```

To restore: stop the service, replace the database with the backup, remove adjacent `-wal`/`-shm` files, restore ownership (`airchat-vault` / `airchat-signal`) and mode 600, then start the service.

Backups on the same disk do not protect against losing the VPS. Off-host storage, such as rsync to another machine, remains a separate storage decision.
