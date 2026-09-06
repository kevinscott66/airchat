/**
 * v4.32.614: один запрос не имеет права уронить службу.
 *
 * Два разных промаха сходились в одну дыру. `canonicalize` рекурсивна, а
 * `JSON.parse` — нет: тело `{"a":{"a":…` в пять тысяч уровней разбиралось
 * молча, и первая же канонизация уходила в RangeError. В синхронном
 * обработчике express такое ловит, но `PUT /v1/cloud-vault/:accountId`
 * объявлен async, а express 4 промисов не ловит — бросок становился
 * unhandledRejection, и node 22 убивает такой процесс по умолчанию. Ни подписи,
 * ни аккаунта для этого не требовалось.
 *
 * Второе — потолок тела выбирался по хвосту пути (`endsWith('/push')`), то есть
 * восемьдесят мегабайт выдавались и несуществующему адресу: тело разбиралось
 * целиком только затем, чтобы ответить 404.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-robustness-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
const { app, syncDb } = require('./index');

function deepJson(levels) {
  return `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;
}

test('глубокое тело отвергается, а служба остаётся жива', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const accountId = 'a'.repeat(32);

  // Ровно тот запрос, что раньше гасил процесс: подписи нет, аккаунта нет.
  const attack = await fetch(`${base}/v1/cloud-vault/${accountId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: deepJson(5000), signature: 'AAAA' }),
  });
  assert.equal(attack.status, 401);
  assert.equal((await attack.json()).error, 'invalid_signature');

  // Служба отвечает дальше — это и есть суть проверки.
  assert.equal((await fetch(`${base}/health`)).status, 200);

  // Настоящая, неглубокая нагрузка отвергается ровно так же, без падения.
  const shallow = await fetch(`${base}/v1/cloud-vault/${accountId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: deepJson(4), signature: 'AAAA' }),
  });
  assert.equal(shallow.status, 401);

  // Испорченный JSON отвечает коротким json, а не HTML со стеком.
  const broken = await fetch(`${base}/v1/cloud-vault/${accountId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error, 'bad_request');
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('потолок тела выбирается по настоящему маршруту', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) });

  // Хвост пути тот же, маршрута такого нет: три мегабайта разбирать незачем.
  const fake = await fetch(`${base}/whatever/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(fake.status, 413);
  assert.equal((await fake.json()).error, 'payload_too_large');

  // На настоящем маршруте то же тело проходит разбор и упирается в подпись.
  const real = await fetch(`${base}/v1/sync/${'b'.repeat(32)}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.notEqual(real.status, 413);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
