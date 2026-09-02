/**
 * AirChat cloud-vault service.
 *
 * This service is deliberately blind storage: it verifies an Ed25519 request
 * signature and persists the encrypted envelope, but it never receives the
 * seed phrase or cloud password and cannot decrypt the archive.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createHash } = require('crypto');
const express = require('express');
const cors = require('cors');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { SyncDatabase, validateMutation } = require('./sync-db');
const {
  normalizeClaimableUsername,
  normalizeLookupUsername,
} = require('./reserved-usernames');

const app = express();
// The client archives binary files as base64 twice (inside JSON and in the
// encrypted envelope), so the HTTP body is larger than the plaintext archive.
const MAX_BODY_BYTES = 120 * 1024 * 1024;
const SYNC_PUSH_BODY_BYTES = 80 * 1024 * 1024;
const MEDIA_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DATA_DIR = process.env.CLOUD_VAULT_DIR || path.join(__dirname, 'data');
const SYNC_DB_FILE = process.env.SYNC_DB_FILE || path.join(DATA_DIR, 'sync.sqlite');
const syncDb = new SyncDatabase(SYNC_DB_FILE);
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const MIN_KDF_ITERS = 180_000;
const MAX_KDF_ITERS = 1_000_000;
const rateBuckets = new Map();
const accountWriteLocks = new Map();
const SYNC_MAX_MUTATIONS = 100;
const SYNC_MAX_LIMIT = 100;
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MEDIA_ID_RE = /^[0-9a-f]{32}$/;
const MEDIA_REFERENCE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const DEVICE_PLATFORM_RE = /^(ios|android|web|macos|windows)$/;
const configuredMaxActiveDevices = Number(process.env.SYNC_MAX_ACTIVE_DEVICES);
const SYNC_MAX_ACTIVE_DEVICES = Number.isSafeInteger(configuredMaxActiveDevices) && configuredMaxActiveDevices > 0
  ? Math.min(configuredMaxActiveDevices, 100)
  : 8;
const configuredDeviceIdleTtl = Number(process.env.SYNC_DEVICE_IDLE_TTL_MS);
const SYNC_DEVICE_IDLE_TTL_MS = Number.isSafeInteger(configuredDeviceIdleTtl) && configuredDeviceIdleTtl > 0
  ? Math.min(configuredDeviceIdleTtl, 365 * 24 * 60 * 60 * 1000)
  : 90 * 24 * 60 * 60 * 1000;
const configuredSyncGcMaxRows = Number(process.env.SYNC_GC_MAX_ROWS);
const SYNC_GC_MAX_ROWS = Number.isSafeInteger(configuredSyncGcMaxRows) && configuredSyncGcMaxRows > 0
  ? Math.min(configuredSyncGcMaxRows, 50_000)
  : 5000;
const SYNC_DEVICE_POLICY = {
  maxActiveDevices: SYNC_MAX_ACTIVE_DEVICES,
  idleTtlMs: SYNC_DEVICE_IDLE_TTL_MS,
};
const configuredSyncQuota = Number(process.env.SYNC_MAX_ACCOUNT_BYTES);
const SYNC_MAX_ACCOUNT_BYTES = Number.isSafeInteger(configuredSyncQuota) && configuredSyncQuota > 0
  ? configuredSyncQuota
  : 128 * 1024 * 1024;
const configuredMediaQuota = Number(process.env.MEDIA_MAX_ACCOUNT_BYTES);
const MEDIA_MAX_ACCOUNT_BYTES = Number.isSafeInteger(configuredMediaQuota) && configuredMediaQuota > 0
  ? configuredMediaQuota
  : 512 * 1024 * 1024;
const MEDIA_MAX_CIPHERTEXT_BYTES = 8_100_000;
const configuredMediaDeleteGrace = Number(process.env.MEDIA_DELETE_GRACE_MS);
const MEDIA_DELETE_GRACE_MS = Number.isSafeInteger(configuredMediaDeleteGrace) && configuredMediaDeleteGrace >= 0
  ? configuredMediaDeleteGrace
  : 24 * 60 * 60 * 1000;
const configuredMediaGcBatch = Number(process.env.MEDIA_GC_BATCH);
const MEDIA_GC_BATCH = Number.isSafeInteger(configuredMediaGcBatch) && configuredMediaGcBatch > 0
  ? Math.min(configuredMediaGcBatch, 1_000)
  : 100;
const ACCOUNT_LOCK_TIMEOUT_MS = 15_000;
const ACCOUNT_LOCK_STALE_MS = 60_000;

function hardenStoragePermissions() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const visit = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in cloud storage: ${target}`);
    // A mounted volume carries entries this process does not own and cannot
    // chmod: mkfs puts a root-owned `lost+found` at the root of every ext4
    // volume, and the service runs unprivileged. Those entries are not vault
    // data and never will be — the service only ever writes as itself — so
    // walking past them is right, while dying on them means refusing to start
    // on any real volume at all. The service's OWN files still throw: there
    // the failure means the guarantee is gone, and starting anyway would hide
    // it.
    if (uid !== null && stat.uid !== uid) return;
    fs.chmodSync(target, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    }
  };
  visit(DATA_DIR);
  for (const suffix of ['', '-wal', '-shm']) {
    const dbFile = `${SYNC_DB_FILE}${suffix}`;
    if (fs.existsSync(dbFile)) visit(dbFile);
  }
}

hardenStoragePermissions();
const MEDIA_MAX_FILES = Number.isSafeInteger(Number(process.env.MEDIA_MAX_FILES))
  && Number(process.env.MEDIA_MAX_FILES) > 0
  ? Number(process.env.MEDIA_MAX_FILES)
  : 10_000;
const MAX_RATE_BUCKETS = 10_000;

// Which header carries the real client address, if any. Empty by default, and
// that default is the safe one: behind Nginx nothing strips an inbound
// `Fly-Client-IP`, so trusting a header unasked would let a client mint a
// fresh rate-limit bucket per request simply by changing it.
//
// It has to be settable because `trust proxy: 'loopback'` below only covers
// the Nginx deployment. On Fly.io the request reaches the machine from the
// fly-proxy over the internal network, so loopback never matches and `req.ip`
// is the same proxy address for every client: one busy device would spend the
// whole per-minute budget and the rest would get 429. Fly sets `Fly-Client-IP`
// itself and overwrites whatever the client sent, so naming it there is both
// safe and necessary.
const CLIENT_IP_HEADER = String(process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();

function rateLimitKey(req) {
  if (CLIENT_IP_HEADER) {
    const raw = req.headers[CLIENT_IP_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    // Cut the length: the key goes into a Map that is capped by count, not by
    // size, and a header is attacker-controlled text.
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 64);
  }
  return req.ip || 'unknown';
}

app.disable('x-powered-by');
// Nginx is the only public listener. Trusting loopback makes Express resolve
// the real client address from X-Forwarded-For instead of rate-limiting every
// Cloudflare client as 127.0.0.1.
app.set('trust proxy', 'loopback');
app.use(cors({ origin: '*' }));
app.use((req, res, next) => {
  const now = Date.now();
  const key = rateLimitKey(req);
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      const oldest = rateBuckets.keys().next().value;
      if (oldest !== undefined) rateBuckets.delete(oldest);
    }
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) return res.status(429).json({ error: 'rate_limited' });
  return next();
});
app.use((req, res, next) => {
  let limit = DEFAULT_JSON_BODY_BYTES;
  if (req.method === 'PUT' && req.path.startsWith('/v1/cloud-vault/')) limit = MAX_BODY_BYTES;
  else if (req.path.endsWith('/push')) limit = SYNC_PUSH_BODY_BYTES;
  else if (req.path.endsWith('/media/put')) limit = MEDIA_BODY_BYTES;
  return express.json({ limit: `${limit}b` })(req, res, next);
});
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.startedAt < cutoff) rateBuckets.delete(key);
  }
}, RATE_WINDOW_MS).unref();

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function decodeBase64(value, maxBytes) {
  if (typeof value !== 'string' || !PUBLIC_KEY_RE.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) return null;
  if (bytes.length > maxBytes) return null;
  return bytes;
}

function accountIdFromPublicKeyB64(publicKeyB64) {
  const publicKey = decodeBase64(publicKeyB64, 32);
  if (!publicKey || publicKey.length !== 32) return null;
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
}

function isVerifiableAccountId(accountId, accountPublicKeyB64) {
  return accountId === accountIdFromPublicKeyB64(accountPublicKeyB64);
}

function validOptionalLegacyAccountId(value) {
  return value == null || (typeof value === 'string' && ACCOUNT_ID_RE.test(value));
}

function existingFileOwner(accountId) {
  const file = accountFile(accountId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).ownerPublicKeyB64 || null;
  } catch {
    return null;
  }
}

function resolveEffectiveAccountId(requestedAccountId, payload) {
  const ownerPublicKeyB64 = payload.accountPublicKeyB64 || payload.publicKeyB64;
  const legacyAccountId = payload.legacyAccountId;
  const requestedExists = syncDb.hasAccount(requestedAccountId) || !!existingFileOwner(requestedAccountId);
  if (isVerifiableAccountId(requestedAccountId, ownerPublicKeyB64) && requestedExists) return requestedAccountId;
  if (!legacyAccountId || legacyAccountId === requestedAccountId) {
    return requestedAccountId;
  }
  if (legacyAccountId && legacyAccountId !== requestedAccountId) {
    if (!ACCOUNT_ID_RE.test(legacyAccountId)) return null;
    const knownOwner = syncDb.accountOwnerPublicKey(legacyAccountId) || existingFileOwner(legacyAccountId);
    if (knownOwner === ownerPublicKeyB64) return legacyAccountId;
  }
  // Keep an unverified requested id long enough for the creation policy to
  // return the migration error instead of conflating it with key mismatch.
  return requestedAccountId;
}

function accountCreationAllowed(requestedAccountId, effectiveAccountId, payload) {
  if (isVerifiableAccountId(requestedAccountId, payload.accountPublicKeyB64 || payload.publicKeyB64)) return true;
  // Legacy ids may still be used to access an already-created account during
  // migration, but a new account must use the public-key-bound id.
  return syncDb.hasAccount(effectiveAccountId) || !!existingFileOwner(effectiveAccountId);
}

function verifySignedPayload(rawPayload, signature) {
  if (typeof rawPayload !== 'string' || rawPayload.length > MAX_BODY_BYTES) return null;
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return null;
  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (stableStringify(payload) !== rawPayload) return null;
  const publicKey = decodeBase64(payload.publicKeyB64, 32);
  const sig = decodeBase64(signature, 64);
  if (!publicKey || publicKey.length !== 32 || !sig || sig.length !== 64) return null;
  if (!ed25519.verify(sig, Buffer.from(rawPayload), publicKey)) return null;
  if (payload.v !== 1 || typeof payload.timestamp !== 'number' || !Number.isSafeInteger(payload.timestamp)) return null;
  if (Math.abs(Date.now() - payload.timestamp) > MAX_CLOCK_SKEW_MS) return null;
  if (typeof payload.accountId !== 'string' || !ACCOUNT_ID_RE.test(payload.accountId)) return null;
  if (typeof payload.nonce !== 'string' || !NONCE_RE.test(payload.nonce)) return null;
  return payload;
}

function accountFile(accountId) {
  if (!ACCOUNT_ID_RE.test(accountId)) return null;
  return path.join(DATA_DIR, `${accountId}.json`);
}

function noStore(res) {
  res.set('cache-control', 'no-store');
}

function withAccountWriteLock(accountId, operation) {
  const previous = accountWriteLocks.get(accountId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const lockPath = path.join(DATA_DIR, `.account-${accountId}.lock`);
    const deadline = Date.now() + ACCOUNT_LOCK_TIMEOUT_MS;
    let fd = null;
    const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    let heartbeat = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, lockToken);
      } catch (error) {
        if (error?.code !== 'EEXIST' || Date.now() >= deadline) throw error;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > ACCOUNT_LOCK_STALE_MS) fs.unlinkSync(lockPath);
        } catch { /* another writer removed or replaced the lock */ }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    heartbeat = setInterval(() => {
      try { fs.utimesSync(lockPath, new Date(), new Date()); } catch { /* owner is releasing */ }
    }, Math.max(1000, Math.floor(ACCOUNT_LOCK_STALE_MS / 3)));
    heartbeat.unref?.();
    try {
      return await operation();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try {
        if (fs.readFileSync(lockPath, 'utf8') === lockToken) fs.unlinkSync(lockPath);
      } catch { /* stale cleanup handles leftovers */ }
    }
  });
  accountWriteLocks.set(accountId, current);
  return current.finally(() => {
    if (accountWriteLocks.get(accountId) === current) accountWriteLocks.delete(accountId);
  });
}

