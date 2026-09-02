const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ENTITY_KINDS = new Set([
  'profile', 'device', 'contact', 'conversation', 'message', 'group',
  'group_member', 'group_message', 'feed_post', 'feed_comment', 'reaction',
  'media_manifest', 'setting', 'presence',
]);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_CIPHERTEXT_BYTES = 512 * 1024;
const DEFAULT_MAX_ACTIVE_DEVICES = 8;
const DEFAULT_DEVICE_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_GC_MAX_ROWS = 5000;

function isCanonicalBase64(value, maxBytes, allowNull = false) {
  if (allowNull && value === null) return true;
  if (typeof value !== 'string' || value.length === 0 || !BASE64_RE.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= maxBytes && bytes.toString('base64') === value;
}

function validateMutation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mutationId = raw.mutationId;
  const entityKind = raw.entityKind;
  const entityId = raw.entityId;
  const ownerProfileId = raw.ownerProfileId;
  const revision = raw.revision;
  const deleted = raw.deleted;
  const updatedAt = raw.updatedAt;
  if (
    typeof mutationId !== 'string' || !ID_RE.test(mutationId) ||
    typeof entityKind !== 'string' || !ENTITY_KINDS.has(entityKind) ||
    typeof entityId !== 'string' || !ID_RE.test(entityId) ||
    !Number.isSafeInteger(ownerProfileId) || ownerProfileId < 1 || ownerProfileId > 1_000_000 ||
    !Number.isSafeInteger(revision) || revision < 1 || revision > Number.MAX_SAFE_INTEGER ||
    typeof deleted !== 'boolean' ||
    !Number.isSafeInteger(updatedAt) || updatedAt < 0 || updatedAt > Date.now() + 10 * 60 * 1000 ||
    !isCanonicalBase64(raw.ciphertextB64, MAX_CIPHERTEXT_BYTES, deleted)
  ) return null;
  if (!deleted && raw.ciphertextB64 === null) return null;
  // v4.32.523: у метки об удалении шифротекст теперь есть — клиент подписывает
  // сам факт удаления, иначе стереть чужую переписку мог бы любой, у кого есть
  // запись в эту базу. Прежняя строка требовала здесь null и такую метку
  // отвергала. null по-прежнему допустим: его шлют клиенты старых версий.
  return {
    mutationId,
    entityKind,
    entityId,
    ownerProfileId,
    revision,
    deleted: deleted ? 1 : 0,
    ciphertextB64: raw.ciphertextB64,
    updatedAt,
  };
}

