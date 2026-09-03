'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const { createPushRoutes, createTokenRegistry, createSendLimiter } = require('../push');

const ANDROID_TOKEN = 'c'.repeat(140);
const IOS_TOKEN = 'd'.repeat(140);

function makeIdentity() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  return {
    peerId: spki.subarray(spki.length - 32).toString('base64'),
    sign(payload) {
      const text = JSON.stringify(payload);
      return {
        payload: text,
        signature: crypto.sign(null, Buffer.from(text, 'utf8'), pair.privateKey).toString('base64'),
      };
    },
  };
}

/** Поднять ручки на свободном порту и вернуть функцию для POST. */
async function withRoutes(overrides, run) {
  const sent = [];
  const routes = createPushRoutes({
    registry: createTokenRegistry(overrides.registryOptions),
    limiter: overrides.limiter,
    fcm: overrides.fcm ?? {
      async send(entry, data) {
        sent.push({ entry, data });
        return overrides.outcome ?? 'sent';
      },
    },
  });
  const server = http.createServer((request, response) => {
    if (routes.handle(request, response)) return;
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try {
    await run({ post, routes, sent });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('registers a signed device token', async () => {
  const me = makeIdentity();
  await withRoutes({}, async ({ post, routes }) => {
    const response = await post('/register-token', me.sign({
      peerId: me.peerId,
      platform: 'android',
      token: ANDROID_TOKEN,
      ts: Date.now(),
    }));
    assert.equal(response.status, 204);
    assert.equal(routes.registry.get(me.peerId).token, ANDROID_TOKEN);
  });
});

test('rejects a token signed by somebody else', async () => {
  const me = makeIdentity();
  const stranger = makeIdentity();
  await withRoutes({}, async ({ post, routes }) => {
    // Чужой подписывает своим ключом, но называет наш peerId: так выглядит
    // попытка увести чужие уведомления себе.
    const forged = stranger.sign({
      peerId: me.peerId,
      platform: 'android',
      token: ANDROID_TOKEN,
      ts: Date.now(),
    });
    const response = await post('/register-token', forged);
    assert.equal(response.status, 400);
    assert.equal(routes.registry.get(me.peerId), null);
  });
});

test('rejects a tampered payload', async () => {
  const me = makeIdentity();
  await withRoutes({}, async ({ post, routes }) => {
    const envelope = me.sign({
      peerId: me.peerId,
      platform: 'android',
      token: ANDROID_TOKEN,
      ts: Date.now(),
    });
    envelope.payload = envelope.payload.replace(ANDROID_TOKEN, 'e'.repeat(140));
    assert.equal((await post('/register-token', envelope)).status, 400);
    assert.equal(routes.registry.get(me.peerId), null);
  });
});

test('rejects a replayed registration', async () => {
  const me = makeIdentity();
  await withRoutes({}, async ({ post, routes }) => {
    const stale = me.sign({
      peerId: me.peerId,
      platform: 'android',
      token: ANDROID_TOKEN,
      ts: Date.now() - 6 * 60 * 1000,
    });
    assert.equal((await post('/register-token', stale)).status, 400);
    assert.equal(routes.registry.get(me.peerId), null);
  });
});

test('does not let an old signature roll the token back', async () => {
  const me = makeIdentity();
  await withRoutes({}, async ({ post, routes }) => {
    const older = me.sign({
      peerId: me.peerId, platform: 'android', token: ANDROID_TOKEN, ts: Date.now() - 1000,
    });
    const newer = me.sign({
      peerId: me.peerId, platform: 'android', token: 'f'.repeat(140), ts: Date.now(),
    });
    await post('/register-token', newer);
    await post('/register-token', older);
    assert.equal(routes.registry.get(me.peerId).token, 'f'.repeat(140));
  });
});

test('sends a data-only message to Android', async () => {
  const me = makeIdentity();
  const peer = makeIdentity();
  await withRoutes({}, async ({ post, routes, sent }) => {
    routes.registry.set(peer.peerId, ANDROID_TOKEN, 'android', Date.now());
    const response = await post('/send-push', me.sign({
      cid: 'bafyreiabc123',
      kind: 'dm',
      senderDid: 'did:key:z6MkExample',
      senderPeerId: me.peerId,
      targetPeerId: peer.peerId,
      ts: Date.now(),
    }));
    assert.equal(response.status, 204);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].entry.platform, 'android');
    assert.deepEqual(sent[0].data, {
      cid: 'bafyreiabc123',
      contactDid: 'did:key:z6MkExample',
      kind: 'dm',
    });
    // Ни имени, ни текста: баннер собирается на устройстве получателя.
    assert.equal(JSON.stringify(sent[0].data).includes('AirChat'), false);
  });
});

test('звонок проходит проверку вида и доезжает до устройства', async () => {
  const me = makeIdentity();
  const peer = makeIdentity();
  await withRoutes({}, async ({ post, routes, sent }) => {
    routes.registry.set(peer.peerId, ANDROID_TOKEN, 'android', Date.now());
    // До v4.32.573 такой конверт отвергался как bad_request: видов было два,
    // и звонок до закрытого приложения не доезжал вовсе.
    const response = await post('/send-push', me.sign({
      cid: 'a1b2c3d4e5f60718',
      kind: 'call',
      senderDid: 'did:key:z6MkExample',
      senderPeerId: me.peerId,
      targetPeerId: peer.peerId,
      ts: Date.now(),
    }));
    assert.equal(response.status, 204);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].data, {
      cid: 'a1b2c3d4e5f60718',
      contactDid: 'did:key:z6MkExample',
      kind: 'call',
    });
  });
});

