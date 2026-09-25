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
// v4.32.940: подмена байтов в обход конечной точки — так это и выглядит у
// того, кто добрался до хранилища.
const { DatabaseSync } = require('node:sqlite');

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

/**
 * v4.32.940. Дефект: фото отдавалось голыми байтами, и поверить в них можно
 * было только серверу — метку версии он считает сам, подписи под ней нет.
 * Кто угодно с доступом к базе подменял человеку лицо, и заметить это было
 * нечем. Подпись владельца при этом существовала: она проверялась на входе и
 * выбрасывалась.
 *
 * Правка: подпись хранится, и `/signed` отдаёт подписанную строку целиком,
 * собранную обратно из байтов, nonce и ts. Ключ для проверки показывающая
 * сторона берёт не из ответа: адрес запроса и есть этот ключ.
 */
test('фото отдаётся вместе с подписью владельца, и подпись сходится', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const nina = identity(80);

  assert.equal((await fetch(`${base}/v1/avatar/${nina.urlKey}/signed`)).status, 404);

  assert.equal((await send(base, '/v1/avatar', signed(nina, { act: 'put', imageB64: JPEG.toString('base64') }))).status, 200);

  const proof = await fetch(`${base}/v1/avatar/${nina.urlKey}/signed`);
  assert.equal(proof.status, 200);
  const body = await proof.json();

  // Подпись сходится с ключом, которым и спрашивали, — а не с тем, который
  // сервер назвал бы сам.
  const publicKey = Buffer.from(nina.urlKey, 'base64url');
  assert.equal(
    ed25519.verify(Buffer.from(body.signature, 'base64'), Buffer.from(body.payload, 'utf8'), publicKey),
    true,
  );

  const parsed = JSON.parse(body.payload);
  assert.equal(parsed.act, 'put');
  assert.equal(parsed.publicKeyB64, nina.publicKeyB64);
  // В строке лежит ровно то фото, что отдаёт /img: подпись покрывает байты.
  assert.deepEqual(Buffer.from(parsed.imageB64, 'base64'), JPEG);
  const img = await fetch(`${base}/v1/avatar/${nina.urlKey}/signed`.replace('/signed', '/img'));
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);

  // ПОДМЕНА. Байты в базе меняем в обход конечной точки — ровно так это и
  // выглядело бы у того, кто добрался до хранилища.
  const db = new DatabaseSync(path.join(dataDir, 'sync.sqlite'));
  db.prepare('UPDATE public_avatars SET bytes = ? WHERE public_key = ?').run(PNG, nina.publicKeyB64);
  db.close();

  const swapped = await fetch(`${base}/v1/avatar/${nina.urlKey}/signed`);
  assert.equal(swapped.status, 409);
  assert.equal((await swapped.json()).error, 'avatar_proof_broken');

  // Снятое фото не отдаёт и доказательства.
  assert.equal((await send(base, '/v1/avatar', signed(nina, { act: 'del' }))).status, 200);
  assert.equal((await fetch(`${base}/v1/avatar/${nina.urlKey}/signed`)).status, 404);
  assert.equal((await fetch(`${base}/v1/avatar/short/signed`)).status, 400);
});

/**
 * Записи, положенные до v4.32.940, подписи не хранят: она была в запросе, а
 * запрос давно отработан. Такое фото не выдаётся за доказанное — иначе смысл
 * правки терялся бы ровно там, где он нужен.
 */
test('фото без сохранённой подписи не выдаётся за доказанное', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const oleg = identity(81);
  assert.equal((await send(base, '/v1/avatar', signed(oleg, { act: 'put', imageB64: JPEG.toString('base64') }))).status, 200);

  const db = new DatabaseSync(path.join(dataDir, 'sync.sqlite'));
  db.prepare('UPDATE public_avatars SET sig = NULL, nonce = NULL WHERE public_key = ?').run(oleg.publicKeyB64);
  db.close();

  const proof = await fetch(`${base}/v1/avatar/${oleg.urlKey}/signed`);
  assert.equal(proof.status, 409);
  assert.equal((await proof.json()).error, 'avatar_proof_missing');
  // Байты при этом на месте: старые записи не пропадают, их просто некому
  // подтвердить.
  assert.equal((await fetch(`${base}/v1/avatar/${oleg.urlKey}/img`)).status, 200);
});
