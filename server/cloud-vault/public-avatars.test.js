/**
 * v4.32.722: фото профиля «для всех» видно тем, кому его не присылали.
 *
 * Держит: фото кладёт только владелец ключа, повторить запрос нельзя, старый
 * запрос не ложится поверх нового, под видом картинки не уходит ничего
 * другого, и снятое фото перестаёт отдаваться.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-public-avatars-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
const { app } = require('./index');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function identity(fill) {
  const secretKey = new Uint8Array(32).fill(fill);
  const publicKey = Buffer.from(ed25519.getPublicKey(secretKey));
  return { secretKey, publicKeyB64: publicKey.toString('base64'), urlKey: publicKey.toString('base64url') };
}

let nonceCounter = 0;

function signed(who, body, signer = who) {
  const payload = JSON.stringify(canonicalize({
    v: 1,
    ts: Date.now(),
    nonce: `avatarnonce${(nonceCounter += 1)}`.padEnd(16, 'x'),
    publicKeyB64: who.publicKeyB64,
    ...body,
  }));
  const signature = Buffer.from(ed25519.sign(Buffer.from(payload, 'utf8'), signer.secretKey)).toString('base64');
  return { payload, signature };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 3)]);

async function send(base, url, body) {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('фото кладёт владелец ключа, его видят все, снятое не отдаётся', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rita = identity(1);
  const mallory = identity(2);

  // Пока фото нет — ни версии, ни картинки.
  let lookup = await (await send(base, '/v1/avatars/lookup', { keys: [rita.urlKey] })).json();
  assert.deepEqual(lookup, { found: {} });
  assert.equal((await fetch(`${base}/v1/avatar/${rita.urlKey}/img`)).status, 404);

  const put = await send(base, '/v1/avatar', signed(rita, { act: 'put', imageB64: JPEG.toString('base64') }));
  assert.equal(put.status, 200);
  const { v } = await put.json();
  assert.match(v, /^[0-9a-f]{32}$/);

  lookup = await (await send(base, '/v1/avatars/lookup', { keys: [rita.urlKey, mallory.urlKey] })).json();
  assert.deepEqual(lookup, { found: { [rita.urlKey]: v } });

  const img = await fetch(`${base}/v1/avatar/${rita.urlKey}/img?v=${v}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('cache-control'), /max-age=86400/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);

  // Чужая подпись под чужим ключом — отказ; фото Риты на месте.
  const forged = await send(base, '/v1/avatar', signed(rita, { act: 'put', imageB64: PNG.toString('base64') }, mallory));
  assert.equal(forged.status, 400);
  // Тот же запрос второй раз — отказ.
  const once = signed(rita, { act: 'put', imageB64: PNG.toString('base64') });
  assert.equal((await send(base, '/v1/avatar', once)).status, 200);
  assert.equal((await send(base, '/v1/avatar', once)).status, 409);
  const png = await fetch(`${base}/v1/avatar/${rita.urlKey}/img`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('cache-control'), /max-age=300/);

  // Старый запрос не ложится поверх нового.
  const stale = await send(base, '/v1/avatar', signed(rita, { act: 'put', ts: Date.now() - 60_000, imageB64: JPEG.toString('base64') }));
  assert.equal(stale.status, 409);

  // Не картинка — отказ, как бы клиент её ни назвал.
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.equal((await send(base, '/v1/avatar', signed(rita, { act: 'put', mime: 'image/jpeg', imageB64: html.toString('base64') }))).status, 400);
  // Слишком большое — отказ.
  const huge = Buffer.concat([JPEG, Buffer.alloc(400 * 1024)]);
  assert.equal((await send(base, '/v1/avatar', signed(rita, { act: 'put', imageB64: huge.toString('base64') }))).status, 400);
  // Просроченная подпись — отказ.
  assert.equal((await send(base, '/v1/avatar', signed(rita, { act: 'put', ts: Date.now() - 60 * 60_000, imageB64: JPEG.toString('base64') }))).status, 400);

  const del = await send(base, '/v1/avatar', signed(rita, { act: 'del' }));
  assert.deepEqual(await del.json(), { ok: true, removed: true });
  assert.equal((await fetch(`${base}/v1/avatar/${rita.urlKey}/img`)).status, 404);
  lookup = await (await send(base, '/v1/avatars/lookup', { keys: [rita.urlKey] })).json();
  assert.deepEqual(lookup, { found: {} });
});

test('справка по фото отвергает мусор в ключах и слишком большие пачки', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await send(base, '/v1/avatars/lookup', { keys: ['../../etc'] })).status, 400);
  assert.equal((await send(base, '/v1/avatars/lookup', { keys: [] })).status, 400);
  const many = Array.from({ length: 65 }, (_, i) => identity(10 + i).urlKey);
  assert.equal((await send(base, '/v1/avatars/lookup', { keys: many })).status, 400);
  assert.equal((await fetch(`${base}/v1/avatar/short/img`)).status, 400);
});