function validateSyncRequest(payload, accountId, op) {
  if (!payload || payload.op !== op || payload.accountId !== accountId) return null;
  if (!validOptionalLegacyAccountId(payload.legacyAccountId)) return null;
  if (typeof payload.deviceId !== 'string' || !DEVICE_ID_RE.test(payload.deviceId)) return null;
  if (
    typeof payload.devicePublicKeyB64 !== 'string' ||
    decodeBase64(payload.devicePublicKeyB64, 32)?.length !== 32 ||
    payload.devicePublicKeyB64 !== payload.publicKeyB64
  ) return null;
  if (payload.accountPublicKeyB64 != null && (
    typeof payload.accountPublicKeyB64 !== 'string' ||
    decodeBase64(payload.accountPublicKeyB64, 32)?.length !== 32
  )) return null;
  if (payload.deviceLabel != null && (typeof payload.deviceLabel !== 'string' || payload.deviceLabel.length > 128)) return null;
  let deviceInfo = null;
  if (payload.deviceInfo != null) {
    const info = payload.deviceInfo;
    if (
      !info || typeof info !== 'object' || Array.isArray(info) ||
      typeof info.platform !== 'string' || !DEVICE_PLATFORM_RE.test(info.platform) ||
      typeof info.model !== 'string' || info.model.length < 1 || info.model.length > 96 ||
      typeof info.osVersion !== 'string' || info.osVersion.length < 1 || info.osVersion.length > 32 ||
      typeof info.appVersion !== 'string' || info.appVersion.length < 1 || info.appVersion.length > 32
    ) return null;
    deviceInfo = {
      platform: info.platform,
      model: info.model,
      osVersion: info.osVersion,
      appVersion: info.appVersion,
    };
  }
  if (op === 'pull') {
    if (payload.cursor !== null && (
      typeof payload.cursor !== 'string' || !/^\d+$/.test(payload.cursor) ||
      !Number.isSafeInteger(Number(payload.cursor))
    )) return null;
    if (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > SYNC_MAX_LIMIT) return null;
    if (payload.ownerProfileId != null && (
      !Number.isSafeInteger(payload.ownerProfileId) || payload.ownerProfileId < 1 || payload.ownerProfileId > 1_000_000
    )) return null;
  }
  if (op === 'push') {
    if (!Array.isArray(payload.mutations) || payload.mutations.length > SYNC_MAX_MUTATIONS) return null;
    const mutations = payload.mutations.map(validateMutation);
    if (mutations.some((mutation) => mutation === null)) return null;
    return { ...payload, accountPublicKeyB64: payload.accountPublicKeyB64 || payload.publicKeyB64, mutations, deviceInfo };
  }
  if (op === 'claim_username' || op === 'release_username') {
    // Профиль 0 — основной, дальше идут дополнительные (их максимум четыре на
    // seed-фразу). Верхняя граница взята той же, что у курсоров pull.
    if (
      !Number.isSafeInteger(payload.ownerProfileId) ||
      payload.ownerProfileId < 0 || payload.ownerProfileId > 1_000_000
    ) return null;
    if (op === 'claim_username') {
      // Правила длины, набора символов и списка оставленных имён проверяет
      // сервер, а не только экран: клиент можно пересобрать без проверки.
      const username = normalizeClaimableUsername(payload.username);
      if (!username) return null;
      return {
        ...payload,
        username,
        accountPublicKeyB64: payload.accountPublicKeyB64 || payload.publicKeyB64,
        deviceInfo,
      };
    }
    return { ...payload, accountPublicKeyB64: payload.accountPublicKeyB64 || payload.publicKeyB64, deviceInfo };
  }
  if (op === 'media_put' || op === 'media_get' || op === 'media_delete' || op === 'media_reference') {
    if (typeof payload.mediaId !== 'string' || !MEDIA_ID_RE.test(payload.mediaId)) return null;
    if (op === 'media_put') {
      if (
        typeof payload.ciphertextB64 !== 'string' ||
        !decodeBase64(payload.ciphertextB64, MEDIA_MAX_CIPHERTEXT_BYTES) ||
        payload.ciphertextB64.length > MEDIA_MAX_CIPHERTEXT_BYTES * 2
      ) return null;
      if (payload.mime != null && (typeof payload.mime !== 'string' || payload.mime.length > 100)) return null;
    }
    if (op === 'media_reference' && (
      typeof payload.referenceId !== 'string' || !MEDIA_REFERENCE_ID_RE.test(payload.referenceId) ||
      typeof payload.present !== 'boolean'
    )) return null;
    return { ...payload, accountPublicKeyB64: payload.accountPublicKeyB64 || payload.publicKeyB64, deviceInfo };
  }
  return { ...payload, accountPublicKeyB64: payload.accountPublicKeyB64 || payload.publicKeyB64, deviceInfo };
}

