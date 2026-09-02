'use strict';

/**
 * Доставка push через FCM HTTP v1.
 *
 * v4.32.537. Клиент с самой первой версии стучится в `/register-token` и
 * `/send-push`, а сервер отдавал на оба 404: ручек не существовало ни здесь,
 * ни где-либо ещё. То есть системных уведомлений в сборках APK и IPA не было
 * вовсе — ни в фоне, ни при закрытом приложении, — и единственным следом
 * этого была строка `push_register_failed` в логе устройства.
 *
 * Что сервер знает о переписке: идентификатор получателя, идентификатор
 * отправителя, CID зашифрованного сообщения и один бит «личное или групповое».
 * Ни текста, ни имён, ни идентификатора группы здесь нет и быть не должно —
 * баннер собирается на устройстве получателя из его собственной базы
 * контактов (см. notifications/pushNotifications, HIGH-4).
 *
 * Оба запроса подписаны ключом Ed25519 отправителя. Без подписи `/register-token`
 * позволял бы кому угодно перебить чужой токен и тем самым выключить человеку
 * уведомления, а `/send-push` — будить произвольное устройство сколько угодно раз.
 */

const crypto = require('crypto');

const { hasExactKeys, isBoundedString, isPeerId, isSignature, verifyEd25519 } = require('./wire');
const {
  MAX_TOKENS,
  TOKEN_TTL_MS,
  createMemoryTokenRegistry,
  createTokenStore,
} = require('./tokenStore');

/**
 * Имя оставлено прежним: хранилище в памяти — это и есть реестр, который тут
 * был до 4.32.538, только теперь у него есть дисковый близнец (tokenStore.js).
 */
const createTokenRegistry = createMemoryTokenRegistry;

const MAX_BODY_BYTES = 8 * 1024;
const MAX_DEVICE_TOKEN_LENGTH = 4096;
const MAX_CID_LENGTH = 128;
const MAX_DID_LENGTH = 256;
/** Насколько метка времени в подписанной нагрузке может расходиться с часами сервера. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SEND_RATE_WINDOW_MS = 60 * 1000;
const SEND_RATE_LIMIT = 60;
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const ACCESS_TOKEN_EARLY_REFRESH_MS = 60 * 1000;
const PLATFORMS = new Set(['android', 'ios']);
const PUSH_KINDS = new Set(['dm', 'group']);
/**
 * Текст, который видит человек на заблокированном экране iPhone, когда
 * приложение закрыто. Он обязан быть безличным: этот текст сочиняет сервер, а
 * сервер не должен уметь подписать сообщение чужим именем.
 */
const IOS_ALERT_TITLE = 'AirChat';
const IOS_ALERT_BODY = 'Новое сообщение — откройте приложение';

function isTimestamp(value, nowMs) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && Math.abs(nowMs - value) <= CLOCK_SKEW_MS;
}

/** Токен устройства FCM: печатные ASCII, длина ограничена. */
function isDeviceToken(value) {
  return isBoundedString(value, MAX_DEVICE_TOKEN_LENGTH) && /^[A-Za-z0-9_:.~%+/=-]+$/.test(value);
}

function isCid(value) {
  return isBoundedString(value, MAX_CID_LENGTH) && /^[A-Za-z0-9]+$/.test(value);
}

function isDid(value) {
  return isBoundedString(value, MAX_DID_LENGTH) && value.startsWith('did:');
}

/**
 * Разобрать конверт `{ payload, signature }` и проверить подпись ключом,
 * который назван внутри самой нагрузки полем `signerField`.
 *
 * Ключ берётся из подписанной нагрузки, а не из отдельного поля конверта:
 * иначе подпись можно было бы предъявить под другим ключом.
 */
function openEnvelope(body, keys, signerField, nowMs) {
  if (!hasExactKeys(body, ['payload', 'signature'])) return null;
  if (typeof body.payload !== 'string' || body.payload.length === 0 || body.payload.length > MAX_BODY_BYTES) return null;
  if (!isSignature(body.signature)) return null;
  let claim;
  try {
    claim = JSON.parse(body.payload);
  } catch {
    return null;
  }
  if (!hasExactKeys(claim, keys)) return null;
  if (!isTimestamp(claim.ts, nowMs)) return null;
  const signer = claim[signerField];
  if (!isPeerId(signer)) return null;
  if (!verifyEd25519(signer, Buffer.from(body.payload, 'utf8'), body.signature)) return null;
  return claim;
}


