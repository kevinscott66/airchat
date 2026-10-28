'use strict';

/**
 * Где живут push-токены.
 *
 * До 4.32.538 они жили только в памяти процесса. Для сигналинга это нормально:
 * соединение и так рвётся при перезапуске, клиент переподключается сам. Для
 * push — нет. Токен присылают один раз при запуске приложения, а нужен он
 * ровно тогда, когда приложение закрыто и заново его не пришлёт. Один деплой
 * ретранслятора — и человек перестаёт получать уведомления до следующего
 * запуска приложения, то есть ровно до того момента, когда они уже не нужны.
 *
 * Поэтому база на диске. SQLite из стандартной библиотеки (`node:sqlite`,
 * node 22): новой зависимости не появляется, файл лежит на томе fly, схема —
 * одна таблица. Без переменной `PUSH_TOKEN_DB` хранилище остаётся в памяти:
 * тесты и локальный запуск не должны требовать тома.
 *
 * Что здесь НЕ хранится: ни собеседников, ни переписки, ни адресной книги.
 * Строка — это `peerId → токен устройства`, и она нужна только чтобы доставить
 * пустой конверт с `cid`. Содержимое ретранслятор не видит (см. push.js).
 */

const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_TOKENS = 200000;
const MAX_DEVICES_PER_PEER = 8;
const LEGACY_DEVICE_ID = 'legacy';
const REVOCATION_TTL_MS = 10 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_tokens (
    peer_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    token TEXT NOT NULL,
    platform TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (peer_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS push_tokens_updated_at ON push_tokens (updated_at);
`;

/**
 * Хранилище токенов в памяти. Интерфейс общий с дисковым, чтобы вызывающий
 * не знал, где лежит база, и чтобы одно можно было проверить тестами другого.
 */
function createMemoryTokenRegistry(options = {}) {
  const ttlMs = options.ttlMs ?? TOKEN_TTL_MS;
  const maxTokens = options.maxTokens ?? MAX_TOKENS;
  const maxDevices = options.maxDevices ?? MAX_DEVICES_PER_PEER;
  const now = options.now ?? (() => Date.now());
  const peers = new Map();
  let count = 0;
  function remove(peerId, deviceId) {
    const devices = peers.get(peerId);
    if (!devices?.delete(deviceId)) return false;
    count -= 1;
    if (!devices.size) peers.delete(peerId);
    return true;
  }
  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [peerId, devices] of peers) {
      for (const [deviceId, entry] of devices) {
        if (entry.updatedAt < (entry.platform === 'revoked' ? now() - REVOCATION_TTL_MS : cutoff)) remove(peerId, deviceId);
      }
    }
  }
  function current(peerId, deviceId) {
    const entry = peers.get(peerId)?.get(deviceId);
    if (entry && entry.updatedAt < now() - (entry.platform === 'revoked' ? REVOCATION_TTL_MS : ttlMs)) {
      remove(peerId, deviceId);
      return null;
    }
    return entry ?? null;
  }
  const store = {
    persistent: false,
    set(peerId, token, platform, ts = 0, deviceId = LEGACY_DEVICE_ID) {
      const previous = current(peerId, deviceId);
      if (previous && ts <= previous.ts) return false;
      if (!previous && (count >= maxTokens || (peers.get(peerId)?.size ?? 0) >= maxDevices)) sweep();
      if (!previous && (count >= maxTokens || (peers.get(peerId)?.size ?? 0) >= maxDevices)) return false;
      let devices = peers.get(peerId);
      if (!devices) peers.set(peerId, devices = new Map());
      devices.set(deviceId, { deviceId, token, platform, updatedAt: now(), ts });
      if (!previous) count += 1;
      return true;
    },
    get(peerId, deviceId = LEGACY_DEVICE_ID) {
      const entry = current(peerId, deviceId);
      return entry?.token ? entry : null;
    },
    list(peerId) {
      return [...(peers.get(peerId)?.keys() ?? [])].map((id) => store.get(peerId, id)).filter(Boolean);
    },
    delete(peerId, deviceId = LEGACY_DEVICE_ID) { return remove(peerId, deviceId); },
    deleteIfCurrent(peerId, expected) {
      const deviceId = expected.deviceId ?? LEGACY_DEVICE_ID;
      const entry = current(peerId, deviceId);
      if (!entry || entry.token !== expected.token || entry.ts !== expected.ts) return false;
      return remove(peerId, deviceId);
    },
    revoke(peerId, deviceId, ts) {
      // Keep a timestamp tombstone so a captured enrollment cannot restore it.
      const entry = current(peerId, deviceId);
      if (entry && ts <= entry.ts) return entry.platform === 'revoked';
      return store.set(peerId, '', 'revoked', ts, deviceId);
    },
    get size() { return count; },
    close() {},
  };
  return store;
}

/**
 * То же хранилище на SQLite. `path` — файл базы; ':memory:' допустим и полезен
 * в тестах, но переживает ровно один процесс, как и хранилище выше.
 */
function createSqliteTokenRegistry(options = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const ttlMs = options.ttlMs ?? TOKEN_TTL_MS;
  const maxTokens = options.maxTokens ?? MAX_TOKENS;
  const now = options.now ?? (() => Date.now());
  const database = options.database ?? new DatabaseSync(options.path ?? ':memory:');

  // WAL — чтобы чтение не ждало записи. На файле в памяти PRAGMA молча не
  // применится, и это нормально: там ждать нечему.
  try {
    database.exec('PRAGMA journal_mode = WAL');
  } catch {
    /* :memory: и тома без поддержки WAL работают и без него */
  }
  const columns = database.prepare("PRAGMA table_info(push_tokens)").all();
  if (columns.length && !columns.some((column) => column.name === 'device_id')) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('ALTER TABLE push_tokens RENAME TO push_tokens_legacy');
      database.exec('DROP INDEX IF EXISTS push_tokens_updated_at');
      database.exec(SCHEMA);
      database.exec(`INSERT INTO push_tokens (peer_id, device_id, token, platform, updated_at, ts)
        SELECT peer_id, 'legacy', token, platform, updated_at, ts FROM push_tokens_legacy`);
      database.exec('DROP TABLE push_tokens_legacy');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } else database.exec(SCHEMA);

  const maxDevices = options.maxDevices ?? MAX_DEVICES_PER_PEER;
  const selectOne = database.prepare('SELECT * FROM push_tokens WHERE peer_id = ? AND device_id = ?');
  const selectPeer = database.prepare('SELECT * FROM push_tokens WHERE peer_id = ?');
  const upsert = database.prepare(
    `INSERT INTO push_tokens (peer_id, device_id, token, platform, updated_at, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (peer_id, device_id) DO UPDATE SET token = excluded.token, platform = excluded.platform,
         updated_at = excluded.updated_at, ts = excluded.ts WHERE excluded.ts > push_tokens.ts`
  );
  const removeOne = database.prepare('DELETE FROM push_tokens WHERE peer_id = ? AND device_id = ?');
  const removeCurrent = database.prepare('DELETE FROM push_tokens WHERE peer_id = ? AND device_id = ? AND token = ? AND ts = ?');
  const removeStale = database.prepare("DELETE FROM push_tokens WHERE (platform != 'revoked' AND updated_at < ?) OR (platform = 'revoked' AND updated_at < ?)");
  const countAll = database.prepare('SELECT COUNT(*) AS n FROM push_tokens');
  const shape = (row) => row ? {
    deviceId: row.device_id, token: row.token, platform: row.platform,
    updatedAt: Number(row.updated_at), ts: Number(row.ts),
  } : null;
  const count = () => Number(countAll.get().n);
  const store = {
    persistent: true,
    set(peerId, token, platform, ts = 0, deviceId = LEGACY_DEVICE_ID) {
      let previous = shape(selectOne.get(peerId, deviceId));
      if (previous && previous.updatedAt < now() - (previous.platform === 'revoked' ? REVOCATION_TTL_MS : ttlMs)) {
        removeOne.run(peerId, deviceId);
        previous = null;
      }
      if (previous && ts <= previous.ts) return false;
      if (!previous && (count() >= maxTokens || selectPeer.all(peerId).length >= maxDevices)) {
        removeStale.run(now() - ttlMs, now() - REVOCATION_TTL_MS);
        if (count() >= maxTokens || selectPeer.all(peerId).length >= maxDevices) return false;
      }
      return upsert.run(peerId, deviceId, token, platform, now(), ts).changes > 0;
    },
    get(peerId, deviceId = LEGACY_DEVICE_ID) {
      const entry = shape(selectOne.get(peerId, deviceId));
      if (!entry) return null;
      if (entry.updatedAt < now() - (entry.platform === 'revoked' ? REVOCATION_TTL_MS : ttlMs)) {
        removeOne.run(peerId, deviceId);
        return null;
      }
      return entry.token ? entry : null;
    },
    list(peerId) {
      return selectPeer.all(peerId).map((row) => store.get(peerId, row.device_id)).filter(Boolean);
    },
    delete(peerId, deviceId = LEGACY_DEVICE_ID) { return removeOne.run(peerId, deviceId).changes > 0; },
    deleteIfCurrent(peerId, expected) {
      return removeCurrent.run(peerId, expected.deviceId ?? LEGACY_DEVICE_ID, expected.token, expected.ts).changes > 0;
    },
    revoke(peerId, deviceId, ts) {
      const entry = shape(selectOne.get(peerId, deviceId));
      if (entry && ts <= entry.ts) return entry.platform === 'revoked';
      return store.set(peerId, '', 'revoked', ts, deviceId);
    },
    get size() { return count(); },
    close() { database.close(); },
  };
  return store;
}

/**
 * Выбор хранилища по окружению. Нет пути — память; путь есть, но база не
 * открывается — тоже память, и об этом сообщается наружу через `log`.
 * Ретранслятор должен подняться в любом случае: без push он ещё сигналинг,
 * а не поднявшись — уже ничто.
 */
function createTokenStore(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const path = options.path ?? env.PUSH_TOKEN_DB ?? '';
  if (!path) {
    log('push_tokens_in_memory', {});
    return createMemoryTokenRegistry(options);
  }
  try {
    const store = createSqliteTokenRegistry({ ...options, path });
    log('push_tokens_on_disk', { count: store.size });
    return store;
  } catch (e) {
    log('push_tokens_disk_failed', { err: e instanceof Error ? e.message : String(e) });
    return createMemoryTokenRegistry(options);
  }
}

module.exports = {
  TOKEN_TTL_MS,
  MAX_TOKENS,
  MAX_DEVICES_PER_PEER,
  LEGACY_DEVICE_ID,
  createMemoryTokenRegistry,
  createSqliteTokenRegistry,
  createTokenStore,
};