function sessionGeo(req) {
  const remote = req.socket?.remoteAddress;
  const trustedProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!trustedProxy) return { countryCode: null, city: null };
  const country = String(req.get('cf-ipcountry') || '').trim().toUpperCase();
  const countryCode = /^[A-Z]{2}$/.test(country) ? country : null;
  const rawCity = String(req.get('cf-ipcity') || '').trim();
  const city = rawCity
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 64) || null;
  return { countryCode, city };
}

function authenticateLegacyVaultRequest(req, accountId, op) {
  const payload = verifySignedPayload(req.body?.payload, req.body?.signature);
  if (!payload || payload.op !== op || payload.accountId !== accountId) {
    return { error: 'invalid_signature' };
  }
  if (typeof payload.deviceId !== 'string' || !DEVICE_ID_RE.test(payload.deviceId)
    || typeof payload.devicePublicKeyB64 !== 'string'
    || payload.devicePublicKeyB64 !== payload.publicKeyB64
    || typeof payload.accountPublicKeyB64 !== 'string'
    || decodeBase64(payload.accountPublicKeyB64, 32)?.length !== 32) {
    return { error: 'invalid_sync_request' };
  }
  const effectiveAccountId = resolveEffectiveAccountId(accountId, payload);
  if (!effectiveAccountId) return { error: 'account_key_mismatch', status: 403 };
  if (!accountCreationAllowed(accountId, effectiveAccountId, payload)) {
    return { error: 'legacy_account_id_requires_migration', status: 426 };
  }
  const account = syncDb.ensureAccount(effectiveAccountId, payload.accountPublicKeyB64);
  if (!account.ok) return { error: account.reason, status: 403 };
  const device = syncDb.ensureDevice(
    effectiveAccountId,
    payload.deviceId,
    payload.devicePublicKeyB64,
    null,
    null,
    sessionGeo(req),
    false,
    SYNC_DEVICE_POLICY,
  );
  if (!device.ok) return { error: device.reason, status: 403 };
  if (!syncDb.consumeNonce(effectiveAccountId, payload.nonce)) return { error: 'replayed_request' };
  return { payload, accountId: effectiveAccountId };
}