class SyncDatabase {
  constructor(filename) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_nonces (
        account_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, nonce)
      );
      CREATE TABLE IF NOT EXISTS sync_accounts (
        account_id TEXT PRIMARY KEY NOT NULL,
        owner_public_key_b64 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_mutation_sequence INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_devices (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_public_key_b64 TEXT,
        label TEXT,
        platform TEXT,
        device_model TEXT,
        os_version TEXT,
        app_version TEXT,
        country_code TEXT,
        city TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY (account_id, device_id),
        FOREIGN KEY (account_id) REFERENCES sync_accounts(account_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sync_device_cursors (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        owner_profile_id INTEGER NOT NULL DEFAULT 0,
        cursor INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, device_id, owner_profile_id),
        FOREIGN KEY (account_id, device_id) REFERENCES sync_devices(account_id, device_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sync_mutations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        account_id TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        owner_profile_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        ciphertext_b64 TEXT,
        updated_at INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        UNIQUE (account_id, mutation_id),
        FOREIGN KEY (account_id) REFERENCES sync_accounts(account_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_mutations_pull
        ON sync_mutations (account_id, sequence);
      CREATE TABLE IF NOT EXISTS sync_entity_heads (
        account_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        owner_profile_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        mutation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        PRIMARY KEY (account_id, entity_kind, entity_id, owner_profile_id),
        FOREIGN KEY (account_id) REFERENCES sync_accounts(account_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sync_media (
        account_id TEXT NOT NULL,
        media_id TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        delete_requested_at INTEGER,
        deleted_at INTEGER,
        PRIMARY KEY (account_id, media_id),
        FOREIGN KEY (account_id) REFERENCES sync_accounts(account_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sync_media_refs (
        account_id TEXT NOT NULL,
        media_id TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        released_at INTEGER,
        PRIMARY KEY (account_id, media_id, reference_id),
        FOREIGN KEY (account_id, media_id) REFERENCES sync_media(account_id, media_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_media_gc
        ON sync_media (account_id, delete_requested_at, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_sync_media_refs_active
        ON sync_media_refs (account_id, media_id, released_at);
      -- v4.32.543: реестр юзернеймов. До него уникальность имени проверялась
      -- только среди профилей одного устройства: два человека, не знающие
      -- друг о друге, спокойно занимали одно и то же имя, и получатель
      -- конверта не мог сказать, кто из них кто. Имя — единственный
      -- человекочитаемый адрес в приложении, поэтому оно живёт здесь, в одной
      -- строке на всё приложение, а не в локальной базе каждого телефона.
      -- Обратной связи с личностью запись не даёт: рядом с именем лежит
      -- account_id, который сервер и так знает, и ничего сверх того.
      CREATE TABLE IF NOT EXISTS sync_usernames (
        username TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        profile_id INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES sync_accounts(account_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_usernames_owner
        ON sync_usernames (account_id, profile_id);
    `);
    this.ensureDeviceMetadataColumns();
    this.ensureAccountMutationSequenceColumn();
    this.ensureProfileScopedCursors();
    this.ensureEntityHeadsProfileScope();
    this.db.prepare(
      `INSERT INTO sync_meta (key, value) VALUES ('schema_version', '4')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run();
    const existing = this.db.prepare('SELECT value FROM sync_meta WHERE key = ?').get('server_epoch');
    if (!existing) {
      this.db.prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?)').run(
        'server_epoch',
        randomBytes(16).toString('hex'),
      );
    }
    this.serverEpoch = this.db.prepare('SELECT value FROM sync_meta WHERE key = ?').get('server_epoch').value;
  }

  ensureDeviceMetadataColumns() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(sync_devices)').all().map((column) => column.name));
    const additions = [
      ['platform', 'TEXT'],
      ['device_model', 'TEXT'],
      ['os_version', 'TEXT'],
      ['app_version', 'TEXT'],
      ['country_code', 'TEXT'],
      ['city', 'TEXT'],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE sync_devices ADD COLUMN ${name} ${type}`);
    }
  }

  ensureAccountMutationSequenceColumn() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(sync_accounts)').all().map((column) => column.name));
    if (!columns.has('last_mutation_sequence')) {
      this.db.exec('ALTER TABLE sync_accounts ADD COLUMN last_mutation_sequence INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`
        UPDATE sync_accounts SET last_mutation_sequence = COALESCE((
          SELECT MAX(sequence) FROM sync_mutations
          WHERE sync_mutations.account_id = sync_accounts.account_id
        ), 0)
      `);
    }
  }

  ensureProfileScopedCursors() {
    const columns = this.db.prepare('PRAGMA table_info(sync_device_cursors)').all();
    if (columns.some((column) => column.name === 'owner_profile_id')) return;
    const backup = `${this.filename}.pre-profile-cursors-${Date.now()}.bak`;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      fs.copyFileSync(this.filename, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    } catch (error) {
      throw new Error(`Cannot create sync cursor migration backup: ${error.message}`);
    }
    this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE sync_device_cursors RENAME TO sync_device_cursors_quarantine_v1;
      CREATE TABLE sync_device_cursors (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        owner_profile_id INTEGER NOT NULL DEFAULT 0,
        cursor INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, device_id, owner_profile_id),
        FOREIGN KEY (account_id, device_id) REFERENCES sync_devices(account_id, device_id) ON DELETE CASCADE
      );
      INSERT INTO sync_device_cursors
        (account_id, device_id, owner_profile_id, cursor, updated_at)
      SELECT account_id, device_id, 0, cursor, updated_at
      FROM sync_device_cursors_quarantine_v1;
      COMMIT;
    `);
  }

  close() {
    this.db.close();
  }

  ensureEntityHeadsProfileScope() {
    const columns = this.db.prepare('PRAGMA table_info(sync_entity_heads)').all();
    if (columns.some((column) => column.name === 'owner_profile_id')) return;
    const backup = `${this.filename}.pre-profile-scope-${Date.now()}.bak`;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      fs.copyFileSync(this.filename, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    } catch (error) {
      throw new Error(`Cannot create sync database migration backup: ${error.message}`);
    }
    this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE sync_entity_heads RENAME TO sync_entity_heads_quarantine_v1;
      CREATE TABLE sync_entity_heads (
        account_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        owner_profile_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        mutation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        PRIMARY KEY (account_id, entity_kind, entity_id, owner_profile_id),
        FOREIGN KEY (account_id) REFERENCES sync_accounts(account_id) ON DELETE CASCADE
      );
      INSERT INTO sync_entity_heads
        (account_id, entity_kind, entity_id, owner_profile_id, revision, mutation_id, sequence)
      SELECT account_id, entity_kind, entity_id, 1, revision, mutation_id, sequence
      FROM sync_entity_heads_quarantine_v1
      WHERE EXISTS (
        SELECT 1 FROM sync_accounts WHERE sync_accounts.account_id = sync_entity_heads_quarantine_v1.account_id
      );
      COMMIT;
    `);
  }

  consumeNonce(accountId, nonce, now = Date.now()) {
    const cutoff = now - 20 * 60 * 1000;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sync_nonces WHERE seen_at < ?').run(cutoff);
      const result = this.db.prepare(
        'INSERT OR IGNORE INTO sync_nonces (account_id, nonce, seen_at) VALUES (?, ?, ?)',
      ).run(accountId, nonce, now);
      this.db.exec('COMMIT');
      return (result.changes || 0) === 1;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ensureAccount(accountId, ownerPublicKeyB64) {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Serialize the first account claim and make a duplicate insert harmless.
      this.db.prepare(`
        INSERT INTO sync_accounts (account_id, owner_public_key_b64, created_at, last_seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (account_id) DO NOTHING
      `).run(accountId, ownerPublicKeyB64, now, now);
      const row = this.db.prepare(
        'SELECT owner_public_key_b64 FROM sync_accounts WHERE account_id = ?',
      ).get(accountId);
      if (row?.owner_public_key_b64 !== ownerPublicKeyB64) {
        this.db.exec('COMMIT');
        return { ok: false, reason: 'account_key_mismatch' };
      }
      this.db.prepare('UPDATE sync_accounts SET last_seen_at = ? WHERE account_id = ?').run(now, accountId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true };
  }

  /**
   * Занять имя за профилем. Одна транзакция BEGIN IMMEDIATE на всё: между
   * проверкой «свободно ли» и записью не должно помещаться чужого захвата,
   * иначе два одновременных запроса получат по «ок» на одно имя.
   *
   * Прежнее имя того же профиля освобождается здесь же — иначе брошенные
   * имена копились бы за каждым, кто хоть раз переименовался.
   */
  claimUsername(accountId, profileId, username) {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        'SELECT account_id AS accountId, profile_id AS profileId FROM sync_usernames WHERE username = ?',
      ).get(username);
      if (row && (row.accountId !== accountId || row.profileId !== profileId)) {
        this.db.exec('COMMIT');
        return { ok: false, reason: 'username_taken' };
      }
      this.db.prepare(
        'DELETE FROM sync_usernames WHERE account_id = ? AND profile_id = ? AND username <> ?',
      ).run(accountId, profileId, username);
      this.db.prepare(`
        INSERT INTO sync_usernames (username, account_id, profile_id, claimed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (username) DO UPDATE SET claimed_at = excluded.claimed_at
      `).run(username, accountId, profileId, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, username };
  }

  /** Отпустить имя профиля. Возвращает `true`, если запись была. */
  releaseUsername(accountId, profileId) {
    const result = this.db.prepare(
      'DELETE FROM sync_usernames WHERE account_id = ? AND profile_id = ?',
    ).run(accountId, profileId);
    return (result.changes || 0) > 0;
  }

  /**
   * Справка о занятости. Наружу уходит только `taken`: сам `account_id`
   * остаётся здесь, иначе по чужому имени можно было бы вычислить адрес
   * хранилища владельца.
   */
  lookupUsername(username) {
    const row = this.db.prepare(
      'SELECT account_id AS accountId, profile_id AS profileId FROM sync_usernames WHERE username = ?',
    ).get(username);
    return row || null;
  }

  hasAccount(accountId) {
    return !!this.db.prepare('SELECT 1 FROM sync_accounts WHERE account_id = ?').get(accountId);
  }

  accountOwnerPublicKey(accountId) {
    return this.db.prepare(
      'SELECT owner_public_key_b64 AS ownerPublicKeyB64 FROM sync_accounts WHERE account_id = ?',
    ).get(accountId)?.ownerPublicKeyB64 || null;
  }

  ensureDevice(accountId, deviceId, devicePublicKeyB64, label, metadata = null, geo = null, allowCreate = true, policy = {}) {
    const now = Number.isSafeInteger(policy.now) ? policy.now : Date.now();
    const maxActiveDevices = Number.isSafeInteger(policy.maxActiveDevices) && policy.maxActiveDevices > 0
      ? policy.maxActiveDevices : DEFAULT_MAX_ACTIVE_DEVICES;
    const idleTtlMs = Number.isSafeInteger(policy.idleTtlMs) && policy.idleTtlMs > 0
      ? policy.idleTtlMs : DEFAULT_DEVICE_IDLE_TTL_MS;
    const activeCutoff = now - idleTtlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let row = this.db.prepare(`
        SELECT device_public_key_b64, revoked_at, last_seen_at
        FROM sync_devices WHERE account_id = ? AND device_id = ?
      `).get(accountId, deviceId);
      if (row?.revoked_at) {
        this.db.exec('COMMIT');
        return { ok: false, reason: 'device_revoked' };
      }
      if (row && row.device_public_key_b64 && devicePublicKeyB64 && row.device_public_key_b64 !== devicePublicKeyB64) {
        this.db.exec('COMMIT');
        return { ok: false, reason: 'device_key_mismatch' };
      }
      if (devicePublicKeyB64) {
        const existingKey = this.db.prepare(`
          SELECT device_id, revoked_at FROM sync_devices
          WHERE account_id = ? AND device_public_key_b64 = ? AND device_id <> ? LIMIT 1
        `).get(accountId, devicePublicKeyB64, deviceId);
        if (existingKey) {
          this.db.exec('COMMIT');
          return { ok: false, reason: existingKey.revoked_at ? 'device_revoked' : 'device_key_already_enrolled' };
        }
      }
      if (!row && !allowCreate) {
        this.db.exec('COMMIT');
        return { ok: false, reason: 'device_enrollment_required' };
      }
      if (row && Number(row.last_seen_at) < activeCutoff) {
        const active = this.db.prepare(`
          SELECT COUNT(*) AS count FROM sync_devices
          WHERE account_id = ? AND device_id <> ? AND revoked_at IS NULL AND last_seen_at >= ?
        `).get(accountId, deviceId, activeCutoff);
        if (Number(active?.count || 0) >= maxActiveDevices) {
          this.db.exec('COMMIT');
          return { ok: false, reason: 'device_limit_exceeded' };
        }
      }
      if (!row) {
        const active = this.db.prepare(`
          SELECT COUNT(*) AS count FROM sync_devices
          WHERE account_id = ? AND revoked_at IS NULL AND last_seen_at >= ?
        `).get(accountId, activeCutoff);
        if (Number(active?.count || 0) >= maxActiveDevices) {
          this.db.exec('COMMIT');
          return { ok: false, reason: 'device_limit_exceeded' };
        }
        this.db.prepare(`
          INSERT INTO sync_devices
            (account_id, device_id, device_public_key_b64, label, platform, device_model,
             os_version, app_version, country_code, city, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (account_id, device_id) DO NOTHING
        `).run(
          accountId, deviceId, devicePublicKeyB64 || null, label || null,
          metadata?.platform || null, metadata?.model || null, metadata?.osVersion || null,
          metadata?.appVersion || null, geo?.countryCode || null, geo?.city || null, now, now,
        );
        row = this.db.prepare(`
          SELECT device_public_key_b64, revoked_at FROM sync_devices
          WHERE account_id = ? AND device_id = ?
        `).get(accountId, deviceId);
        if (!row || row.revoked_at) {
          this.db.exec('COMMIT');
          return { ok: false, reason: row?.revoked_at ? 'device_revoked' : 'device_enrollment_required' };
        }
      }
      this.db.prepare(`
        UPDATE sync_devices
        SET device_public_key_b64 = COALESCE(device_public_key_b64, ?),
            label = COALESCE(?, label),
            platform = COALESCE(?, platform),
            device_model = COALESCE(?, device_model),
            os_version = COALESCE(?, os_version),
            app_version = COALESCE(?, app_version),
            country_code = COALESCE(?, country_code),
            city = COALESCE(?, city),
            last_seen_at = ?
        WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL
      `).run(
        devicePublicKeyB64 || null, label || null,
        metadata?.platform || null, metadata?.model || null, metadata?.osVersion || null,
        metadata?.appVersion || null, geo?.countryCode || null, geo?.city || null,
        now, accountId, deviceId,
      );
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  activeDeviceCursors(accountId, now = Date.now(), idleTtlMs = DEFAULT_DEVICE_IDLE_TTL_MS) {
    const cutoff = now - idleTtlMs;
    return this.db.prepare(`
      SELECT d.device_id AS deviceId, COALESCE(c.cursor, 0) AS cursor
      FROM sync_devices d
      LEFT JOIN sync_device_cursors c
        ON c.account_id = d.account_id AND c.device_id = d.device_id AND c.owner_profile_id = 0
      WHERE d.account_id = ? AND d.revoked_at IS NULL AND d.last_seen_at >= ?
    `).all(accountId, cutoff);
  }

  compactSyncMutationsInTransaction(accountId, now, idleTtlMs, maxRows) {
    const devices = this.activeDeviceCursors(accountId, now, idleTtlMs);
    if (devices.length === 0) return { deleted: 0, cursor: null, activeDevices: 0 };
    const cursor = Math.min(...devices.map((device) => Number(device.cursor) || 0));
    if (cursor <= 0) return { deleted: 0, cursor: String(cursor), activeDevices: devices.length };
    const rows = this.db.prepare(`
      SELECT sequence FROM sync_mutations
      WHERE account_id = ? AND sequence <= ?
      ORDER BY sequence ASC LIMIT ?
    `).all(accountId, cursor, maxRows);
    const remove = this.db.prepare('DELETE FROM sync_mutations WHERE account_id = ? AND sequence = ?');
    let deleted = 0;
    for (const row of rows) deleted += Number(remove.run(accountId, row.sequence).changes || 0);
    return { deleted, cursor: String(cursor), activeDevices: devices.length };
  }

  compactSyncMutations(accountId, options = {}) {
    const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
    const idleTtlMs = Number.isSafeInteger(options.idleTtlMs) && options.idleTtlMs > 0
      ? options.idleTtlMs : DEFAULT_DEVICE_IDLE_TTL_MS;
    const maxRows = Number.isSafeInteger(options.maxRows) && options.maxRows > 0
      ? options.maxRows : DEFAULT_SYNC_GC_MAX_ROWS;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.compactSyncMutationsInTransaction(accountId, now, idleTtlMs, maxRows);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  push(accountId, deviceId, mutations, maxAccountBytes = 128 * 1024 * 1024, options = {}) {
    const normalizedMutations = mutations.map((mutation) => {
      if (!mutation || typeof mutation !== 'object') return null;
      if (typeof mutation.deleted !== 'boolean' && mutation.deleted !== 0 && mutation.deleted !== 1) return null;
      return validateMutation({
        ...mutation,
        deleted: mutation.deleted === true || mutation.deleted === 1,
      });
    });
    if (normalizedMutations.some((mutation) => mutation === null)) {
      throw new Error('invalid_sync_mutation');
    }
    const acceptedMutationIds = [];
    const rejectedMutationIds = [];
    if (!Number.isSafeInteger(maxAccountBytes) || maxAccountBytes < 1) {
      throw new Error('invalid_sync_quota');
    }
    const idleTtlMs = Number.isSafeInteger(options.idleTtlMs) && options.idleTtlMs > 0
      ? options.idleTtlMs : DEFAULT_DEVICE_IDLE_TTL_MS;
    const gcMaxRows = Number.isSafeInteger(options.gcMaxRows) && options.gcMaxRows > 0
      ? options.gcMaxRows : DEFAULT_SYNC_GC_MAX_ROWS;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A device cursor is an implicit acknowledgement in the v1 protocol.
      // Compact only through the minimum cursor of every currently active device.
      this.compactSyncMutationsInTransaction(accountId, Date.now(), idleTtlMs, gcMaxRows);
      const usage = this.db.prepare(`
        SELECT COALESCE(SUM(LENGTH(ciphertext_b64)), 0) AS bytes,
               COUNT(*) AS mutations
        FROM sync_mutations WHERE account_id = ?
      `).get(accountId);
      let projectedBytes = Number(usage?.bytes || 0);
      for (const mutation of normalizedMutations) {
        const duplicate = this.db.prepare(
          `SELECT entity_kind, entity_id, owner_profile_id, revision, deleted,
                  ciphertext_b64, updated_at
           FROM sync_mutations WHERE account_id = ? AND mutation_id = ?`,
        ).get(accountId, mutation.mutationId);
        if (duplicate) {
          const same = duplicate.entity_kind === mutation.entityKind
            && duplicate.entity_id === mutation.entityId
            && duplicate.owner_profile_id === mutation.ownerProfileId
            && duplicate.revision === mutation.revision
            && duplicate.deleted === mutation.deleted
            && duplicate.ciphertext_b64 === mutation.ciphertextB64
            && duplicate.updated_at === mutation.updatedAt;
          if (!same) {
            const error = new Error('sync_mutation_conflict');
            error.code = 'sync_mutation_conflict';
            throw error;
          }
          acceptedMutationIds.push(mutation.mutationId);
          continue;
        }
        const head = this.db.prepare(`
          SELECT revision FROM sync_entity_heads
          WHERE account_id = ? AND entity_kind = ? AND entity_id = ? AND owner_profile_id = ?
        `).get(accountId, mutation.entityKind, mutation.entityId, mutation.ownerProfileId);
        if (head && mutation.revision <= head.revision) {
          rejectedMutationIds.push(mutation.mutationId);
          continue;
        }
        projectedBytes += mutation.ciphertextB64 ? Buffer.byteLength(mutation.ciphertextB64, 'utf8') : 0;
        if (projectedBytes > maxAccountBytes) {
          const error = new Error('sync_account_quota');
          error.code = 'sync_account_quota';
          throw error;
        }
        const result = this.db.prepare(`
          INSERT INTO sync_mutations
            (account_id, mutation_id, entity_kind, entity_id, owner_profile_id,
             revision, deleted, ciphertext_b64, updated_at, device_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          accountId, mutation.mutationId, mutation.entityKind, mutation.entityId,
          mutation.ownerProfileId, mutation.revision, mutation.deleted,
          mutation.ciphertextB64, mutation.updatedAt, deviceId,
        );
        const sequence = Number(result.lastInsertRowid);
        this.db.prepare(`
          UPDATE sync_accounts
          SET last_mutation_sequence = MAX(last_mutation_sequence, ?)
          WHERE account_id = ?
        `).run(sequence, accountId);
        this.db.prepare(`
          INSERT INTO sync_entity_heads
            (account_id, entity_kind, entity_id, owner_profile_id, revision, mutation_id, sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (account_id, entity_kind, entity_id, owner_profile_id) DO UPDATE SET
            revision = excluded.revision,
            mutation_id = excluded.mutation_id,
            sequence = excluded.sequence
        `).run(
          accountId, mutation.entityKind, mutation.entityId, mutation.ownerProfileId, mutation.revision,
          mutation.mutationId, sequence,
        );
        acceptedMutationIds.push(mutation.mutationId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      serverEpoch: this.serverEpoch,
      acceptedMutationIds,
      rejectedMutationIds,
      nextCursor: this.latestCursor(accountId),
    };
  }

  pull(accountId, deviceId, cursor, limit, ownerProfileId = null, options = {}) {
    const requested = cursor === null ? 0 : Number(cursor);
    const scopedProfileId = Number.isSafeInteger(ownerProfileId) && ownerProfileId > 0
      ? ownerProfileId : 0;
    const profileFilter = scopedProfileId > 0
      ? ' AND owner_profile_id = ?'
      : '';
    const idleTtlMs = Number.isSafeInteger(options.idleTtlMs) && options.idleTtlMs > 0
      ? options.idleTtlMs : DEFAULT_DEVICE_IDLE_TTL_MS;
    const gcMaxRows = Number.isSafeInteger(options.gcMaxRows) && options.gcMaxRows > 0
      ? options.gcMaxRows : DEFAULT_SYNC_GC_MAX_ROWS;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const latest = Number(this.db.prepare(
        'SELECT COALESCE(last_mutation_sequence, 0) AS sequence FROM sync_accounts WHERE account_id = ?',
      ).get(accountId)?.sequence || 0);
      // A stale/corrupt client cursor must not jump past future records forever.
      const after = Math.min(requested, latest);
      const rows = this.db.prepare(`
        SELECT sequence, mutation_id, entity_kind, entity_id, owner_profile_id,
               revision, deleted, ciphertext_b64, updated_at
        FROM sync_mutations
        WHERE account_id = ? AND sequence > ?${profileFilter}
        ORDER BY sequence ASC
        LIMIT ?
      `).all(...(profileFilter ? [accountId, after, ownerProfileId, limit] : [accountId, after, limit]));
      const nextCursor = rows.length > 0 ? String(rows[rows.length - 1].sequence) : String(after);
      const hasMore = !!this.db.prepare(
        `SELECT 1 AS present FROM sync_mutations WHERE account_id = ? AND sequence > ?${profileFilter} LIMIT 1`,
      ).get(...(profileFilter ? [accountId, Number(nextCursor), ownerProfileId] : [accountId, Number(nextCursor)]));
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO sync_device_cursors (account_id, device_id, owner_profile_id, cursor, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (account_id, device_id, owner_profile_id) DO UPDATE SET
          cursor = MAX(sync_device_cursors.cursor, excluded.cursor),
          updated_at = excluded.updated_at
      `).run(accountId, deviceId, scopedProfileId, Number(nextCursor), now);
      this.compactSyncMutationsInTransaction(accountId, now, idleTtlMs, gcMaxRows);
      this.db.exec('COMMIT');
      return {
        serverEpoch: this.serverEpoch,
        nextCursor: rows.length > 0 || after > 0 ? nextCursor : null,
        hasMore,
        mutations: rows.map((row) => ({
          mutationId: row.mutation_id,
          entityKind: row.entity_kind,
          entityId: row.entity_id,
          ownerProfileId: row.owner_profile_id,
          revision: row.revision,
          deleted: row.deleted === 1,
          ciphertextB64: row.ciphertext_b64,
          updatedAt: row.updated_at,
        })),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  latestCursor(accountId) {
    const row = this.db.prepare(
      'SELECT last_mutation_sequence AS sequence FROM sync_accounts WHERE account_id = ?',
    ).get(accountId);
    return row?.sequence > 0 ? String(row.sequence) : null;
  }

  registerMedia(accountId, mediaId, bytes, now = Date.now()) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid_media_size');
    this.db.prepare(`
      INSERT INTO sync_media
        (account_id, media_id, bytes, created_at, last_seen_at, delete_requested_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT (account_id, media_id) DO UPDATE SET
        bytes = excluded.bytes,
        last_seen_at = excluded.last_seen_at,
        delete_requested_at = NULL,
        deleted_at = NULL
    `).run(accountId, mediaId, bytes, now, now);
  }

  getMedia(accountId, mediaId) {
    return this.db.prepare(`
      SELECT account_id AS accountId, media_id AS mediaId, bytes,
             created_at AS createdAt, last_seen_at AS lastSeenAt,
             delete_requested_at AS deleteRequestedAt, deleted_at AS deletedAt
      FROM sync_media WHERE account_id = ? AND media_id = ?
    `).get(accountId, mediaId) || null;
  }

  setMediaReference(accountId, mediaId, referenceId, present, now = Date.now()) {
    const media = this.getMedia(accountId, mediaId);
    if (!media) return { ok: false, reason: 'media_not_found' };
    if (media.deletedAt != null) return { ok: false, reason: 'media_deleted' };
    if (present) {
      this.db.prepare(`
        INSERT INTO sync_media_refs
          (account_id, media_id, reference_id, created_at, last_seen_at, released_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT (account_id, media_id, reference_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          released_at = NULL
      `).run(accountId, mediaId, referenceId, now, now);
    } else {
      this.db.prepare(`
        UPDATE sync_media_refs SET released_at = COALESCE(released_at, ?)
        WHERE account_id = ? AND media_id = ? AND reference_id = ?
      `).run(now, accountId, mediaId, referenceId);
    }
    return { ok: true };
  }

  requestMediaDelete(accountId, mediaId, now = Date.now()) {
    const result = this.db.prepare(`
      UPDATE sync_media
      SET delete_requested_at = COALESCE(delete_requested_at, ?)
      WHERE account_id = ? AND media_id = ? AND deleted_at IS NULL
    `).run(now, accountId, mediaId);
    if ((result.changes || 0) === 0) {
      return { ok: false, reason: this.getMedia(accountId, mediaId) ? 'media_already_deleted' : 'media_not_found' };
    }
    return { ok: true, activeReferences: this.activeMediaReferenceCount(accountId, mediaId) };
  }

  activeMediaReferenceCount(accountId, mediaId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM sync_media_refs
      WHERE account_id = ? AND media_id = ? AND released_at IS NULL
    `).get(accountId, mediaId);
    return Number(row?.count || 0);
  }

  mediaGcCandidates(accountId, requestedBefore, limit = 100) {
    const accountFilter = accountId ? ' AND m.account_id = ?' : '';
    const args = accountId ? [requestedBefore, accountId, limit] : [requestedBefore, limit];
    return this.db.prepare(`
      SELECT m.account_id AS accountId, m.media_id AS mediaId,
             m.delete_requested_at AS deleteRequestedAt
      FROM sync_media m
      WHERE m.delete_requested_at IS NOT NULL
        AND m.delete_requested_at <= ?
        AND m.deleted_at IS NULL
        ${accountFilter}
        AND NOT EXISTS (
          SELECT 1 FROM sync_media_refs r
          WHERE r.account_id = m.account_id
            AND r.media_id = m.media_id
            AND r.released_at IS NULL
        )
      ORDER BY m.delete_requested_at ASC
      LIMIT ?
    `).all(...args);
  }

  markMediaDeleted(accountId, mediaId, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE sync_media SET deleted_at = ?
        WHERE account_id = ? AND media_id = ?
          AND delete_requested_at IS NOT NULL AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM sync_media_refs
            WHERE sync_media_refs.account_id = sync_media.account_id
              AND sync_media_refs.media_id = sync_media.media_id
              AND sync_media_refs.released_at IS NULL
          )
      `).run(now, accountId, mediaId);
      if ((result.changes || 0) > 0) {
        this.db.prepare(
          'DELETE FROM sync_media_refs WHERE account_id = ? AND media_id = ?',
        ).run(accountId, mediaId);
      }
      this.db.exec('COMMIT');
      return (result.changes || 0) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listDevices(accountId, options = {}) {
    const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
    const idleTtlMs = Number.isSafeInteger(options.idleTtlMs) && options.idleTtlMs > 0
      ? options.idleTtlMs : DEFAULT_DEVICE_IDLE_TTL_MS;
    return this.db.prepare(`
      SELECT device_id AS deviceId, device_public_key_b64 AS devicePublicKeyB64,
             label, platform, device_model AS deviceModel, os_version AS osVersion,
             app_version AS appVersion, country_code AS countryCode, city,
             created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt,
             CASE WHEN revoked_at IS NULL AND last_seen_at >= ? THEN 1 ELSE 0 END AS active,
             CASE WHEN revoked_at IS NULL THEN last_seen_at + ? ELSE NULL END AS expiresAt
      FROM sync_devices WHERE account_id = ? ORDER BY created_at ASC
    `).all(now - idleTtlMs, idleTtlMs, accountId).map((device) => ({
      ...device,
      active: device.active === 1,
    }));
  }

  revokeDevice(accountId, deviceId) {
    const result = this.db.prepare(
      'UPDATE sync_devices SET revoked_at = ? WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL',
    ).run(Date.now(), accountId, deviceId);
    return (result.changes || 0) > 0;
  }
}

module.exports = { SyncDatabase, validateMutation, ENTITY_KINDS, MAX_CIPHERTEXT_BYTES };
