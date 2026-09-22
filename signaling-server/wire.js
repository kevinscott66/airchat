'use strict';

/**
 * Проверки формы входящих данных, общие для сокета и HTTP-ручек.
 *
 * До v4.32.537 они лежали внутри index.js и были нужны только сигналингу.
 * Push-ручки проверяют ровно те же peerId и те же подписи, и держать рядом
 * вторую копию нельзя: разойдись они на один символ — и барьер между сетью и
 * хранилищем токенов окажется слабее того, что стоит перед SDP.
 */

const crypto = require('crypto');

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_PEER_ID_LENGTH = 256;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Адрес — короткая строка без пробелов и запятых: IPv4, IPv6 или IPv6%zone. */
const CLIENT_ADDRESS_RE = /^[0-9A-Fa-f.:%_-]{3,64}$/;

/**
 * Доверяем ли заголовкам обратного прокси (v4.32.617) и какому именно.
 *
 * По умолчанию — нет, и это правильный по умолчанию ответ: если сервер стоит
 * голым портом наружу, `X-Forwarded-For` присылает сам клиент, и предел
 * подключений с одного адреса обходится одной строкой заголовка. Включать
 * разрешено только там, где прокси заведомо переписывает заголовок сам.
 *
 * Режимов два (v4.32.721). `fly` — прокси Fly: он сам ставит `Fly-Client-IP`.
 * `loopback` — свой nginx на той же машине (так работает production на VPS):
 * заголовкам верим, только если соединение пришло с 127.0.0.1/::1, и берём
 * лишь последний участок `X-Forwarded-For`. `Fly-Client-IP` в этом режиме
 * не читается: nginx его не переписывает, и клиент подставил бы любой адрес.
 */
function trustProxyMode(env = process.env) {
  const raw = String(env?.TRUST_PROXY ?? '').trim().toLowerCase();
  if (raw === 'fly') return 'fly';
  if (raw === 'loopback' || raw === 'nginx') return 'loopback';
  if (/^(1|true|yes)$/.test(raw)) return env?.FLY_APP_NAME ? 'fly' : 'loopback';
  return 'off';
}

function trustProxyEnabled(env = process.env) {
  return trustProxyMode(env) !== 'off';
}

const LOOPBACK_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

function isLoopbackAddress(address) {
  return typeof address === 'string' && LOOPBACK_RE.test(address);
}

/**
 * Адрес клиента с учётом прокси.
 *
 * Без доверия — адрес сокета, как и было. В режиме `fly` берётся
 * `Fly-Client-IP` (его прокси ставит сам и целиком), а если его нет —
 * ПОСЛЕДНИЙ элемент `X-Forwarded-For`. Именно последний: всё, что клиент
 * прислал сам, прокси оставляет слева и дописывает настоящий адрес справа.
 * Взять первый — значит снова поверить клиенту. В режиме `loopback` —
 * только последний элемент цепочки и только от локального прокси.
 * `true` — старая форма вызова, равная `fly`.
 */
function clientAddressFrom(headers, fallback, trustProxy) {
  const plain = typeof fallback === 'string' && fallback.length > 0 ? fallback : 'unknown';
  const mode = trustProxy === true ? 'fly' : trustProxy;
  if (!headers || (mode !== 'fly' && mode !== 'loopback')) return plain;
  if (mode === 'loopback' && !isLoopbackAddress(plain)) return plain;
  if (mode === 'fly') {
    const direct = headers['fly-client-ip'];
    if (typeof direct === 'string' && CLIENT_ADDRESS_RE.test(direct.trim())) return direct.trim();
  }
  const forwarded = headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  if (typeof chain !== 'string') return plain;
  const hops = chain.split(',');
  const last = hops[hops.length - 1].trim();
  return CLIENT_ADDRESS_RE.test(last) ? last : plain;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function isBoundedString(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !CONTROL_CHARS.test(value);
}

function isCanonicalBase64(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    && value.length % 4 === 0
    && Buffer.from(value, 'base64').toString('base64') === value;
}

function isPeerId(value) {
  if (!isBoundedString(value, MAX_PEER_ID_LENGTH) || !isCanonicalBase64(value)) return false;
  return Buffer.from(value, 'base64').length === ED25519_PUBLIC_KEY_BYTES;
}

function isSignature(value) {
  if (!isCanonicalBase64(value)) return false;
  return Buffer.from(value, 'base64').length === ED25519_SIGNATURE_BYTES;
}

/**
 * Проверить подпись `signature` (base64) под байтами `message` ключом `peerId`
 * (base64 Ed25519). Формат обоих аргументов проверяется здесь же: вызывающему
 * не нужно помнить, что до crypto.verify их полагается отсеять самому.
 */
function verifyEd25519(peerId, message, signature) {
  if (!isPeerId(peerId) || !isSignature(signature)) return false;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(peerId, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, message, publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

module.exports = {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  ED25519_SPKI_PREFIX,
  MAX_PEER_ID_LENGTH,
  isPlainObject,
  hasExactKeys,
  isBoundedString,
  isCanonicalBase64,
  isPeerId,
  isSignature,
  verifyEd25519,
  trustProxyMode,
  trustProxyEnabled,
  isLoopbackAddress,
  clientAddressFrom,
};