function authenticateSyncRequest(req, accountId, op) {
  const payload = verifySignedPayload(req.body?.payload, req.body?.signature);
  const checked = validateSyncRequest(payload, accountId, op);
  if (!checked) return { error: 'invalid_sync_request' };
  const effectiveAccountId = resolveEffectiveAccountId(accountId, checked);
  if (!effectiveAccountId) return { error: 'account_key_mismatch', status: 403 };
  if (!accountCreationAllowed(accountId, effectiveAccountId, checked)) {
    return { error: 'legacy_account_id_requires_migration', status: 426 };
  }
  const account = syncDb.ensureAccount(effectiveAccountId, checked.accountPublicKeyB64);
  if (!account.ok) return { error: account.reason, status: 403 };
  const device = syncDb.ensureDevice(
    effectiveAccountId,
    checked.deviceId,
    checked.devicePublicKeyB64 || null,
    checked.deviceLabel || null,
    checked.deviceInfo,
    sessionGeo(req),
    false,
    SYNC_DEVICE_POLICY,
  );
  if (!device.ok) return { error: device.reason, status: 403 };
  if (!syncDb.consumeNonce(effectiveAccountId, checked.nonce)) return { error: 'replayed_request' };
  return { payload: checked, accountId: effectiveAccountId };
}

