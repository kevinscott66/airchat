'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { io: connect } = require('socket.io-client');
const { createSignalingServer } = require('../index');

function waitForEvent(socket, event, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(event, onEvent);
  });
}

async function connectedClient(port) {
  const socket = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  const challenge = waitForEvent(socket, 'registration_challenge');
  await waitForEvent(socket, 'connect');
  socket.registrationChallenge = (await challenge).challenge;
  return socket;
}

function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, peerId: der.subarray(-32).toString('base64') };
}

async function registerClient(socket, who, roomId) {
  const payload = { roomId, peerId: who.peerId };
  const message = Buffer.from(`${socket.registrationChallenge}\n${roomId}\n${who.peerId}`);
  payload.signature = crypto.sign(null, message, who.privateKey).toString('base64');
  const registered = waitForEvent(socket, 'registered');
  socket.emit('register', payload, () => {});
  return registered;
}

test('routes registered offers, answers, ICE candidates, and hangups', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  const alice = await connectedClient(port);
  const bob = await connectedClient(port);
  const aliceId = identity();
  const bobId = identity();
  t.after(async () => {
    alice.close();
    bob.close();
    await server.close();
  });

  await Promise.all([
    registerClient(alice, aliceId, 'room-a'),
    registerClient(bob, bobId, 'room-b'),
  ]);

  const offer = waitForEvent(bob, 'offer');
  alice.emit('offer', { roomId: 'room-a', targetPeerId: bobId.peerId, sdp: 'v=0 offer' });
  assert.deepEqual(await offer, { roomId: 'room-a', fromPeerId: aliceId.peerId, sdp: 'v=0 offer' });

  const answer = waitForEvent(alice, 'answer');
  bob.emit('answer', { targetPeerId: aliceId.peerId, sdp: 'v=0 answer' });
  assert.deepEqual(await answer, { fromPeerId: bobId.peerId, sdp: 'v=0 answer' });

  const candidate = waitForEvent(alice, 'ice-candidate');
  bob.emit('ice-candidate', { targetPeerId: aliceId.peerId, candidate: { candidate: 'candidate:1' } });
  assert.deepEqual(await candidate, { fromPeerId: bobId.peerId, candidate: { candidate: 'candidate:1' } });

  const hangup = waitForEvent(bob, 'hangup');
  alice.emit('hangup', { targetPeerId: bobId.peerId });
  assert.deepEqual(await hangup, { fromPeerId: aliceId.peerId });
});

test('rejects malformed or unauthorized messages and reports unavailable peers', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  const client = await connectedClient(port);
  const clientId = identity();
  t.after(async () => {
    client.close();
    await server.close();
  });

  const notRegistered = waitForEvent(client, 'signaling_error');
  client.emit('answer', { targetPeerId: 'nobody', sdp: 'v=0' });
  assert.deepEqual(await notRegistered, { event: 'answer', error: 'not_registered' });

  await registerClient(client, clientId, 'room-a');

  const invalid = waitForEvent(client, 'signaling_error');
  client.emit('offer', { roomId: 'room-a', targetPeerId: 'bob', sdp: 'v=0', extra: true });
  assert.deepEqual(await invalid, { event: 'offer', error: 'invalid_payload' });

  const unavailable = waitForEvent(client, 'peer_unavailable');
  const unavailablePeerId = identity().peerId;
  client.emit('hangup', { targetPeerId: unavailablePeerId });
  assert.deepEqual(await unavailable, { targetPeerId: unavailablePeerId, roomId: 'room-a' });

  const oversized = waitForEvent(client, 'signaling_error');
  client.emit('answer', { targetPeerId: 'bob', sdp: 'x'.repeat(64 * 1024 + 1) });
  assert.deepEqual(await oversized, { event: 'answer', error: 'invalid_payload' });
});

test('disconnect removes peer and notifies peers in the same room', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  const alice = await connectedClient(port);
  const bob = await connectedClient(port);
  const aliceId = identity();
  const bobId = identity();
  t.after(async () => {
    alice.close();
    bob.close();
    await server.close();
  });

  await Promise.all([
    registerClient(alice, aliceId, 'shared'),
    registerClient(bob, bobId, 'shared'),
  ]);

  const unavailable = waitForEvent(alice, 'peer_unavailable');
  bob.close();
  assert.deepEqual(await unavailable, { targetPeerId: bobId.peerId, roomId: 'shared' });
  assert.equal(server.peers.has(bobId.peerId), false);
});

/**
 * v4.32.581. peerId — открытый ключ человека, а уход из сети — знание о нём.
 * Раньше о разрыве узнавали все подключённые сразу, и посторонний сокет читал
 * по этим событиям, кто из пользователей в сети. В боевом режиме каждый сидит
 * в комнате со своим же именем, поэтому проверяем именно эту форму.
 */
