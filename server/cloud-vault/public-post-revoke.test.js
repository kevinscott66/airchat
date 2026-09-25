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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-post-revoke-'));
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

function intent(who, postId, act) {
  const payload = JSON.stringify(canonicalize({
    v: 1,
    act,
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

test('снятие копии: хватает намерения, конверт ленты не нужен', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const author = identity(55);
  const other = identity(66);
  const postId = 'f_revoke_000000000000000000000000000';

  assert.equal((await put(base, postId, post(author, postId, 'по ссылке'), author)).status, 200);

  // Чужой со своим честным намерением: запрос принят, но копия не его.
  const strangerDrop = await send(base, `/v1/post/${postId}/delete`, {
    authorPublicKeyB64: other.publicKeyB64,
    intent: intent(other, postId, 'del'),
  });
  assert.equal(strangerDrop.status, 200);
  assert.equal((await strangerDrop.json()).removed, false);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 200);

  // Назвать чужой ключ мало: намерение проверяется им же.
  assert.equal((await send(base, `/v1/post/${postId}/delete`, {
    authorPublicKeyB64: author.publicKeyB64,
    intent: intent(other, postId, 'del'),
  })).status, 400);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 200);

  // Ключ без намерения не разрешает ничего.
  assert.equal(
    (await send(base, `/v1/post/${postId}/delete`, { authorPublicKeyB64: author.publicKeyB64 })).status,
    400,
  );
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 200);

  // Своё намерение снимает копию.
  const mine = { authorPublicKeyB64: author.publicKeyB64, intent: intent(author, postId, 'del') };
  const dropped = await send(base, `/v1/post/${postId}/delete`, mine);
  assert.equal(dropped.status, 200);
  assert.equal((await dropped.json()).removed, true);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 404);

  // А сохранённый запрос второй раз — нет: разовое число погашено.
  assert.equal((await put(base, postId, post(author, postId, 'снова'), author)).status, 200);
  assert.equal((await send(base, `/v1/post/${postId}/delete`, mine)).status, 409);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 200);
});