function authenticateDeviceEnrollment(req, accountId) {
  const payload = verifySignedPayload(req.body?.payload, req.body?.signature);
  if (!payload || payload.op !== 'enroll' || payload.accountId !== accountId
    || payload.accountPublicKeyB64 !== payload.publicKeyB64
    || typeof payload.devicePublicKeyB64 !== 'string'
    || !validOptionalLegacyAccountId(payload.legacyAccountId)) {
    return { error: 'invalid_enrollment' };
  }
  // Reuse the strict device metadata validator while keeping the seed key as
  // the signer for this one-time enrollment request.
  const checked = validateSyncRequest(
    { ...payload, op: 'list_devices', publicKeyB64: payload.devicePublicKeyB64 },
    accountId,
    'list_devices',
  );
  if (!checked) return { error: 'invalid_enrollment' };
  const effectiveAccountId = resolveEffectiveAccountId(accountId, payload);
  if (!effectiveAccountId) return { error: 'account_key_mismatch', status: 403 };
  if (!accountCreationAllowed(accountId, effectiveAccountId, payload)) {
    return { error: 'legacy_account_id_requires_migration', status: 426 };
  }
  const account = syncDb.ensureAccount(effectiveAccountId, payload.accountPublicKeyB64);
  if (!account.ok) return { error: account.reason, status: 403 };
  const device = syncDb.ensureDevice(
    effectiveAccountId,
    checked.deviceId,
    checked.devicePublicKeyB64,
    checked.deviceLabel || null,
    checked.deviceInfo,
    sessionGeo(req),
    true,
    { ...SYNC_DEVICE_POLICY, maxActiveDevices: SYNC_MAX_ACTIVE_DEVICES },
  );
  if (!device.ok) return { error: device.reason, status: 403 };
  if (!syncDb.consumeNonce(effectiveAccountId, payload.nonce)) return { error: 'replayed_request' };
  return { payload: checked, accountId: effectiveAccountId };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'airchat-cloud-vault-example' });
});