test('о разрыве узнаёт собеседник, а не любой подключённый', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  const aliceId = identity();
  const bobId = identity();
  const eveId = identity();
  const alice = await connectedClient(port);
  const bob = await connectedClient(port);
  const eve = await connectedClient(port);
  t.after(async () => {
    alice.close();
    bob.close();
    eve.close();
    await server.close();
  });

  await Promise.all([
    registerClient(alice, aliceId, aliceId.peerId),
    registerClient(bob, bobId, bobId.peerId),
    registerClient(eve, eveId, eveId.peerId),
  ]);

  // Алиса позвонила Бобу — они собеседники. Ева просто держит сокет открытым.
  const offered = waitForEvent(bob, 'offer');
  alice.emit('offer', { roomId: aliceId.peerId, targetPeerId: bobId.peerId, sdp: 'v=0' });
  await offered;

  let eveSaw = null;
  eve.on('peer_unavailable', (value) => { eveSaw = value; });
  const aliceSaw = waitForEvent(alice, 'peer_unavailable');
  bob.close();

  assert.deepEqual(await aliceSaw, { targetPeerId: bobId.peerId, roomId: bobId.peerId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(eveSaw, null);
});

test('enforces per-socket signaling rate limit', async (t) => {
  const server = createSignalingServer({ port: 0, rateLimit: 1, rateWindowMs: 10_000 });
  const port = await server.listen();
  const client = await connectedClient(port);
  const clientId = identity();
  t.after(async () => {
    client.close();
    await server.close();
  });

  await registerClient(client, clientId, 'room-a');
  const limited = waitForEvent(client, 'signaling_error');
  client.emit('hangup', { targetPeerId: 'bob' });
  assert.deepEqual(await limited, { event: 'hangup', error: 'rate_limited' });
});

test('rejects excess connections before registration', async (t) => {
  const server = createSignalingServer({ port: 0, maxConnections: 1 });
  const port = await server.listen();
  const first = await connectedClient(port);
  t.after(async () => {
    first.close();
    await server.close();
  });

  const second = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  const connectionError = waitForEvent(second, 'connect_error');
  const error = await connectionError;
  assert.equal(error.message, 'connection_limit');
  second.close();
});

test('disconnects clients that never finish registration', async (t) => {
  const server = createSignalingServer({ port: 0, registrationTimeoutMs: 20 });
  const port = await server.listen();
  const client = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  t.after(async () => {
    client.close();
    await server.close();
  });

  await waitForEvent(client, 'connect');
  const disconnected = waitForEvent(client, 'disconnect');
  const error = waitForEvent(client, 'signaling_error');
  assert.deepEqual(await error, { event: 'connection', error: 'registration_timeout' });
  await disconnected;
});

test('события push уходят в лог сервера, а не в пустоту', async () => {
  const events = [];
  const server = createSignalingServer({
    port: 0,
    env: {},
    log: (event, fields) => events.push([event, fields]),
  });
  await server.listen();
  try {
    // Без PUSH_TOKEN_DB реестр остаётся в памяти — и об этом обязано быть
    // видно в логе: иначе после деплоя нельзя отличить том от памяти иначе
    // как заходом по ssh на машину.
    assert.ok(
      events.some(([event]) => event === 'push_tokens_in_memory'),
      `ожидали push_tokens_in_memory, получили ${JSON.stringify(events)}`,
    );
  } finally {
    await server.close();
  }
});

test('звонок в пустоту ждёт получателя и уезжает ему при регистрации', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  const alice = await connectedClient(port);
  const aliceId = identity();
  const bobId = identity();
  t.after(async () => {
    alice.close();
    await server.close();
  });

  await registerClient(alice, aliceId, 'room-a');

  // Боба нет в сети: звонящий получает peer_unavailable и повторяет предложение.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const unavailable = waitForEvent(alice, 'peer_unavailable');
    alice.emit('offer', { roomId: 'room-a', targetPeerId: bobId.peerId, sdp: 'v=0' });
    await unavailable;
  }

  const bob = await connectedClient(port);
  t.after(() => bob.close());
  const missed = waitForEvent(bob, 'missed_calls');
  await registerClient(bob, bobId, 'room-a');
  const payload = await missed;
  assert.equal(payload.calls.length, 1);
  assert.equal(payload.calls[0].fromPeerId, aliceId.peerId);
  // Три повтора одного звонка — один пропущенный звонок, а не три.
  assert.equal(payload.calls[0].attempts, 3);
  assert.equal(typeof payload.calls[0].at, 'number');
});

