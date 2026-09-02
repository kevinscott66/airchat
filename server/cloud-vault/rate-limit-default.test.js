/**
 * Default: no header is trusted.
 *
 * This is the half that matters for the Nginx deployment. Nothing there strips
 * an inbound `Fly-Client-IP`, so if the service trusted such a header without
 * being told to, a client would mint a fresh rate-limit bucket per request by
 * changing one string — that is, there would be no rate limit at all.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-rl-default-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
delete process.env.CLIENT_IP_HEADER;
const { app } = require('./index');

test('a made-up client address in a header does not create a new budget', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const seen = [];
    for (let i = 0; i < 35; i += 1) {
      const res = await fetch(`${base}/health`, {
        headers: { 'Fly-Client-IP': `198.51.100.${i}`, 'X-Real-IP': `198.51.100.${i}` },
      });
      seen.push(res.status);
    }
    assert.equal(seen.includes(429), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