app.get('/v1/cloud-vault/:accountId', (_req, res) => {
  noStore(res);
  return res.status(410).json({ error: 'legacy_get_disabled' });
});

app.post('/v1/cloud-vault/:accountId/get', (req, res) => {
  noStore(res);
  const auth = authenticateLegacyVaultRequest(req, req.params.accountId, 'get');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  const file = accountFile(auth.accountId);
  if (!file) return res.status(400).json({ error: 'invalid_account_id' });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not_found' });
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!stored.ownerPublicKeyB64 || stored.ownerPublicKeyB64 !== auth.payload.accountPublicKeyB64) {
      return res.status(403).json({ error: 'account_key_mismatch' });
    }
    return res.json(stored.envelope);
  } catch {
    return res.status(500).json({ error: 'vault_unreadable' });
  }
});

app.put('/v1/cloud-vault/:accountId', async (req, res) => {
  noStore(res);
  const auth = authenticateLegacyVaultRequest(req, req.params.accountId, 'put');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  const effectiveAccountId = auth.accountId;
  const file = accountFile(effectiveAccountId);
  if (!file) return res.status(400).json({ error: 'invalid_account_id' });
  const payload = auth.payload;
  const envelope = payload.envelope;
  if (
    !envelope ||
    envelope.v !== 1 ||
    envelope.accountId !== req.params.accountId ||
    typeof envelope.savedAt !== 'number' ||
    !Number.isSafeInteger(envelope.savedAt) ||
    envelope.savedAt < 0 ||
    envelope.savedAt > Date.now() + MAX_CLOCK_SKEW_MS ||
    typeof envelope.saltB64 !== 'string' ||
    decodeBase64(envelope.saltB64, 16)?.length !== 16 ||
    !Number.isSafeInteger(envelope.iters) ||
    envelope.iters < MIN_KDF_ITERS ||
    envelope.iters > MAX_KDF_ITERS ||
    typeof envelope.blobB64 !== 'string' ||
    !decodeBase64(envelope.blobB64, MAX_BODY_BYTES) ||
    envelope.blobB64.length > MAX_BODY_BYTES * 2
  ) return res.status(400).json({ error: 'invalid_envelope' });

  try {
    return await withAccountWriteLock(effectiveAccountId, async () => {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      if (fs.existsSync(file)) {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!stored.ownerPublicKeyB64 || stored.ownerPublicKeyB64 !== payload.accountPublicKeyB64) {
          return res.status(403).json({ error: 'account_key_mismatch' });
        }
        if (stored.envelope && Number.isSafeInteger(stored.envelope.savedAt)
          && envelope.savedAt < stored.envelope.savedAt) {
          return res.status(409).json({ error: 'stale_snapshot' });
        }
      }
      let temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({
          v: 1,
          ownerPublicKeyB64: payload.accountPublicKeyB64,
          envelope,
        }), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
        temporary = null;
        return res.json({ ok: true, savedAt: envelope.savedAt });
      } finally {
        if (temporary) {
          try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
        }
      }
    });
  } catch {
    return res.status(500).json({ error: 'vault_write_failed' });
  }
});

function mediaFile(accountId, mediaId) {
  if (!ACCOUNT_ID_RE.test(accountId) || !MEDIA_ID_RE.test(mediaId)) return null;
  return path.join(DATA_DIR, 'media', accountId, `${mediaId}.bin`);
}

function mediaAccountUsage(accountId) {
  const directory = path.join(DATA_DIR, 'media', accountId);
  if (!fs.existsSync(directory)) return { bytes: 0, files: 0 };
  return fs.readdirSync(directory).reduce((usage, name) => {
    if (!MEDIA_ID_RE.test(name.replace(/\.bin$/, '')) || !name.endsWith('.bin')) return usage;
    try {
      usage.bytes += fs.statSync(path.join(directory, name)).size;
      usage.files += 1;
    } catch { /* file disappeared during inspection */ }
    return usage;
  }, { bytes: 0, files: 0 });
}

