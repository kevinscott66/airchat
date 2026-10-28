'use strict';
// Service/protocol integration: real loopback HTTP, Socket.IO and Ed25519.
// This is not a browser UI, RTCPeerConnection or native-device E2E test.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const signalRequire = createRequire(path.join(__dirname, '../../signaling-server/package.json'));
const { io } = signalRequire('socket.io-client');
const { createSignalingServer } = require('../../signaling-server');

function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function signed(who, value) {
  const payload = JSON.stringify(canonical(value));
  return { payload, signature: crypto.sign(null, Buffer.from(payload), who.privateKey).toString('base64') };
}
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, done); reject(new Error(`missing event ${name}`)); }, 3000);
    function done(value) { clearTimeout(timer); resolve(value); }
    socket.once(name, done);
  });
}
async function openClient(base, sockets) {
  const socket = io(base, { transports: ['websocket'], reconnection: false, autoConnect: false });
  sockets.push(socket);
  socket.on('registration_challenge', value => { socket.challenge = value.challenge; });
  const ready = event(socket, 'registration_challenge'); socket.connect(); await ready;
  return socket;
}
async function register(socket, who, roomId) {
  const signature = crypto.sign(null, Buffer.from(`${socket.challenge}\n${roomId}\n${who.pub}`), who.privateKey).toString('base64');
  const registered = event(socket, 'registered'); socket.emit('register', { roomId, peerId: who.pub, signature });
  assert.equal((await registered).peerId, who.pub);
}

// A fixture cipher only: server stores opaque bytes; production client cipher
// and RN projection behavior are covered by their own unit tests.
function encrypted(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
function decrypted(value, key) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]));
}

