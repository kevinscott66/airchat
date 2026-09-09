'use strict';

/*
 * Deployment files are part of the production interface: an incorrect path
 * quietly makes the weekly GeoIP refresh write a file the vault never reads.
 * Keep the service and timer input tied to the paths declared by the vault
 * systemd unit, without embedding any production-only values in the test.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const deployDir = path.join(__dirname, 'deploy');
const vaultService = fs.readFileSync(path.join(deployDir, 'airchat-cloud-vault.service'), 'utf8');
const geoipService = fs.readFileSync(path.join(deployDir, 'airchat-geoip-refresh.service'), 'utf8');

function value(unit, key) {
  const match = unit.match(new RegExp(`^${key}=(.+)$`, 'm'));
  assert.ok(match, `missing ${key}`);
  return match[1];
}

test('GeoIP refresh uses the cloud-vault runtime and data directory', () => {
  const dataDir = value(vaultService, 'Environment=CLOUD_VAULT_DIR');
  const vaultStart = value(vaultService, 'ExecStart');
  const geoipStart = value(geoipService, 'ExecStart');

  assert.match(geoipService, new RegExp(`^Environment=CLOUD_VAULT_DIR=${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(geoipService, new RegExp(`^ReadWritePaths=${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(geoipStart, /^\/opt\/node-v22\.14\.0-linux-x64\/bin\/node /);
  assert.match(vaultStart, /^\/opt\/node-v22\.14\.0-linux-x64\/bin\/node /);
  assert.match(geoipStart, /\/tools\/build-geoip\.js$/);
});
