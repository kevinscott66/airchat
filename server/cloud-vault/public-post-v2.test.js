/**
 * Снятие публичной копии по одному намерению (v4.32.941).
 *
 * Отдельный файл, а не ещё один тест в public-posts.test.js: окно частоты у
 * сервера общее на процесс, и лишняя дюжина запросов роняла соседний тест
 * ответом 429 — то есть проверял бы он уже не то, ради чего написан.
 *
 * Дефект: «Отозвать ссылку» посылало серверу подписанный `feed_delete` — тот
 * самый конверт, которым автор стирает запись у всех. Копия снималась, но в
 * руках у сервера оставалось бессрочное и годное к повтору разрешение стереть
 * эту запись у каждого контакта, хотя удалять её автор не просил.
 *
 * Правка: тело запроса — только ключ автора и намерение. Сервер сверяет ключ с
 * хранимым `author_public_key` и не выводит did из конверта.
 *
 * Границы: чужое намерение чужую копию не снимает и снятием не объявляется;
 * ключ без подписи под ним не разрешает ничего; повтор гасится разовым числом.
 * Старый путь с конвертом держит первый тест в public-posts.test.js — с ним
 * ходят сборки до v4.32.941.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-post-v2-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
const { app, syncDb } = require('./index');
const { didKeyFromPublicKeyB64 } = require('./official-badge');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function identity(fill) {
  const secretKey = new Uint8Array(32).fill(fill);
  const publicKeyB64 = Buffer.from(ed25519.getPublicKey(secretKey)).toString('base64');
  return { secretKey, publicKeyB64, did: didKeyFromPublicKeyB64(publicKeyB64) };
}

function envelope(who, body) {
  const payload = JSON.stringify(canonicalize(body));
  const signature = Buffer.from(ed25519.sign(Buffer.from(payload, 'utf8'), who.secretKey)).toString('base64');
  return { payload, signature, authorPublicKeyB64: who.publicKeyB64 };
}

function post(who, postId, text) {
  return envelope(who, {
    type: 'feed_post',
    postId,
    authorDid: who.did,
    ts: Date.now(),
    data: { kind: 'post', text, authorName: 'Автор' },
  });
}

let nonceCounter = 0;

function intent(who, postId, act, revision) {
  const payload = JSON.stringify(canonicalize({
    v: 2,
    act: act === 'put' ? 'publish' : act,
    ...(revision !== undefined ? { expectedRevision: revision } : {}),
    postId,
    ts: Date.now(),
    nonce: `nonce${(nonceCounter += 1)}`.padEnd(16, 'x'),
    publicKeyB64: who.publicKeyB64,
  }));
  const signature = Buffer.from(ed25519.sign(Buffer.from(payload, 'utf8'), who.secretKey)).toString('base64');
  return { payload, signature };
}

async function send(base, url, body) {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function put(base, postId, body, signer) {
  return send(base, `/v1/post/${postId}`, { ...body, intent: intent(signer, postId, 'put') });
}

test('v2 state, publish, conditional refresh and revoke enforce persisted revision', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); syncDb.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = identity(42); const other = identity(43); const id = 'public_v2_test';
  const act = (who, action, revision) => send(base, `/v1/post/${id}${action === 'state' ? '/state' : action === 'del' ? '/delete' : ''}`, {
    ...(action === 'publish' || action === 'refresh' ? post(who, id, 'text') : { authorPublicKeyB64: who.publicKeyB64 }),
    intent: intent(who, id, action, revision),
  });
  assert.deepEqual(await (await act(owner, 'state')).json(), { ok: true, revision: 0, active: false });
  assert.equal((await (await act(owner, 'publish', 0)).json()).revision, 1);
  assert.equal((await act(other, 'state')).status, 403);
  const stale = { ...post(owner, id, 'updated'), intent: intent(owner, id, 'refresh', 1) };
  assert.deepEqual(await (await act(owner, 'del', 1)).json(), { ok: true, removed: true, revision: 2, active: false });
  assert.equal((await send(base, `/v1/post/${id}`, stale)).status, 409);
  assert.equal((await act(owner, 'refresh', 2)).status, 409);
  assert.equal((await act(other, 'publish', 0)).status, 403);
  assert.equal((await (await act(owner, 'publish', 2)).json()).revision, 3);
  assert.equal((await act(owner, 'refresh', 3)).status, 200);
  const legacy = JSON.stringify(canonicalize({ v: 1, act: 'put', postId: id, ts: Date.now(), nonce: 'legacy_nonce_00000000', publicKeyB64: owner.publicKeyB64 }));
  const response = await send(base, `/v1/post/${id}`, { ...post(owner, id, 'old'), intent: { payload: legacy, signature: Buffer.from(ed25519.sign(Buffer.from(legacy), owner.secretKey)).toString('base64') } });
  assert.equal(response.status, 426);
});