test('answers the same way whether or not the recipient is known', async () => {
  const me = makeIdentity();
  const stranger = makeIdentity();
  await withRoutes({}, async ({ post, sent }) => {
    const response = await post('/send-push', me.sign({
      cid: 'bafyreiabc123',
      kind: 'dm',
      senderDid: 'did:key:z6MkExample',
      senderPeerId: me.peerId,
      targetPeerId: stranger.peerId,
      ts: Date.now(),
    }));
    // 204 и при неизвестном получателе: иначе по коду ответа можно было бы
    // перебором выяснить, у кого включены уведомления.
    assert.equal(response.status, 204);
    assert.equal(sent.length, 0);
  });
});

test('drops a token FCM reports as gone', async () => {
  const me = makeIdentity();
  const peer = makeIdentity();
  await withRoutes({ outcome: 'stale' }, async ({ post, routes }) => {
    routes.registry.set(peer.peerId, IOS_TOKEN, 'ios', Date.now());
    await post('/send-push', me.sign({
      cid: 'bafyreiabc123',
      kind: 'group',
      senderDid: 'did:key:z6MkExample',
      senderPeerId: me.peerId,
      targetPeerId: peer.peerId,
      ts: Date.now(),
    }));
    assert.equal(routes.registry.get(peer.peerId), null);
  });
});

test('rate-limits one sender', async () => {
  const me = makeIdentity();
  const peer = makeIdentity();
  await withRoutes({ limiter: createSendLimiter({ limit: 2 }) }, async ({ post, routes }) => {
    routes.registry.set(peer.peerId, ANDROID_TOKEN, 'android', Date.now());
    const send = () => post('/send-push', me.sign({
      cid: 'bafyreiabc123',
      kind: 'dm',
      senderDid: 'did:key:z6MkExample',
      senderPeerId: me.peerId,
      targetPeerId: peer.peerId,
      ts: Date.now(),
    }));
    assert.equal((await send()).status, 204);
    assert.equal((await send()).status, 204);
    assert.equal((await send()).status, 429);
  });
});

test('rejects an unsigned body', async () => {
  const me = makeIdentity();
  await withRoutes({}, async ({ post }) => {
    // Форма, в которой клиент ходил до v4.32.537.
    const response = await post('/register-token', {
      peerId: me.peerId,
      token: ANDROID_TOKEN,
    });
    assert.equal(response.status, 400);
  });
});

test('rejects a body that is not JSON', async () => {
  await withRoutes({}, async ({ post }) => {
    assert.equal((await post('/register-token', 'not json')).status, 400);
  });
});

test('leaves other routes alone', async () => {
  await withRoutes({}, async ({ post }) => {
    assert.equal((await post('/nope', {})).status, 404);
  });
});

/** Ключ RSA нужен только чтобы подписать JWT сервисного аккаунта. */
function fakeServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    projectId: 'airchat-test',
    clientEmail: 'push@airchat-test.iam.gserviceaccount.com',
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    tokenUri: 'https://oauth2.example/token',
  };
}

/** Перехватить обращения к Google и вернуть то, что клиент отправил в FCM. */
function captureFcm(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (url === 'https://oauth2.example/token') {
      return { ok: true, status: 200, async json() { return { access_token: 'at', expires_in: 3600 }; } };
    }
    return { ok: status < 400, status, async json() { return {}; } };
  };
  return { calls, fetchImpl };
}

