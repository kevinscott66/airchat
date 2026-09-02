/**
 * Rate-limit bucket key when the service runs behind a proxy that is not on
 * loopback (Fly.io).
 *
 * `trust proxy: 'loopback'` only covers the Nginx deployment. On Fly the
 * request reaches the machine from the fly-proxy over the internal network, so
 * loopback never matches and `req.ip` is one and the same address for every
 * client: a single busy device would spend the whole per-minute budget and
 * everyone else would get 429. Hence CLIENT_IP_HEADER.
 *
 * The opposite half — that an unnamed header is ignored — lives in
 * rate-limit-default.test.js, because the setting is read once at load.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-rl-header-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
process.env.CLIENT_IP_HEADER = 'Fly-Client-IP';
const { app } = require('./index');

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 35 requests: more than the 30-per-minute budget, so the limit must show. */
async function codes(base, ipFor) {
  const out = [];
  for (let i = 0; i < 35; i += 1) {
    const res = await fetch(`${base}/health`, { headers: { 'Fly-Client-IP': ipFor(i) } });
    out.push(res.status);
  }
  return out;
}

test('different clients get their own budget', async () => {
  await withServer(async (base) => {
    const seen = await codes(base, (i) => `198.51.100.${i}`);
    assert.equal(seen.includes(429), false);
  });
});

test('one client cannot spend more than its own budget', async () => {
  await withServer(async (base) => {
    const seen = await codes(base, () => '203.0.113.7');
    assert.equal(seen.includes(429), true);
  });
});

test('a client that sends no header falls back to the socket address', async () => {
  // Not an escape hatch: without the header every such request lands in the
  // one bucket keyed by req.ip, which is the strict case, not the loose one.
  await withServer(async (base) => {
    const out = [];
    for (let i = 0; i < 35; i += 1) out.push((await fetch(`${base}/health`)).status);
    assert.equal(out.includes(429), true);
  });
});
