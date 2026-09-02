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

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_tokens (
    peer_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    platform TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    ts INTEGER NOT NULL
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
  const now = options.now ?? (() => Date.now());
  const entries = new Map();

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [peerId, entry] of entries) {
      if (entry.updatedAt < cutoff) entries.delete(peerId);
    }
  }

  return {
    persistent: false,
    set(peerId, token, platform, ts = 0) {
      const previous = entries.get(peerId);
      // Перехваченный старый запрос не должен откатывать токен на предыдущий:
      // окно повтора в пять минут само по себе от этого не защищает.
      if (previous && ts <= previous.ts) return false;
      if (!previous && entries.size >= maxTokens) {
        sweep();
        if (entries.size >= maxTokens) return false;
      }
      entries.set(peerId, { token, platform, updatedAt: now(), ts });
      return true;
    },
    get(peerId) {
      const entry = entries.get(peerId);
      if (!entry) return null;
      if (entry.updatedAt < now() - ttlMs) {
        entries.delete(peerId);
        return null;
      }
      return entry;
    },
    delete(peerId) {
      return entries.delete(peerId);
    },
    get size() {
      return entries.size;
    },
    close() {},
  };
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
  database.exec(SCHEMA);

  const selectOne = database.prepare('SELECT token, platform, updated_at, ts FROM push_tokens WHERE peer_id = ?');
  const upsert = database.prepare(
    `INSERT INTO push_tokens (peer_id, token, platform, updated_at, ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (peer_id) DO UPDATE SET token = excluded.token, platform = excluded.platform,
         updated_at = excluded.updated_at, ts = excluded.ts`
  );
  const removeOne = database.prepare('DELETE FROM push_tokens WHERE peer_id = ?');
  const removeStale = database.prepare('DELETE FROM push_tokens WHERE updated_at < ?');
  const countAll = database.prepare('SELECT COUNT(*) AS n FROM push_tokens');

  const shape = (row) =>
    row ? { token: row.token, platform: row.platform, updatedAt: Number(row.updated_at), ts: Number(row.ts) } : null;
  const count = () => Number(countAll.get().n);

  return {
    persistent: true,
    set(peerId, token, platform, ts = 0) {
      const previous = shape(selectOne.get(peerId));
      if (previous && ts <= previous.ts) return false;
      if (!previous && count() >= maxTokens) {
        removeStale.run(now() - ttlMs);
        if (count() >= maxTokens) return false;
      }
      upsert.run(peerId, token, platform, now(), ts);
      return true;
    },
    get(peerId) {
      const entry = shape(selectOne.get(peerId));
      if (!entry) return null;
      if (entry.updatedAt < now() - ttlMs) {
        removeOne.run(peerId);
        return null;
      }
      return entry;
    },
    delete(peerId) {
      return removeOne.run(peerId).changes > 0;
    },
    get size() {
      return count();
    },
    close() {
      database.close();
    },
  };
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
  createMemoryTokenRegistry,
  createSqliteTokenRegistry,
  createTokenStore,
};
