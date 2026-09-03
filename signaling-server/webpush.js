'use strict';

/**
 * Web Push для веб-версии (v4.32.560).
 *
 * У браузера, в отличие от iPhone, фоновая доставка есть и не требует ничьих
 * сертификатов: Service Worker + Push API + подпись VAPID. Установленная как
 * PWA страница получает уведомление, даже когда вкладка закрыта, — то есть
 * ровно то, чего нет и не может быть в сборке IPA.
 *
 * Уведомление уходит ПУСТЫМ. RFC 8030 это разрешает, и здесь это не экономия,
 * а решение: содержимое push проходит через чужой сервис (Google, Mozilla,
 * Apple), и единственный способ ничего ему не сообщить — не посылать ничего.
 * Service Worker показывает общий баннер, а что именно пришло, страница
 * выясняет сама, когда её откроют. Побочно это снимает и всю обвязку
 * шифрования полезной нагрузки (RFC 8291): шифровать нечего.
 *
 * Подписка (endpoint + ключи браузера) приходит через тот же подписанный
 * `/register-token`, что и токены FCM, с platform: 'web'. Ключи браузера нам
 * не нужны — мы не шифруем — но и выбрасывать их незачем: подписка хранится
 * целиком, как её отдал браузер.
 *
 * Ключи VAPID берутся из окружения:
 *   VAPID_PUBLIC_KEY   — base64url несжатой точки P-256 (65 байт);
 *   VAPID_PRIVATE_KEY  — base64url скаляра (32 байта) либо PKCS#8 PEM;
 *   VAPID_SUBJECT      — mailto: или https:, кого спрашивать при злоупотреблении.
 * Без них модуль не поднимается и web-push просто не отправляется — молча для
 * клиента и одной строкой в лог для нас.
 */

const crypto = require('crypto');

/** Секунды жизни push в очереди сервиса. Звонок дольше минуты не нужен никому. */
const CALL_TTL_SECONDS = 60;
const MESSAGE_TTL_SECONDS = 24 * 60 * 60;
/** Срок JWT. Спецификация запрещает больше суток; берём половину. */
const JWT_TTL_SECONDS = 12 * 60 * 60;
const MAX_SUBSCRIPTION_BYTES = 4096;
const P256_OID = '06082a8648ce3d030107';

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Разбирает подписку так, как её отдаёт `PushSubscription.toJSON()`.
 * Всё, что не похоже на подписку, — не подписка: сюда приходит строка из
 * сети, и единственная защита от неё — форма.
 */
function parseSubscription(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_SUBSCRIPTION_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(token);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.endpoint !== 'string') return null;
  let url;
  try {
    url = new URL(parsed.endpoint);
  } catch {
    return null;
  }
  // Только https и только наружу: иначе сервер по чужой просьбе постучится
  // куда угодно внутри своей сети (SSRF).
  if (url.protocol !== 'https:') return null;
  return { endpoint: url.href, origin: url.origin };
}

/**
 * Приватный ключ P-256 из «сырого» скаляра. Браузерный мир хранит ключи VAPID
 * именно так (base64url 32 байта), а node ждёт DER, поэтому собираем SEC1
 * вручную: версия, скаляр, OID кривой, открытая точка.
 */
function privateKeyFromRaw(rawPrivate, rawPublic) {
  if (rawPrivate.length !== 32) return null;
  if (rawPublic.length !== 65 || rawPublic[0] !== 0x04) return null;
  const der = Buffer.from(
    '3077020101' + '0420' + rawPrivate.toString('hex')
    + 'a00a' + P256_OID
    + 'a144' + '0342' + '00' + rawPublic.toString('hex'),
    'hex'
  );
  try {
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' });
  } catch {
    return null;
  }
}

function loadVapid(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateRaw = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateRaw || !subject) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  let key = null;
  if (privateRaw.includes('BEGIN')) {
    try {
      key = crypto.createPrivateKey(privateRaw);
    } catch {
      key = null;
    }
  } else {
    key = privateKeyFromRaw(fromBase64url(privateRaw), fromBase64url(publicKey));
  }
  if (!key) return null;
  return { publicKey, key, subject };
}

/** Заголовок Authorization по RFC 8292: JWT ES256 плюс открытый ключ. */
function vapidHeader(vapid, audience, nowMs) {
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = base64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(nowMs / 1000) + JWT_TTL_SECONDS,
    sub: vapid.subject,
  }));
  const signingInput = `${header}.${claims}`;
  // ieee-p1363 — это r||s, которого требует JWS. По умолчанию node отдаёт DER,
  // и push-сервис отвергает такую подпись как невалидную.
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: vapid.key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${base64url(signature)}, k=${vapid.publicKey}`;
}

/**
 * Отправитель web-push. `null`, если ключи VAPID не заданы, — вызывающий
 * обязан это проверить.
 */
function createWebPushClient(options = {}) {
  const vapid = options.vapid ?? loadVapid(options.env);
  if (!vapid) return null;
  const now = options.now ?? (() => Date.now());
  const doFetch = options.fetch ?? ((...args) => fetch(...args));
  return {
    get publicKey() {
      return vapid.publicKey;
    },
    /**
     * @returns {Promise<'sent'|'stale'|'rejected'>} — 'stale' означает, что
     * подписки больше нет и запись пора удалить.
     */
    async send(entry, message = {}) {
      const subscription = parseSubscription(entry.token);
      if (!subscription) return 'stale';
      const ttl = message.kind === 'call' ? CALL_TTL_SECONDS : MESSAGE_TTL_SECONDS;
      const response = await doFetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidHeader(vapid, subscription.origin, now()),
          TTL: String(ttl),
          // Звонок будит устройство немедленно; сообщение может подождать
          // общего пробуждения и не сажать чужую батарею.
          Urgency: message.kind === 'call' ? 'high' : 'normal',
          'Content-Length': '0',
        },
      });
      if (response.status === 404 || response.status === 410) return 'stale';
      return response.ok ? 'sent' : 'rejected';
    },
  };
}

/** Пара ключей VAPID для первичной настройки сервера. */
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const raw = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return {
    publicKey: base64url(Buffer.concat([
      Buffer.from([0x04]),
      fromBase64url(raw.x),
      fromBase64url(raw.y),
    ])),
    privateKey: priv.d,
  };
}

module.exports = {
  CALL_TTL_SECONDS,
  MESSAGE_TTL_SECONDS,
  JWT_TTL_SECONDS,
  MAX_SUBSCRIPTION_BYTES,
  createWebPushClient,
  generateVapidKeys,
  loadVapid,
  parseSubscription,
  privateKeyFromRaw,
  vapidHeader,
};