test('журнал непринятых отдаётся один раз и не переживает доставку предложения', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  const alice = await connectedClient(port);
  const aliceId = identity();
  const bobId = identity();
  t.after(async () => {
    alice.close();
    await server.close();
  });

  await registerClient(alice, aliceId, 'room-a');
  const unavailable = waitForEvent(alice, 'peer_unavailable');
  alice.emit('offer', { roomId: 'room-a', targetPeerId: bobId.peerId, sdp: 'v=0' });
  await unavailable;

  const bob = await connectedClient(port);
  t.after(() => bob.close());
  const missed = waitForEvent(bob, 'missed_calls');
  await registerClient(bob, bobId, 'room-a');
  assert.equal((await missed).calls.length, 1);

  // Второй вход — журнал пуст: он уже доставлен.
  bob.close();
  const bobAgain = await connectedClient(port);
  t.after(() => bobAgain.close());
  let secondDelivery = null;
  bobAgain.on('missed_calls', (value) => { secondDelivery = value; });
  await registerClient(bobAgain, bobId, 'room-a');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondDelivery, null);
});

test('дозвонившийся звонок из журнала непринятых исчезает', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  const alice = await connectedClient(port);
  const aliceId = identity();
  const bobId = identity();
  t.after(async () => {
    alice.close();
    await server.close();
  });

  await registerClient(alice, aliceId, 'room-a');
  const unavailable = waitForEvent(alice, 'peer_unavailable');
  alice.emit('offer', { roomId: 'room-a', targetPeerId: bobId.peerId, sdp: 'v=0' });
  await unavailable;

  // Боб появился и повтор предложения доехал — звонок состоялся.
  const bob = await connectedClient(port);
  t.after(() => bob.close());
  const missed = waitForEvent(bob, 'missed_calls');
  await registerClient(bob, bobId, 'room-a');
  await missed;
  const delivered = waitForEvent(bob, 'offer');
  alice.emit('offer', { roomId: 'room-a', targetPeerId: bobId.peerId, sdp: 'v=0' });
  await delivered;

  bob.close();
  const bobAgain = await connectedClient(port);
  t.after(() => bobAgain.close());
  let afterAnswered = null;
  bobAgain.on('missed_calls', (value) => { afterAnswered = value; });
  await registerClient(bobAgain, bobId, 'room-a');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(afterAnswered, null);
});

test('запись о непринятом звонке живёт не дольше своего срока', async (t) => {
  const server = createSignalingServer({ port: 0, missedCallTtlMs: 10 });
  const port = await server.listen();
  const alice = await connectedClient(port);
  const aliceId = identity();
  const bobId = identity();
  t.after(async () => {
    alice.close();
    await server.close();
  });

  await registerClient(alice, aliceId, 'room-a');
  const unavailable = waitForEvent(alice, 'peer_unavailable');
  alice.emit('offer', { roomId: 'room-a', targetPeerId: bobId.peerId, sdp: 'v=0' });
  await unavailable;

  await new Promise((resolve) => setTimeout(resolve, 40));
  const bob = await connectedClient(port);
  t.after(() => bob.close());
  let expired = null;
  bob.on('missed_calls', (value) => { expired = value; });
  await registerClient(bob, bobId, 'room-a');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(expired, null);
});

/**
 * CORS обычных HTTP-маршрутов (v4.32.563).
 *
 * У socket.io свои заголовки, и они не распространяются на `/webpush-key` и
 * `/register-token`. Веб-версия живёт на другом домене: без этих заголовков
 * браузер отбрасывает ответ молча — на сервере при этом всё выглядит
 * исправным, запрос дошёл и получил 200.
 */
test('веб-версии с другого домена отвечают с заголовками CORS', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  t.after(async () => { await server.close(); });

  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { origin: 'https://air.example.org' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('предполётный запрос браузера получает ответ, а не 404', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  t.after(async () => { await server.close(); });

  const res = await fetch(`http://127.0.0.1:${port}/register-token`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://air.example.org',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(res.headers.get('access-control-allow-headers'), /content-type/);
});

test('CORS_ORIGIN сужает список до одного домена', async (t) => {
  const prev = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://air.example.org';
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  t.after(async () => {
    await server.close();
    if (prev === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = prev;
  });

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://air.example.org');
});

test('404 тоже отвечает с CORS — иначе ошибка не доходит до страницы', async (t) => {
  const server = createSignalingServer({ port: 0 });
  const port = await server.listen();
  t.after(async () => { await server.close(); });

  const res = await fetch(`http://127.0.0.1:${port}/нет-такого`, {
    headers: { origin: 'https://air.example.org' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