/** Счётчик отправок на отправителя в скользящем окне. */
function createSendLimiter(options = {}) {
  const windowMs = options.windowMs ?? SEND_RATE_WINDOW_MS;
  const limit = options.limit ?? SEND_RATE_LIMIT;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map();
  return function allow(key) {
    const at = now();
    const bucket = buckets.get(key);
    if (!bucket || at - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: at, count: 1 });
      // Раз в окно чистим тех, кто перестал слать: иначе карта растёт без предела.
      if (buckets.size > 10000) {
        for (const [k, b] of buckets) {
          if (at - b.startedAt >= windowMs) buckets.delete(k);
        }
      }
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  };
}

/**
 * Учётные данные сервисного аккаунта Firebase.
 * Берутся из окружения и никогда не лежат в репозитории.
 */
function loadServiceAccount(env = process.env) {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let parsed;
  try {
    // Допускаем и обычный JSON, и base64 — секреты fly удобнее хранить одной строкой.
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    parsed = JSON.parse(text);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (typeof parsed[field] !== 'string' || parsed[field].length === 0) {
      throw new Error(`FCM_SERVICE_ACCOUNT_JSON is missing ${field}`);
    }
  }
  return {
    projectId: parsed.project_id,
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key.replace(/\\n/g, '\n'),
    tokenUri: typeof parsed.token_uri === 'string' && parsed.token_uri.length > 0
      ? parsed.token_uri
      : 'https://oauth2.googleapis.com/token',
  };
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * Клиент FCM HTTP v1. Access token добывается подписанным JWT сервисного
 * аккаунта — библиотеки для этого не нужно, подпись RS256 умеет node:crypto.
 */
function createFcmClient(serviceAccount, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const sendUrl = options.sendUrl
    ?? `https://fcm.googleapis.com/v1/projects/${serviceAccount.projectId}/messages:send`;
  let cached = null;

  async function accessToken() {
    if (cached && cached.expiresAt - ACCESS_TOKEN_EARLY_REFRESH_MS > now()) return cached.value;
    const issuedAt = Math.floor(now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64url(JSON.stringify({
      iss: serviceAccount.clientEmail,
      scope: FCM_SCOPE,
      aud: serviceAccount.tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    signer.end();
    const assertion = `${header}.${claim}.${base64url(signer.sign(serviceAccount.privateKey))}`;
    const response = await fetchImpl(serviceAccount.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!response.ok) throw new Error(`fcm_token_http_${response.status}`);
    const body = await response.json();
    if (typeof body.access_token !== 'string') throw new Error('fcm_token_malformed');
    const lifetimeMs = (Number(body.expires_in) || 3600) * 1000;
    cached = { value: body.access_token, expiresAt: now() + lifetimeMs };
    return cached.value;
  }

  /**
   * Собрать сообщение под платформу получателя.
   *
   * Android: только `data` и высокий приоритет. Блока `notification` здесь нет
   * намеренно — с ним система рисует баннер сама, а фоновый обработчик при
   * свёрнутом приложении не запускается вовсе, и все настройки («не беспокоить»,
   * заглушённый собеседник, выключенные группы) перестают действовать.
   *
   * iOS: закрытое приложение нельзя разбудить одними данными — APNs покажет
   * что-то, только если в нагрузке есть `alert`. Поэтому текст безличный, а
   * `mutable-content` оставляет приложению возможность заменить его на именной,
   * когда оно живо.
   */
  function buildMessage(entry, data) {
    if (entry.platform === 'ios') {
      return {
        token: entry.token,
        data,
        apns: {
          headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
          payload: {
            aps: {
              alert: { title: IOS_ALERT_TITLE, body: IOS_ALERT_BODY },
              sound: 'default',
              'mutable-content': 1,
              'content-available': 1,
            },
          },
        },
      };
    }
    return {
      token: entry.token,
      data,
      android: { priority: 'HIGH', ttl: '86400s' },
    };
  }

  return {
    /**
     * @returns {Promise<'sent'|'stale'|'failed'>} `stale` — токен отозван
     * устройством, запись следует удалить.
     */
    async send(entry, data) {
      const response = await fetchImpl(sendUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: buildMessage(entry, data) }),
      });
      if (response.ok) return 'sent';
      if (response.status === 404 || response.status === 400) {
        // UNREGISTERED (404) — приложение удалено или токен перевыпущен.
        // INVALID_ARGUMENT (400) на токен — то же самое по существу.
        return 'stale';
      }
      if (response.status === 401 || response.status === 403) cached = null;
      return 'failed';
    },
  };
}

function readJsonBody(request, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        finish(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(null);
      }
    });
    request.on('error', () => finish(null));
  });
}

