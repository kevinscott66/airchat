const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const test = require('node:test');
const express = require('express');
const { bodyLimitFor, createBodyParser } = require('./body-parser');

const limits = { defaultBytes: 64, vaultBytes: 1024, syncPushBytes: 1024, mediaBytes: 512, publicPostBytes: 256 };
const largePath = '/v1/sync/test/push';

test('route budgets apply only to permitted methods and paths', () => {
  for (const [method, path, expected] of [
    ['PUT', '/v1/cloud-vault/test', 1024], ['POST', largePath, 1024],
    ['POST', '/v1/sync/test/media/put', 512], ['POST', '/v1/post/test/delete', 256],
    ['POST', '/whatever/push', 64], ['GET', largePath, 64],
    ['POST', '/v1/sync/test/extra/push', 64],
  ]) assert.equal(bodyLimitFor({ method, path }, limits), expected);
});

async function fixture(t) {
  const app = express();
  app.use(createBodyParser(limits));
  let held;
  let reached;
  let closed;
  const closure = new Promise((resolve) => { closed = resolve; });
  const arrival = new Promise((resolve) => { reached = resolve; });
  app.post(largePath, (req, res) => {
    if (req.headers['x-hold']) { held = res; res.once('close', closed); reached(); }
    else res.json({ ok: true });
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  let parserError;
  app.use((error, req, res, _next) => {
    if (req.headers['x-hold-error']) { parserError = res; reached(); }
    else res.status(error.status || 500).end();
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, arrival, closure, finish: () => held.end(), errorFinish: () => parserError.status(400).end() };
}

function send(base, { headers = {}, body = '{}', chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + largePath, { method: 'POST', headers: {
      'content-type': 'application/json',
      ...(chunked ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers,
    } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, retry: res.headers['retry-after'] }));
    });
    req.on('error', reject);
    if (chunked) req.write(body);
    req.end(chunked ? undefined : body);
  });
}

for (const encoding of ['small', 'chunked', 'gzip']) {
  test(`${encoding} large-route body reserves a slot despite small or absent length`, async (t) => {
    const f = await fixture(t);
    const headers = { 'x-hold': '1' };
    let body = '{}';
    if (encoding === 'gzip') {
      headers['content-encoding'] = 'gzip';
      body = gzipSync(JSON.stringify({ pad: 'x'.repeat(128) }));
      assert.ok(body.length < limits.defaultBytes);
    }
    const pending = send(f.base, { body, headers, chunked: encoding === 'chunked' });
    await f.arrival;
    assert.deepEqual(await send(f.base), { status: 503, retry: '5' });
    assert.equal((await fetch(f.base + '/health')).status, 200);
    f.finish();
    assert.equal((await pending).status, 200);
    assert.equal((await send(f.base)).status, 200);
  });
}

test('parser error frees admission before the error response finishes', async (t) => {
  const f = await fixture(t);
  const pending = send(f.base, { body: '{', headers: { 'x-hold-error': '1' } });
  await f.arrival;
  assert.equal((await send(f.base)).status, 200);
  f.errorFinish();
  assert.equal((await pending).status, 400);
  assert.equal((await send(f.base)).status, 200);
});

test('compressed decoded size is enforced and admission is recovered', async (t) => {
  const f = await fixture(t);
  const body = gzipSync(JSON.stringify({ pad: 'x'.repeat(2048) }));
  assert.equal((await send(f.base, { body, headers: { 'content-encoding': 'gzip' } })).status, 413);
  assert.equal((await send(f.base)).status, 200);
});

test('disconnected response frees admission', async (t) => {
  const f = await fixture(t);
  const req = http.request(f.base + largePath, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-hold': '1',
  } });
  req.on('error', () => {});
  req.end('{}');
  await f.arrival;
  req.destroy();
  await f.closure;
  assert.equal((await send(f.base)).status, 200);
});
