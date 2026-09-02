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
};