async function runMediaGc(accountId = null, now = Date.now(), graceMs = MEDIA_DELETE_GRACE_MS) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error('invalid_media_gc_window');
  }
  const candidates = syncDb.mediaGcCandidates(accountId, now - graceMs, MEDIA_GC_BATCH);
  let deleted = 0;
  for (const candidate of candidates) {
    await withAccountWriteLock(candidate.accountId, async () => {
      const current = syncDb.getMedia(candidate.accountId, candidate.mediaId);
      if (!current || current.deletedAt != null || current.deleteRequestedAt == null
        || current.deleteRequestedAt > now
        || syncDb.activeMediaReferenceCount(candidate.accountId, candidate.mediaId) > 0) return;
      const file = mediaFile(candidate.accountId, candidate.mediaId);
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
      if (syncDb.markMediaDeleted(candidate.accountId, candidate.mediaId, now)) deleted += 1;
    });
  }
  return { deleted };
}

const mediaGcTimer = setInterval(() => {
  void runMediaGc().catch(() => { /* the next pass retries failed accounts */ });
}, Math.max(MEDIA_DELETE_GRACE_MS, 15 * 60 * 1000));
mediaGcTimer.unref?.();

/** Store opaque E2E ciphertext for a blob id; the VPS never sees the key. */
app.post('/v1/sync/:accountId/media/put', async (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'media_put');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  const effectiveAccountId = auth.accountId;
  const payload = auth.payload;
  const file = mediaFile(effectiveAccountId, payload.mediaId);
  const bytes = Buffer.from(payload.ciphertextB64, 'base64');
  try {
    return await withAccountWriteLock(effectiveAccountId, async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const previousBytes = previous?.length || 0;
      const usage = mediaAccountUsage(effectiveAccountId);
      if (!fs.existsSync(file) && usage.files >= MEDIA_MAX_FILES) {
        return res.status(413).json({ error: 'media_file_quota' });
      }
      if (usage.bytes - previousBytes + bytes.length > MEDIA_MAX_ACCOUNT_BYTES) {
        return res.status(413).json({ error: 'media_account_quota' });
      }
      let temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
        temporary = null;
        syncDb.registerMedia(effectiveAccountId, payload.mediaId, bytes.length);
        return res.json({ ok: true, mediaId: payload.mediaId, bytes: bytes.length });
      } catch (error) {
        try {
          if (previous) fs.writeFileSync(file, previous, { mode: 0o600 });
          else if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch { /* preserve the original failure; the next upload can repair the record */ }
        throw error;
      } finally {
        if (temporary) {
          try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
        }
      }
    });
  } catch {
    return res.status(500).json({ error: 'media_write_failed' });
  }
});

/** Record an authenticated client reference without inspecting its ciphertext. */
app.post('/v1/sync/:accountId/media/reference', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'media_reference');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  const effectiveAccountId = auth.accountId;
  const payload = auth.payload;
  return withAccountWriteLock(effectiveAccountId, async () => {
    const result = syncDb.setMediaReference(
      effectiveAccountId,
      payload.mediaId,
      payload.referenceId,
      payload.present,
    );
    if (!result.ok) return res.status(404).json({ error: result.reason });
    return res.json({ ok: true, mediaId: payload.mediaId, referenceId: payload.referenceId, present: payload.present });
  }).catch(() => res.status(500).json({ error: 'media_reference_failed' }));
});

/** Request deletion; physical removal is deferred until references are released. */
app.post('/v1/sync/:accountId/media/delete', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'media_delete');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  return withAccountWriteLock(auth.accountId, async () => {
    const result = syncDb.requestMediaDelete(auth.accountId, auth.payload.mediaId);
    if (!result.ok) return res.status(404).json({ error: result.reason });
    return res.json({
      ok: true,
      mediaId: auth.payload.mediaId,
      pending: true,
      activeReferences: result.activeReferences,
    });
  }).catch(() => res.status(500).json({ error: 'media_delete_failed' }));
});

/** Run safe account-scoped GC; only explicitly requested, unreferenced media qualify. */
app.post('/v1/sync/:accountId/media/gc', async (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'media_gc');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  try {
    return res.json({ ok: true, ...(await runMediaGc(auth.accountId)) });
  } catch {
    return res.status(500).json({ error: 'media_gc_failed' });
  }
});

/** Return opaque E2E ciphertext for a signed account device. */
app.post('/v1/sync/:accountId/media/get', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'media_get');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  const media = syncDb.getMedia(auth.accountId, auth.payload.mediaId);
  if (!media || media.deletedAt != null) return res.status(404).json({ error: 'media_not_found' });
  const file = mediaFile(auth.accountId, auth.payload.mediaId);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'media_not_found' });
  try {
    const bytes = fs.readFileSync(file);
    return res.json({ mediaId: auth.payload.mediaId, ciphertextB64: bytes.toString('base64') });
  } catch {
    return res.status(500).json({ error: 'media_read_failed' });
  }
});

