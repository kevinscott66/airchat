/**
 * v4.32.612: ссылка на публикацию должна открываться у того, у кого поста нет.
 *
 * Держит здесь три вещи сразу: копия ложится и отдаётся, подделать её нельзя,
 * и удаление у автора убирает её отсюда — иначе ссылка открывала бы стёртое.
 *
 * v4.32.614: к конверту добавлено намерение — отдельная подпись «положить/снять
 * этот пост сейчас». Второй тест держит именно её: без намерения записи нет,
 * повторить тот же запрос нельзя, и пересылающий не выложит чужое за автора.
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

let nonceCounter = 0;

/** Намерение записи: та же подпись, но под коротким «что делаем и когда». */
function intent(who, postId, act, overrides = {}) {
  const payload = JSON.stringify(canonicalize({
    v: 1,
    act,
    postId,
    ts: Date.now(),
    nonce: `nonce${(nonceCounter += 1)}`.padEnd(16, 'x'),
    publicKeyB64: who.publicKeyB64,
    ...overrides,
  }));
  const signature = Buffer.from(ed25519.sign(Buffer.from(payload, 'utf8'), who.secretKey)).toString('base64');
  return { payload, signature };
}

/** Тело запроса целиком: конверт от `who` плюс намерение от `signer`. */
function withIntent(body, signer, postId, act, overrides) {
  if (!signer) return body;
  return { ...body, intent: intent(signer, postId, act, overrides) };
}

async function send(base, url, body) {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function put(base, postId, body, signer = null, act = 'put', overrides = undefined) {
  return send(base, `/v1/post/${postId}`, withIntent(body, signer, postId, act, overrides));
}

test('публичная копия публикации кладётся, читается и снимается', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const author = identity(11);
  const stranger = identity(22);
  const postId = 'f_1788696219251_88dbce61b8fda1002ea9bb32fa38a246';

  const stored = await put(base, postId, post(author, postId, 'привет'), author);
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
  assert.equal((await put(base, postId, tampered, author)).status, 400);

  // Нагрузка подписана честно, но не про этот пост.
  assert.equal((await put(base, postId, post(author, 'f_3_other', 'чужой'), author)).status, 400);

  // did внутри нагрузки обязан выводиться из приложенного ключа.
  const impersonation = post(author, postId, 'привет');
  impersonation.authorPublicKeyB64 = stranger.publicKeyB64;
  assert.equal((await put(base, postId, impersonation, author)).status, 400);

  // Занятый идентификатор чужой автор не переписывает.
  assert.equal((await put(base, postId, post(stranger, postId, 'захват'), stranger)).status, 403);

  // Свой же пост переписать можно — это правка.
  assert.equal((await put(base, postId, post(author, postId, 'правка'), author)).status, 200);
  assert.equal(JSON.parse((await (await fetch(`${base}/v1/post/${postId}`)).json()).payload).data.text, 'правка');

  const deleteBody = (who) => envelope(who, {
    type: 'feed_delete',
    postId,
    authorDid: who.did,
    ts: Date.now(),
    data: { kind: 'delete' },
  });

  const strangerDelete = await send(
    base,
    `/v1/post/${postId}/delete`,
    withIntent(deleteBody(stranger), stranger, postId, 'del'),
  );
  assert.equal(strangerDelete.status, 200);
  assert.equal((await strangerDelete.json()).removed, false);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 200);

  const authorDelete = await send(
    base,
    `/v1/post/${postId}/delete`,
    withIntent(deleteBody(author), author, postId, 'del'),
  );
  assert.equal(authorDelete.status, 200);
  assert.equal((await authorDelete.json()).removed, true);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 404);
});

test('намерение записи: без него нельзя, дважды нельзя, за автора нельзя', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  // База и каталог общие на весь файл: закрываем их в последнем тесте.
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const author = identity(33);
  const relay = identity(44);
  const postId = 'f_intent_0000000000000000000000000000';

  // Один конверт на все проверки: подпись под ним всюду настоящая и авторская.
  const body = post(author, postId, 'намерение');

  // Голый конверт — тот самый, что расходится по ленте: его мало.
  assert.equal((await put(base, postId, body)).status, 400);

  // Пересылающий держит конверт в руках, но своим ключом за автора не подпишет.
  assert.equal((await put(base, postId, body, relay)).status, 400);

  // Намерение про другое действие на этот маршрут не годится.
  assert.equal((await put(base, postId, body, author, 'del')).status, 400);

  // …и про другой пост тоже.
  assert.equal((await put(base, postId, body, author, 'put', { postId: 'f_other' })).status, 400);

  // Часы разошлись сильнее допустимого — намерение просрочено.
  const stale = Date.now() - 30 * 60 * 1000;
  assert.equal((await put(base, postId, body, author, 'put', { ts: stale })).status, 400);

  // Настоящее намерение проходит.
  const good = withIntent(body, author, postId, 'put');
  assert.equal((await send(base, `/v1/post/${postId}`, good)).status, 200);

  // А тот же запрос целиком, отправленный второй раз, — уже нет: разовое
  // число погашено. Именно так воскрешали удалённую копию сохранённым запросом.
  assert.equal((await send(base, `/v1/post/${postId}`, good)).status, 409);

  // Автор снимает копию и повторяет своё же удаление: второй раз не проходит.
  const del = withIntent(
    envelope(author, { type: 'feed_delete', postId, authorDid: author.did, ts: Date.now(), data: { kind: 'delete' } }),
    author,
    postId,
    'del',
  );
  assert.equal((await send(base, `/v1/post/${postId}/delete`, del)).status, 200);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 404);
  assert.equal((await send(base, `/v1/post/${postId}/delete`, del)).status, 409);

  // И сохранённая ранее удачная запись поста не воскрешает его.
  assert.equal((await send(base, `/v1/post/${postId}`, good)).status, 409);
  assert.equal((await fetch(`${base}/v1/post/${postId}`)).status, 404);
});
