/**
 * Привязка секретных слов к Apple ID / Google (v4.32.595).
 *
 * Смысл: человек не должен переписывать 24 слова, чтобы вернуть аккаунт на
 * новом телефоне. Слова лежат здесь, но лежат шифртекстом: ключ выводится на
 * устройстве из пароля приложения, сервер пароля не видит и прочитать слова
 * не может. Провайдер отвечает только за одно — кто пришёл; пароль обязателен
 * и вторым фактором остаётся всегда.
 *
 * Токен провайдера проверяется по его же JWKS, а не «на слово»: подпись,
 * издатель, срок и аудитория. Аудитория задаётся переменной окружения — без
 * неё провайдер выключен, иначе чужое приложение выпускало бы токены,
 * которые мы приняли бы за свои.
 */
const { createPublicKey, verify: verifySignature } = require('crypto');

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TOKEN_BYTES = 8 * 1024;
const MIN_RSA_MODULUS_BITS = 2048;
const MAX_SUBJECT_LEN = 255;

const SEED_ENVELOPE_VERSION = 1;
const SEED_ENVELOPE_MIN_ITERS = 600_000;
const SEED_ENVELOPE_MAX_ITERS = 4_000_000;
const SEED_ENVELOPE_SALT_BYTES = 16;
/** Двадцать четыре слова плюс рамка XChaCha20 — с запасом, но не мешок. */
const SEED_ENVELOPE_MAX_DATA_BYTES = 1024;

const PROVIDERS = {
  apple: {
    issuers: ['https://appleid.apple.com'],
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    audienceEnv: 'APPLE_SIGNIN_AUDIENCES',
  },
  google: {
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    audienceEnv: 'GOOGLE_SIGNIN_AUDIENCES',
  },
};

const jwksCache = new Map();

function providerNames() {
  return Object.keys(PROVIDERS);
}