/**
 * Cursor-based encrypted sync. The server stores opaque ciphertext and
 * metadata needed for ordering/conflict resolution; it never decrypts rows.
 */
app.post('/v1/sync/:accountId/pull', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'pull');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  try {
    return res.json(syncDb.pull(
      auth.accountId,
      auth.payload.deviceId,
      auth.payload.cursor,
      auth.payload.limit,
      auth.payload.ownerProfileId ?? null,
      { idleTtlMs: SYNC_DEVICE_IDLE_TTL_MS, gcMaxRows: SYNC_GC_MAX_ROWS },
    ));
  } catch {
    return res.status(500).json({ error: 'sync_pull_failed' });
  }
});

app.post('/v1/sync/:accountId/push', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'push');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  try {
    const result = syncDb.push(
      auth.accountId,
      auth.payload.deviceId,
      auth.payload.mutations,
      SYNC_MAX_ACCOUNT_BYTES,
      { idleTtlMs: SYNC_DEVICE_IDLE_TTL_MS, gcMaxRows: SYNC_GC_MAX_ROWS },
    );
    return res.json(result);
  } catch (error) {
    if (error?.code === 'sync_account_quota') {
      return res.status(413).json({ error: 'sync_account_quota' });
    }
    if (error?.code === 'sync_mutation_conflict') {
      return res.status(409).json({ error: 'sync_mutation_conflict' });
    }
    return res.status(500).json({ error: 'sync_push_failed' });
  }
});

app.post('/v1/sync/:accountId/devices', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'list_devices');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  return res.json({ devices: syncDb.listDevices(auth.accountId, { idleTtlMs: SYNC_DEVICE_IDLE_TTL_MS }) });
});

app.post('/v1/sync/:accountId/devices/enroll', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateDeviceEnrollment(req, accountId);
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  return res.json({ ok: true, deviceId: auth.payload.deviceId });
});

app.post('/v1/sync/:accountId/devices/revoke', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'revoke_device');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  const target = auth.payload.targetDeviceId;
  if (typeof target !== 'string' || !DEVICE_ID_RE.test(target) || target === auth.payload.deviceId) {
    return res.status(400).json({ error: 'invalid_target_device' });
  }
  return res.json({ ok: syncDb.revokeDevice(auth.accountId, target) });
});

/**
 * Реестр юзернеймов (v4.32.543).
 *
 * До него уникальность имени проверялась только среди профилей одного
 * телефона, то есть не проверялась вовсе: два незнакомых человека занимали
 * одно имя, и получатель конверта не мог сказать, от кого он. Запись идёт по
 * той же подписи, что pull/push, — занять имя может только владелец аккаунта.
 */
app.post('/v1/sync/:accountId/username/claim', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'claim_username');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  try {
    const result = syncDb.claimUsername(auth.accountId, auth.payload.ownerProfileId, auth.payload.username);
    if (!result.ok) return res.status(409).json({ error: result.reason });
    return res.json({ ok: true, username: result.username });
  } catch {
    return res.status(500).json({ error: 'username_claim_failed' });
  }
});

app.post('/v1/sync/:accountId/username/release', (req, res) => {
  noStore(res);
  const accountId = req.params.accountId;
  const auth = authenticateSyncRequest(req, accountId, 'release_username');
  if (auth.error) return res.status(auth.status || 401).json({ error: auth.error });
  try {
    return res.json({ ok: syncDb.releaseUsername(auth.accountId, auth.payload.ownerProfileId) });
  } catch {
    return res.status(500).json({ error: 'username_release_failed' });
  }
});

/**
 * Справка о занятости — единственный запрос реестра без подписи: спросить
 * «свободно ли имя» нужно до того, как аккаунт вообще заведён. Наружу уходит
 * только `taken`. Владельца не называем намеренно: `accountId` — это адрес
 * его хранилища, и отдавать его по чужому имени нельзя.
 */
app.get('/v1/username/:username', (req, res) => {
  noStore(res);
  const username = normalizeLookupUsername(req.params.username);
  if (!username) return res.status(400).json({ error: 'invalid_username' });
  try {
    return res.json({ username, taken: syncDb.lookupUsername(username) !== null });
  } catch {
    return res.status(500).json({ error: 'username_lookup_failed' });
  }
});

const port = Number(process.env.PORT) || 3010;
const host = process.env.HOST || '0.0.0.0';
let server = null;
if (require.main === module) {
  server = http.createServer(app);
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`AirChat cloud-vault listening on ${host}:${port}`);
  });
}

module.exports = { app, server, syncDb, runMediaGc, verifySignedPayload, validateSyncRequest, resolveEffectiveAccountId, accountCreationAllowed };