test('two clients reconnect, change profile, recover isolated snapshots and revoke public copies', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-two-clients-'));
  process.env.CLOUD_VAULT_DIR = dir; process.env.SYNC_DB_FILE = path.join(dir, 'sync.sqlite');
  const { app, syncDb } = require('../../server/cloud-vault');
  const { didKeyFromPublicKeyB64 } = require('../../server/cloud-vault/official-badge');
  const vault = app.listen(0, '127.0.0.1');
  await new Promise(resolve => vault.once('listening', resolve));
  const signaling = createSignalingServer({ port: 0, host: '127.0.0.1', env: {}, log: () => {} });
  const signalPort = await signaling.listen();
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.close()); await signaling.close();
    await new Promise(resolve => vault.close(resolve)); syncDb.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${vault.address().port}`;
  const signalBase = `http://127.0.0.1:${signalPort}`;
  async function post(url, body, expected = 200) {
    const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  const owner = identity(), alice = identity(), bob = identity(), bobProfile2 = identity();
  const account = crypto.createHash('sha256').update(Buffer.from(owner.pub, 'base64')).digest('hex').slice(0, 32);
  const aliceSocket = await openClient(signalBase, sockets);
  let bobSocket = await openClient(signalBase, sockets);
  await register(aliceSocket, alice, 'alice-room'); await register(bobSocket, bob, 'bob-room');
  const offer = event(bobSocket, 'offer');
  aliceSocket.emit('offer', { roomId: 'alice-room', targetPeerId: bob.pub, sdp: 'v=0 integration offer' });
  assert.equal((await offer).fromPeerId, alice.pub);
  const disconnected = event(aliceSocket, 'peer_unavailable'); bobSocket.disconnect();
  assert.equal((await disconnected).targetPeerId, bob.pub);
  bobSocket = await openClient(signalBase, sockets); await register(bobSocket, bob, 'bob-room');
  const afterReconnect = event(bobSocket, 'offer');
  aliceSocket.emit('offer', { roomId: 'alice-room', targetPeerId: bob.pub, sdp: 'v=0 reconnected' });
  assert.equal((await afterReconnect).sdp, 'v=0 reconnected');
  await register(bobSocket, bobProfile2, 'profile-2');
  const oldUnavailable = event(aliceSocket, 'peer_unavailable');
  aliceSocket.emit('offer', { roomId: 'alice-room', targetPeerId: bob.pub, sdp: 'v=0 old profile' });
  assert.equal((await oldUnavailable).targetPeerId, bob.pub);
  const newOffer = event(bobSocket, 'offer');
  aliceSocket.emit('offer', { roomId: 'alice-room', targetPeerId: bobProfile2.pub, sdp: 'v=0 new profile' });
  assert.equal((await newOffer).fromPeerId, alice.pub);

  function request(who, deviceId, op, extra = {}) {
    return signed(op === 'enroll' ? owner : who, { v: 1, op, accountId: account, publicKeyB64: op === 'enroll' ? owner.pub : who.pub,
      accountPublicKeyB64: owner.pub, devicePublicKeyB64: who.pub, deviceId, timestamp: Date.now(), nonce: crypto.randomBytes(16).toString('base64url'), ...extra });
  }
  for (const [who, id] of [[alice, 'alice'], [bob, 'bob']]) await post(`/v1/sync/${account}/devices/enroll`, request(who, id, 'enroll'));
  const key = crypto.randomBytes(32);
  const row = (profile, revision) => ({ mutationId: `${profile}-${revision}`, entityKind: 'message', entityId: 'shared-local-id', ownerProfileId: profile, revision, deleted: false,
    ciphertextB64: encrypted({ text: `profile${profile}-revision${revision}` }, key), updatedAt: Date.now() });
  await post(`/v1/sync/${account}/push`, request(alice, 'alice', 'push', { mutations: [row(1, 1), row(2, 1)] }));
  const first = await post(`/v1/sync/${account}/pull`, request(bob, 'bob', 'pull', { cursor: null, limit: 100, ownerProfileId: 1 }));
  assert.deepEqual(first.mutations.map(m => m.ownerProfileId), [1]);
  assert.equal(decrypted(first.mutations[0].ciphertextB64, key).text, 'profile1-revision1');
  await post(`/v1/sync/${account}/push`, request(alice, 'alice', 'push', { mutations: [row(1, 2)] }));
  const profile2 = await post(`/v1/sync/${account}/pull`, request(bob, 'bob', 'pull', { cursor: null, limit: 100, ownerProfileId: 2 }));
  assert.deepEqual(profile2.mutations.map(m => m.ownerProfileId), [2]);
  const recovered = await post(`/v1/sync/${account}/pull`, request(bob, 'bob', 'pull', { cursor: first.nextCursor, limit: 100, ownerProfileId: 1 }));
  assert.equal(decrypted(recovered.mutations[0].ciphertextB64, key).text, 'profile1-revision2');
  const retry = await post(`/v1/sync/${account}/pull`, request(bob, 'bob', 'pull', { cursor: null, limit: 100, ownerProfileId: 1 }));
  assert.deepEqual(retry.mutations, recovered.mutations);

  const postId = 'integration_public_link';
  const envelope = { ...signed(alice, { type: 'feed_post', postId, authorDid: didKeyFromPublicKeyB64(alice.pub), ts: Date.now(), data: { kind: 'post', text: 'explicit public fixture' } }), authorPublicKeyB64: alice.pub };
  const intent = (act, expectedRevision) => signed(alice, { v: 2, act, postId, publicKeyB64: alice.pub, ts: Date.now(), nonce: crypto.randomBytes(16).toString('base64url'), ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  const state = await post(`/v1/post/${postId}/state`, { authorPublicKeyB64: alice.pub, intent: intent('state') });
  assert.equal(state.active, false);
  const published = await post(`/v1/post/${postId}`, { ...envelope, intent: intent('publish', state.revision) });
  // Client B reads the public copy while client A queues an old refresh.
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 200);
  const staleRefresh = { ...envelope, intent: intent('refresh', published.revision) };
  await post(`/v1/post/${postId}/delete`, { authorPublicKeyB64: alice.pub, intent: intent('del', published.revision) });
  await post(`/v1/post/${postId}`, staleRefresh, 409);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 404);
});
