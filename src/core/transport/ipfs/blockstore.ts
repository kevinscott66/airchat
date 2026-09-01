import * as SQLite from 'expo-sqlite';
import { log } from '../../logger';

const MAX_CACHE_BYTES = 500 * 1024 * 1024;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const database = await SQLite.openDatabaseAsync('airchat_ipfs_cache.db');
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS ipfs_block_cache (
          cid TEXT PRIMARY KEY NOT NULL,
          data BLOB NOT NULL,
          size INTEGER NOT NULL,
          last_access INTEGER NOT NULL
        );
      `);
      return database;
    })();
  }
  return dbPromise;
}

/** LRU-ish cache for raw IPFS bytes (Helia/Kubo agnostic). */
export async function cachePut(cid: string, data: Uint8Array): Promise<void> {
  try {
    const db = await getDb();
    const now = Date.now();
    await db.runAsync(
      'INSERT OR REPLACE INTO ipfs_block_cache (cid, data, size, last_access) VALUES (?, ?, ?, ?)',
      [cid, data, data.length, now]
    );
    await evictIfNeeded();
  } catch (e) {
    log.warn('ipfs_cache_put_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function cacheGet(cid: string): Promise<Uint8Array | null> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ data: Uint8Array }>(
      'SELECT data FROM ipfs_block_cache WHERE cid = ?',
      [cid]
    );
    if (!row) return null;
    await db.runAsync('UPDATE ipfs_block_cache SET last_access = ? WHERE cid = ?', [
      Date.now(),
      cid,
    ]);
    return row.data;
  } catch (e) {
    log.warn('ipfs_cache_get_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

async function evictIfNeeded(): Promise<void> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ t: number }>(
      'SELECT SUM(size) as t FROM ipfs_block_cache'
    );
    let total = row?.t ?? 0;
    while (total > MAX_CACHE_BYTES) {
      const victim = await db.getFirstAsync<{ cid: string; size: number }>(
        'SELECT cid, size FROM ipfs_block_cache ORDER BY last_access ASC LIMIT 1'
      );
      if (!victim) break;
      await db.runAsync('DELETE FROM ipfs_block_cache WHERE cid = ?', [victim.cid]);
      total -= victim.size;
    }
  } catch (e) {
    log.warn('ipfs_cache_evict_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}
