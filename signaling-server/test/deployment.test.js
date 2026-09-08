'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Fly deployment trusts the proxy that supplies the real client address', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'fly.toml'), 'utf8');
  assert.match(manifest, /^app = "airchat-signaling"$/m);
  // Without this, all public traffic appears to originate at Fly's proxy and
  // shares the connection / token-registration limit.
  assert.match(manifest, /^\s*TRUST_PROXY\s*=\s*["']1["']\s*$/m);
});
