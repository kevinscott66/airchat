# Серверные операции

## Резервные копии

`airchat-backup.js` раз в сутки (`airchat-backup.timer`, 03:20 UTC) снимает
онлайн-копию `sync.sqlite` (cloud-vault) и `push-tokens.db` (signaling),
проверяет каждую `PRAGMA integrity_check`, архивирует медиа и хранит 14
последних копий в `/var/backups/airchat/<дата>/`.

Установка или обновление на сервере:

```bash
scp server/ops/airchat-backup.* vps78:/tmp/
ssh vps78 'sudo install -d -m 700 /opt/airchat-ops /var/backups/airchat &&
  sudo install -m 644 /tmp/airchat-backup.js /opt/airchat-ops/ &&
  sudo install -m 644 /tmp/airchat-backup.service /tmp/airchat-backup.timer /etc/systemd/system/ &&
  sudo systemctl daemon-reload && sudo systemctl enable --now airchat-backup.timer'
```

Восстановление: остановить сервис, положить файл из копии на место базы,
удалить `-wal`/`-shm` рядом, вернуть владельца (`airchat-vault` /
`airchat-signal`, режим 600), запустить сервис.

Копии лежат на том же диске и не спасают от потери VPS. Выносить их наружу
(например, `rsync` на другую машину) пока некуда — это решение о хранилище.
