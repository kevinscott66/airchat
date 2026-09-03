'use strict';

/**
 * Web Push (v4.32.560).
 *
 * Проверяем три вещи, на которых всё держится: что подпиской считается только
 * то, что действительно ею является (иначе сервер по чужой просьбе постучится
 * куда угодно), что подпись VAPID проверяется тем самым ключом, который мы
 * объявляем браузеру, и что push уходит пустым — без единого байта содержимого
 * через чужой сервис.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  CALL_TTL_SECONDS,
  MESSAGE_TTL_SECONDS,
  JWT_TTL_SECONDS,
  MAX_SUBSCRIPTION_BYTES,
  createWebPushClient,
  generateVapidKeys,
  loadVapid,
  parseSubscription,
  vapidHeader,
} = require('../webpush');

const ENDPOINT = 'https://fcm.googleapis.com/wp/fake-registration-id';

function subscription(endpoint = ENDPOINT) {
  return JSON.stringify({
    endpoint,
    expirationTime: null,
    keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
  });
}

function fakeEnv() {
  const keys = generateVapidKeys();
  return {
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: 'mailto:push@example.org',
  };
}

/** Открытый ключ VAPID (несжатая точка base64url) как ключ для проверки подписи. */
function publicKeyObject(base64url) {
  const raw = Buffer.from(base64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
  const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) },
    format: 'jwk',
  });
}

/** Собрать клиент с перехватом исходящего запроса. */
function client(env, extra = {}) {
  const calls = [];
  const push = createWebPushClient({
    env,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return extra.response ?? { ok: true, status: 201 };
    },
    now: extra.now,
  });
  return { push, calls };
}

test('подпиской считается только https-адрес из настоящего JSON', () => {
  const ok = parseSubscription(subscription());
  assert.equal(ok.endpoint, ENDPOINT);
  assert.equal(ok.origin, 'https://fcm.googleapis.com');
  // Всё, что не подписка, — не подписка: строка из сети, форма — единственная защита.
  assert.equal(parseSubscription(subscription('http://fcm.googleapis.com/wp/x')), null);
  assert.equal(parseSubscription('c'.repeat(140)), null);
  assert.equal(parseSubscription('{'), null);
  assert.equal(parseSubscription(JSON.stringify({ keys: {} })), null);
  assert.equal(parseSubscription(''), null);
  assert.equal(parseSubscription(null), null);
});

test('адрес внутрь своей сети подпиской не считается', () => {
  // Иначе сервер по чужой просьбе стучится в собственный периметр (SSRF).
  for (const endpoint of [
    'http://127.0.0.1/wp/x',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ]) {
    assert.equal(parseSubscription(JSON.stringify({ endpoint })), null, endpoint);
  }
});

test('подписка длиннее разрешённого отвергается целиком', () => {
  const huge = JSON.stringify({ endpoint: `${ENDPOINT}/${'z'.repeat(MAX_SUBSCRIPTION_BYTES)}` });
  assert.ok(huge.length > MAX_SUBSCRIPTION_BYTES);
  assert.equal(parseSubscription(huge), null);
});

test('ключи VAPID из окружения поднимаются, а неполные — нет', () => {
  const env = fakeEnv();
  const vapid = loadVapid(env);
  assert.equal(vapid.publicKey, env.VAPID_PUBLIC_KEY);
  assert.equal(vapid.subject, env.VAPID_SUBJECT);
  assert.equal(loadVapid({}), null);
  assert.equal(loadVapid({ ...env, VAPID_SUBJECT: 'push@example.org' }), null);
  assert.equal(loadVapid({ ...env, VAPID_PRIVATE_KEY: 'not-a-key' }), null);
});

test('подпись JWT проверяется тем ключом, который объявлен браузеру', () => {
  const env = fakeEnv();
  const vapid = loadVapid(env);
  const nowMs = 1_700_000_000_000;
  const header = vapidHeader(vapid, 'https://fcm.googleapis.com', nowMs);
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, header);
  const [, jwt, advertised] = match;
  assert.equal(advertised, env.VAPID_PUBLIC_KEY);
  const [head, claims, signature] = jwt.split('.');
  const decode = (part) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.deepEqual(decode(head), { typ: 'JWT', alg: 'ES256' });
  const body = decode(claims);
  assert.equal(body.aud, 'https://fcm.googleapis.com');
  assert.equal(body.sub, env.VAPID_SUBJECT);
  assert.equal(body.exp, Math.floor(nowMs / 1000) + JWT_TTL_SECONDS);
  // Спецификация запрещает срок больше суток.
  assert.ok(JWT_TTL_SECONDS <= 24 * 60 * 60);
  const verified = crypto.verify(
    'sha256',
    Buffer.from(`${head}.${claims}`, 'utf8'),
    { key: publicKeyObject(advertised), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  );
  assert.equal(verified, true);
});

test('без ключей VAPID клиента нет вовсе', () => {
  assert.equal(createWebPushClient({ env: {} }), null);
});

test('push уходит пустым — ни cid, ни did через чужой сервис не проходят', async () => {
  const env = fakeEnv();
  const { push, calls } = client(env);
  const outcome = await push.send(
    { token: subscription(), platform: 'web' },
    { cid: 'bafyreiabc123', contactDid: 'did:key:z6MkExample', kind: 'dm' }
  );
  assert.equal(outcome, 'sent');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, undefined);
  assert.equal(init.headers['Content-Length'], '0');
  // Ни одно поле сообщения не должно оказаться в запросе.
  const dump = JSON.stringify(init);
  assert.ok(!dump.includes('bafyreiabc123'));
  assert.ok(!dump.includes('z6MkExample'));
});

test('звонок торопится, сообщение ждёт', async () => {
  const env = fakeEnv();
  const call = client(env);
  await call.push.send({ token: subscription(), platform: 'web' }, { kind: 'call' });
  assert.equal(call.calls[0].init.headers.TTL, String(CALL_TTL_SECONDS));
  assert.equal(call.calls[0].init.headers.Urgency, 'high');
  const dm = client(env);
  await dm.push.send({ token: subscription(), platform: 'web' }, { kind: 'dm' });
  assert.equal(dm.calls[0].init.headers.TTL, String(MESSAGE_TTL_SECONDS));
  // Сообщение может подождать общего пробуждения и не сажать чужую батарею.
  assert.equal(dm.calls[0].init.headers.Urgency, 'normal');
  assert.ok(CALL_TTL_SECONDS < MESSAGE_TTL_SECONDS);
});

test('пропавшая подписка отличается от временной ошибки', async () => {
  const env = fakeEnv();
  for (const status of [404, 410]) {
    const { push } = client(env, { response: { ok: false, status } });
    assert.equal(await push.send({ token: subscription(), platform: 'web' }, {}), 'stale');
  }
  const failing = client(env, { response: { ok: false, status: 500 } });
  // Сервис сломался — подписка ни при чём, удалять её нельзя.
  assert.equal(await failing.push.send({ token: subscription(), platform: 'web' }, {}), 'rejected');
  const broken = client(env);
  assert.equal(await broken.push.send({ token: 'not-a-subscription', platform: 'web' }, {}), 'stale');
  assert.equal(broken.calls.length, 0);
});
