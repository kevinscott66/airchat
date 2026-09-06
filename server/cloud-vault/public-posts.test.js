/**
 * v4.32.612: ссылка на публикацию должна открываться у того, у кого поста нет.
 *
 * Держит здесь три вещи сразу: копия ложится и отдаётся, подделать её нельзя,
 * и удаление у автора убирает её отсюда — иначе ссылка открывала бы стёртое.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-public-posts-'));
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

async function put(base, postId, body) {
  return fetch(`${base}/v1/post/${postId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('публичная копия публикации кладётся, читается и снимается', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const author = identity(11);
  const stranger = identity(22);
  const postId = 'f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246';

  const stored = await put(base, postId, post(author, postId, 'привет'));
  assert.equal(stored.status, 200);

  const fetched = await fetch(`${base}/v1/post/${postId}`);
  assert.equal(fetched.status, 200);
  const got = await fetched.json();
  assert.equal(JSON.parse(got.payload).data.text, 'привет');
  assert.equal(got.authorPublicKeyB64, author.publicKeyB64);

  assert.equal((await fetch(`${base}/v1/post/f_нет_такого`)).status, 400);
  assert.equal((await fetch(`${base}/v1/post/f_2_missing`)).status, 404);

  // Подпись под другим текстом не подходит.
  const tampered = post(author, postId, 'привет');
  tampered.payload = tampered.payload.replace('привет', 'подмена');
  assert.equal((await put(base, postId, tampered)).status, 400);

  // Нагрузка подписана честно, но не про этот пост.
  assert.equal((await put(base, postId, post(author, 'f_3_other', 'чужой'))).status, 400);

  // did внутри нагрузки обязан выводиться из приложенного ключа.
  const impersonation = post(author, postId, 'привет');
  impersonation.authorPublicKeyB64 = stranger.publicKeyB64;
  assert.equal((await put(base, postId, impersonation)).status, 400);

  // Занятый идентификатор чужой автор не переписывает.
  assert.equal((await put(base, postId, post(stranger, postId, 'захват'))).status, 403);

  // Свой же пост переписать можно — это правка.
  assert.equal((await put(base, postId, post(author, postId, 'правка'))).status, 200);
  assert.equal(JSON.parse((await (await fetch(`${base}/v1/post/${postId}`)).json()).payload).data.text, 'правка');

  const deleteBody = (who) => envelope(who, {
    type: 'feed_delete',
    postId,
    authorDid: who.did,
    ts: Date.now(),
    data: { kind: 'delete' },
  });

  const strangerDelete = await fetch(`${base}/v1/post/${postId}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deleteBody(stranger)),
  });
  assert.equal(strangerDelete.status, 200);
  assert.equal((await strangerDelete.json()).removed, false);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 200);

  const authorDelete = await fetch(`${base}/v1/post/${postId}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deleteBody(author)),
  });
  assert.equal(authorDelete.status, 200);
  assert.equal((await authorDelete.json()).removed, true);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 404);
});