function respond(response, status, body) {
  const text = JSON.stringify(body ?? {});
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(text);
}

/**
 * HTTP-ручки push. Возвращает обработчик, который сообщает вызывающему,
 * взял ли он запрос на себя, — сигналинг оставляет за собой всё остальное.
 */
function createPushRoutes(options = {}) {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const registry = options.registry ?? createTokenStore({ env: options.env, now, log });
  const allowSend = options.limiter ?? createSendLimiter({ now });
  let fcm = options.fcm ?? null;
  if (!fcm) {
    const account = options.serviceAccount ?? loadServiceAccount(options.env);
    fcm = account ? createFcmClient(account, { now, fetch: options.fetch }) : null;
  }

  async function handleRegister(request, response) {
    const body = await readJsonBody(request);
    const claim = openEnvelope(body, ['peerId', 'platform', 'token', 'ts'], 'peerId', now());
    if (!claim || !PLATFORMS.has(claim.platform) || !isDeviceToken(claim.token)) {
      respond(response, 400, { error: 'bad_request' });
      return;
    }
    registry.set(claim.peerId, claim.token, claim.platform, claim.ts);
    log('push_token_registered', { platform: claim.platform, tokens: registry.size });
    respond(response, 204);
  }

  async function handleSend(request, response) {
    const body = await readJsonBody(request);
    const claim = openEnvelope(
      body,
      ['cid', 'kind', 'senderDid', 'senderPeerId', 'targetPeerId', 'ts'],
      'senderPeerId',
      now()
    );
    if (!claim
      || !isPeerId(claim.targetPeerId)
      || !isCid(claim.cid)
      || !isDid(claim.senderDid)
      || !PUSH_KINDS.has(claim.kind)) {
      respond(response, 400, { error: 'bad_request' });
      return;
    }
    if (!allowSend(claim.senderPeerId)) {
      respond(response, 429, { error: 'rate_limited' });
      return;
    }
    // Ответ одинаков и когда получатель найден, и когда нет: иначе по коду
    // ответа можно было бы перебором узнать, у кого из людей включён push.
    const entry = registry.get(claim.targetPeerId);
    if (!entry) {
      respond(response, 204);
      return;
    }
    if (!fcm) {
      log('push_not_configured', {});
      respond(response, 204);
      return;
    }
    try {
      const outcome = await fcm.send(entry, {
        cid: claim.cid,
        contactDid: claim.senderDid,
        kind: claim.kind,
      });
      if (outcome === 'stale') registry.delete(claim.targetPeerId);
      log('push_sent', { outcome, platform: entry.platform });
    } catch (error) {
      log('push_send_error', { err: error instanceof Error ? error.message : String(error) });
    }
    respond(response, 204);
  }

  return {
    registry,
    get configured() {
      return fcm !== null;
    },
    /** @returns {boolean} взял ли обработчик запрос на себя */
    handle(request, response) {
      if (request.method !== 'POST') return false;
      if (request.url === '/register-token') {
        void handleRegister(request, response);
        return true;
      }
      if (request.url === '/send-push') {
        void handleSend(request, response);
        return true;
      }
      return false;
    },
  };
}

module.exports = {
  createPushRoutes,
  createTokenRegistry,
  createSendLimiter,
  createFcmClient,
  loadServiceAccount,
  openEnvelope,
  constants: {
    MAX_BODY_BYTES,
    MAX_DEVICE_TOKEN_LENGTH,
    MAX_CID_LENGTH,
    MAX_DID_LENGTH,
    CLOCK_SKEW_MS,
    TOKEN_TTL_MS,
    MAX_TOKENS,
    SEND_RATE_WINDOW_MS,
    SEND_RATE_LIMIT,
    IOS_ALERT_TITLE,
    IOS_ALERT_BODY,
  },
};
