/**
 * Бумага на официальную галочку глазами сервера.
 *
 * Настоящим ключом здесь подписать нечего — закрытая половина живёт вне
 * репозитория, — поэтому проверка подписи гоняется на своём ключе через
 * параметр `keys`, а на месте настоящего списка проверяется только то, что он
 * совпадает с клиентским. Обойти саму проверку подписи ради удобства теста
 * значило бы не проверить её вовсе.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const {
  OFFICIAL_VERIFIER_KEYS,
  MAX_GRANT_LEN,
  didKeyFromPublicKeyB64,
  grantedUsername,
} = require('./official-badge');
const { normalizeClaimableUsername } = require('./reserved-usernames');

function issuer(fill) {
  const secretKey = new Uint8Array(32).fill(fill);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, keyB64: Buffer.from(publicKey).toString('base64') };
}

/** Нагрузка канонизируется так же, как её собирает клиентский `signJson`. */
function grant(issued, claim) {
  const payload = JSON.stringify(Object.fromEntries(Object.keys(claim).sort().map((k) => [k, claim[k]])));
  const signature = Buffer.from(ed25519.sign(Buffer.from(payload, 'utf8'), issued.secretKey)).toString('base64');
  return JSON.stringify({ payload, signature });
}

function accountDid(fill) {
  const publicKey = ed25519.getPublicKey(new Uint8Array(32).fill(fill));
  return didKeyFromPublicKeyB64(Buffer.from(publicKey).toString('base64'));
}

test('did:key совпадает с клиентским, включая ведущие нули', () => {
  // Значение получено клиентским publicKeyToDidKey (multiformats) на том же
  // ключе: своя реализация base58btc должна давать ровно ту же строку, иначе
  // сервер и приложение спорят о том, кому выдана бумага.
  assert.equal(
    didKeyFromPublicKeyB64('mhew8W95ET6owjdkGJFFtcDUu9JZNk11gJYpeTOopDM='),
    'did:key:z6MkppmnQ5KBvLzwUtdCyvrCZwg2T1sCR89KqRBQMQCCbzGi',
  );
  assert.equal(didKeyFromPublicKeyB64('короткий'), null);
  assert.equal(didKeyFromPublicKeyB64(Buffer.alloc(31).toString('base64')), null);
  assert.equal(didKeyFromPublicKeyB64(null), null);
});

test('доверенный список ключей совпадает с клиентским', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'core', 'identity', 'officialKeys.ts'),
    'utf8',
  );
  const block = source.slice(source.indexOf('OFFICIAL_VERIFIER_KEYS'));
  const clientKeys = [...block.matchAll(/'([A-Za-z0-9+/=]{40,})'/g)].map((m) => m[1]);
  assert.ok(clientKeys.length > 0, 'client keys parsed');
  assert.deepEqual(clientKeys, [...OFFICIAL_VERIFIER_KEYS]);
});

test('бумага открывает имя своему аккаунту и только ему', () => {
  const issued = issuer(7);
  const did = accountDid(1);
  const raw = grant(issued, { v: 1, kind: 'official', did, username: 'founder', issuedAt: 1 });

  assert.equal(grantedUsername(raw, did, [issued.keyB64]), 'founder');
  // Тот же лист бумаги в руках соседа не работает: он ездит в конверте
  // профиля открытым текстом, и переписать его себе — первое, что придёт в
  // голову получателю.
  assert.equal(grantedUsername(raw, accountDid(2), [issued.keyB64]), null);
  // Подпись чужим ключом — не подпись.
  assert.equal(grantedUsername(raw, did, [issuer(9).keyB64]), null);
});

test('подделка нагрузки не проходит', () => {
  const issued = issuer(7);
  const did = accountDid(1);
  const raw = grant(issued, { v: 1, kind: 'official', did, username: 'support', issuedAt: 1 });
  const forged = raw.replace('support', 'founder');
  assert.equal(grantedUsername(forged, did, [issued.keyB64]), null);

  // Неизвестная версия и неизвестный вид галочки — отказ, а не «ну наверное».
  for (const claim of [
    { v: 2, kind: 'official', did, username: 'founder' },
    { v: 1, kind: 'business', did, username: 'founder' },
    { v: 1, kind: 'official', did, username: 'Плохое' },
    { v: 1, kind: 'official', did },
  ]) {
    assert.equal(grantedUsername(grant(issued, claim), did, [issued.keyB64]), null, JSON.stringify(claim));
  }
});

test('мусор вместо бумаги не роняет разбор', () => {
  const did = accountDid(1);
  for (const raw of ['', '   ', '{', 'null', '{"payload":1}', '{"payload":"x","signature":"нет"}',
    'x'.repeat(MAX_GRANT_LEN + 1), null, 42, {}]) {
    assert.equal(grantedUsername(raw, did), null, String(raw).slice(0, 20));
  }
  assert.equal(grantedUsername('{}', null), null);
});

test('открывается ровно выданное имя, границы формата остаются', () => {
  assert.equal(normalizeClaimableUsername('founder', 'founder'), 'founder');
  assert.equal(normalizeClaimableUsername('@Founder', ' FOUNDER '), 'founder');
  // Бумага на одно имя не открывает соседнее по списку.
  assert.equal(normalizeClaimableUsername('support', 'founder'), null);
  assert.equal(normalizeClaimableUsername('nft', 'founder'), null);
  // И не отменяет набор символов с верхней границей длины.
  assert.equal(normalizeClaimableUsername('кевин', 'кевин'), null);
  assert.equal(normalizeClaimableUsername('a'.repeat(33), 'a'.repeat(33)), null);
  // Без бумаги всё как было.
  assert.equal(normalizeClaimableUsername('founder'), null);
  assert.equal(normalizeClaimableUsername('kevin_s'), 'kevin_s');
});