test('Android message carries data only', async () => {
  const { calls, fetchImpl } = captureFcm();
  const { createFcmClient } = require('../push');
  const client = createFcmClient(fakeServiceAccount(), { fetch: fetchImpl });
  const outcome = await client.send({ token: ANDROID_TOKEN, platform: 'android' }, { cid: 'x', kind: 'dm' });
  assert.equal(outcome, 'sent');
  const message = JSON.parse(calls[calls.length - 1].body).message;
  // Блок notification заставил бы FCM рисовать баннер самому и не будить
  // фоновый обработчик при свёрнутом приложении — тогда настройки тишины,
  // заглушённые собеседники и выключенные группы перестали бы действовать.
  assert.equal('notification' in message, false);
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.android.ttl, '86400s');
  assert.deepEqual(message.data, { cid: 'x', kind: 'dm' });
});

test('iOS message carries an impersonal alert', async () => {
  const { calls, fetchImpl } = captureFcm();
  const { createFcmClient, constants } = require('../push');
  const client = createFcmClient(fakeServiceAccount(), { fetch: fetchImpl });
  await client.send({ token: IOS_TOKEN, platform: 'ios' }, { cid: 'x', kind: 'dm' });
  const message = JSON.parse(calls[calls.length - 1].body).message;
  // Закрытое приложение на iOS нельзя разбудить одними данными: без alert
  // APNs не покажет ничего. Текст безличный — сервер не знает ни имён, ни
  // содержимого и не должен уметь подписать сообщение чужим именем.
  assert.equal(message.apns.payload.aps.alert.title, constants.IOS_ALERT_TITLE);
  assert.equal(message.apns.payload.aps.alert.body, constants.IOS_ALERT_BODY);
  assert.equal(message.apns.headers['apns-push-type'], 'alert');
  assert.equal(message.apns.headers['apns-priority'], '10');
  assert.equal(message.apns.payload.aps['content-available'], 1);
});

test('звонок едет с коротким сроком жизни', async () => {
  const { calls, fetchImpl } = captureFcm();
  const { createFcmClient, constants } = require('../push');
  const client = createFcmClient(fakeServiceAccount(), { fetch: fetchImpl });
  await client.send({ token: ANDROID_TOKEN, platform: 'android' }, { cid: 'c1', kind: 'call' });
  const message = JSON.parse(calls[calls.length - 1].body).message;
  // Звонок живёт секунды: доставленный через час push разбудил бы телефон
  // ради звонка, которого давно нет (звонящий вешает трубку через 45 с).
  assert.equal(message.android.ttl, constants.CALL_TTL);
  assert.notEqual(constants.CALL_TTL, constants.MESSAGE_TTL);
  assert.deepEqual(message.data, { cid: 'c1', kind: 'call' });
});

test('на iOS у звонка свой безличный текст', async () => {
  const { calls, fetchImpl } = captureFcm();
  const { createFcmClient, constants } = require('../push');
  const client = createFcmClient(fakeServiceAccount(), { fetch: fetchImpl });
  await client.send({ token: IOS_TOKEN, platform: 'ios' }, { cid: 'c1', kind: 'call' });
  const message = JSON.parse(calls[calls.length - 1].body).message;
  assert.equal(message.apns.payload.aps.alert.body, constants.IOS_CALL_BODY);
  // Имени звонящего сервер не знает и подписать им чужой экран не может.
  assert.equal(message.apns.payload.aps.alert.title, constants.IOS_ALERT_TITLE);
});

test('reports a revoked token as stale', async () => {
  const { fetchImpl } = captureFcm(404);
  const { createFcmClient } = require('../push');
  const client = createFcmClient(fakeServiceAccount(), { fetch: fetchImpl });
  assert.equal(await client.send({ token: ANDROID_TOKEN, platform: 'android' }, {}), 'stale');
});

test('reuses one access token across sends', async () => {
  const { calls, fetchImpl } = captureFcm();
  const { createFcmClient } = require('../push');
  const client = createFcmClient(fakeServiceAccount(), { fetch: fetchImpl });
  await client.send({ token: ANDROID_TOKEN, platform: 'android' }, {});
  await client.send({ token: ANDROID_TOKEN, platform: 'android' }, {});
  assert.equal(calls.filter((c) => c.url === 'https://oauth2.example/token').length, 1);
});

test('push endpoints stay quiet without credentials', async () => {
  const me = makeIdentity();
  const peer = makeIdentity();
  const routes = createPushRoutes({ env: {} });
  assert.equal(routes.configured, false);
  const server = http.createServer((request, response) => {
    if (routes.handle(request, response)) return;
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    routes.registry.set(peer.peerId, ANDROID_TOKEN, 'android', Date.now());
    const response = await fetch(`${base}/send-push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(me.sign({
        cid: 'bafyreiabc123',
        kind: 'dm',
        senderDid: 'did:key:z6MkExample',
        senderPeerId: me.peerId,
        targetPeerId: peer.peerId,
        ts: Date.now(),
      })),
    });
    // Ключей нет — сигналинг и звонки работают, push молчит.
    assert.equal(response.status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