function isKnownProvider(provider) {
  return typeof provider === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

/**
 * Аудитории провайдера: список bundle id / client id через запятую или пробел.
 *
 * В systemd писать их через ПРОБЕЛ нельзя: `Environment=` режет значение по
 * пробелам на отдельные присваивания, и всё после первого id молча теряется.
 * Снаружи это выглядит как 401 при привязке ровно со второго телефона.
 * Правильная форма — через запятую:
 *   Environment=APPLE_SIGNIN_AUDIENCES=bundle.one,bundle.two
 */
function configuredAudiences(provider, env = process.env) {
  if (!isKnownProvider(provider)) return [];
  return String(env[PROVIDERS[provider].audienceEnv] || '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function configuredProviders(env = process.env) {
  return providerNames().filter((provider) => configuredAudiences(provider, env).length > 0);
}

function decodeBase64Url(segment, maxBytes) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  return bytes;
}

function decodeJsonSegment(segment) {
  const bytes = decodeBase64Url(segment, MAX_TOKEN_BYTES);
  if (!bytes) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function fetchJwks(provider, fetchImpl) {
  const response = await fetchImpl(PROVIDERS[provider].jwksUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`jwks_http_${response.status}`);
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  if (!keys.length) throw new Error('jwks_empty');
  return keys;
}

/**
 * Ключ по kid. Промах — повод сходить за свежим набором: провайдеры меняют
 * ключи молча. Но не чаще раза в минуту, иначе неверный kid из чужого токена
 * превращается в бесплатный запрос к Apple от нашего имени.
 */
async function findSigningKey(provider, kid, options) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now ?? Date.now();
  let entry = jwksCache.get(provider);
  const fresh = entry && now - entry.fetchedAt < JWKS_TTL_MS;
  if (fresh) {
    const hit = entry.keys.find((key) => key?.kid === kid);
    if (hit) return hit;
    if (now - entry.fetchedAt < JWKS_MIN_REFETCH_MS) return null;
  }
  if (!entry?.inflight) {
    const inflight = fetchJwks(provider, fetchImpl)
      .then((keys) => {
        jwksCache.set(provider, { keys, fetchedAt: options.now ?? Date.now(), inflight: null });
        return keys;
      })
      .catch((e) => {
        const cached = jwksCache.get(provider);
        if (cached) cached.inflight = null;
        throw e;
      });
    entry = { keys: entry?.keys || [], fetchedAt: entry?.fetchedAt || 0, inflight };
    jwksCache.set(provider, entry);
  }
  const keys = await entry.inflight;
  return keys.find((key) => key?.kid === kid) || null;
}

function resetJwksCache() {
  jwksCache.clear();
}

function audienceMatches(claimAudience, allowed) {
  const list = Array.isArray(claimAudience) ? claimAudience : [claimAudience];
  return list.some((value) => typeof value === 'string' && allowed.includes(value));
}

/**
 * Проверка id_token. Возвращает `{ ok: true, sub }` либо причину отказа —
 * наружу причина не уходит, она нужна логу и тестам.
 */
async function verifyIdentityToken(provider, token, options = {}) {
  if (!isKnownProvider(provider)) return { ok: false, reason: 'unknown_provider' };
  const audiences = options.audiences || configuredAudiences(provider, options.env);
  if (!audiences.length) return { ok: false, reason: 'provider_not_configured' };
  if (typeof token !== 'string' || !token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    return { ok: false, reason: 'invalid_token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'invalid_token' };
  const header = decodeJsonSegment(parts[0]);
  const claims = decodeJsonSegment(parts[1]);
  const signature = decodeBase64Url(parts[2], MAX_TOKEN_BYTES);
  if (!header || !claims || !signature) return { ok: false, reason: 'invalid_token' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' };
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'invalid_token' };

  let jwk = null;
  try {
    jwk = await findSigningKey(provider, header.kid, options);
  } catch {
    return { ok: false, reason: 'jwks_unavailable' };
  }
  if (!jwk || jwk.kty !== 'RSA') return { ok: false, reason: 'unknown_key' };

  let publicKey = null;
  try {
    publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'unknown_key' };
  }
  if (publicKey.asymmetricKeyType !== 'rsa') return { ok: false, reason: 'unknown_key' };
  const modulusLength = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusLength < MIN_RSA_MODULUS_BITS) return { ok: false, reason: 'weak_key' };

  const signedInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  if (!verifySignature('sha256', signedInput, publicKey, signature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const now = options.now ?? Date.now();
  if (!PROVIDERS[provider].issuers.includes(claims.iss)) return { ok: false, reason: 'bad_issuer' };
  if (!audienceMatches(claims.aud, audiences)) return { ok: false, reason: 'bad_audience' };
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 + CLOCK_SKEW_MS <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (Number.isFinite(claims.iat) && claims.iat * 1000 - CLOCK_SKEW_MS > now) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > MAX_SUBJECT_LEN) {
    return { ok: false, reason: 'invalid_subject' };
  }
  return { ok: true, provider, sub: claims.sub };
}

function isBase64(value, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) return null;
  if (expectedBytes && bytes.length !== expectedBytes) return null;
  return bytes;
}

/**
 * Конверт со словами. Сервер не может его открыть и потому проверяет только
 * форму: чтобы в базу не легло ни чужого размера, ни заниженного KDF, за
 * которым потом окажется пароль из шести знаков и час перебора.
 */
function seedEnvelopeError(envelope, now = Date.now()) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return 'invalid_envelope';
  if (envelope.v !== SEED_ENVELOPE_VERSION) return 'invalid_envelope_version';
  if (!isBase64(envelope.saltB64, SEED_ENVELOPE_SALT_BYTES)) return 'invalid_salt';
  if (!Number.isSafeInteger(envelope.iters)
    || envelope.iters < SEED_ENVELOPE_MIN_ITERS
    || envelope.iters > SEED_ENVELOPE_MAX_ITERS) return 'invalid_iters';
  const data = isBase64(envelope.dataB64);
  if (!data || data.length > SEED_ENVELOPE_MAX_DATA_BYTES) return 'invalid_data';
  if (!Number.isSafeInteger(envelope.savedAt)
    || envelope.savedAt < 0
    || envelope.savedAt > now + CLOCK_SKEW_MS) return 'invalid_saved_at';
  const allowed = new Set(['v', 'saltB64', 'iters', 'dataB64', 'savedAt']);
  if (Object.keys(envelope).some((key) => !allowed.has(key))) return 'unexpected_field';
  return null;
}

module.exports = {
  CLOCK_SKEW_MS,
  PROVIDERS,
  SEED_ENVELOPE_MAX_ITERS,
  SEED_ENVELOPE_MIN_ITERS,
  SEED_ENVELOPE_VERSION,
  configuredAudiences,
  configuredProviders,
  isKnownProvider,
  providerNames,
  resetJwksCache,
  seedEnvelopeError,
  verifyIdentityToken,
};
