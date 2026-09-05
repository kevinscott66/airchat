const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { generateKeyPairSync, createSign, randomBytes } = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-seed-binding-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
process.env.APPLE_SIGNIN_AUDIENCES = 'app.example.airchat, app.example.other';

const { app, syncDb } = require('./index');
const {
  configuredAudiences,
  configuredProviders,
  resetJwksCache,
  seedEnvelopeError,
  verifyIdentityToken,
} = require('./seed-binding');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
const WEAK_KID = 'weak-key';
const weakJwk = { ...weak.publicKey.export({ format: 'jwk' }), kid: WEAK_KID, use: 'sig', alg: 'RS256' };

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function makeToken(claims = {}, options = {}) {
  const header = { alg: 'RS256', kid: KID, ...(options.header || {}) };
  const body = {
    iss: 'https://appleid.apple.com',
    aud: 'app.example.airchat',
    sub: '000123.abcdef.0001',
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  };
  const signedInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signer = createSign('sha256');
  signer.update(signedInput);
  const signature = signer.sign(options.key || privateKey).toString('base64url');
  return `${signedInput}.${options.signature || signature}`;
}

function jwksFetch(keys = [jwk]) {
  return async () => ({ ok: true, json: async () => ({ keys }) });
}

function envelope(overrides = {}) {
  return {
    v: 1,
    saltB64: Buffer.alloc(16, 3).toString('base64'),
    iters: 600_000,
    dataB64: Buffer.alloc(80, 9).toString('base64'),
    savedAt: Date.now(),
    ...overrides,
  };
}

test('audiences and providers come from the environment', () => {
  assert.deepEqual(configuredAudiences('apple'), ['app.example.airchat', 'app.example.other']);
  assert.deepEqual(configuredAudiences('google', {}), []);
  assert.deepEqual(configuredProviders({ APPLE_SIGNIN_AUDIENCES: 'a' }), ['apple']);
  assert.deepEqual(configuredProviders({}), []);
});

test('a provider without audiences is refused, not trusted blindly', async () => {
  const verdict = await verifyIdentityToken('google', makeToken(), { env: {}, fetch: jwksFetch() });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'provider_not_configured');
});

test('a well formed token is accepted and yields the subject', async () => {
  resetJwksCache();
  const verdict = await verifyIdentityToken('apple', makeToken(), { fetch: jwksFetch() });
  assert.deepEqual(verdict, { ok: true, provider: 'apple', sub: '000123.abcdef.0001' });
});

test('a tampered signature is refused', async () => {
  resetJwksCache();
  const token = makeToken();
  const parts = token.split('.');
  const flipped = Buffer.from(parts[2], 'base64url');
  flipped[0] ^= 0xff;
  const verdict = await verifyIdentityToken(
    'apple',
    `${parts[0]}.${parts[1]}.${flipped.toString('base64url')}`,
    { fetch: jwksFetch() },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bad_signature');
});

test('a token signed by a stranger key is refused', async () => {
  resetJwksCache();
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verdict = await verifyIdentityToken('apple', makeToken({}, { key: other.privateKey }), {
    fetch: jwksFetch(),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bad_signature');
});

test('issuer, audience, expiry and subject are all checked', async () => {
  resetJwksCache();
  const cases = [
    [{ iss: 'https://evil.example' }, 'bad_issuer'],
    [{ aud: 'app.someone.else' }, 'bad_audience'],
    [{ exp: Math.floor(Date.now() / 1000) - 3600 }, 'expired'],
    [{ iat: Math.floor(Date.now() / 1000) + 3600 }, 'not_yet_valid'],
    [{ sub: '' }, 'invalid_subject'],
  ];
  for (const [claims, reason] of cases) {
    const verdict = await verifyIdentityToken('apple', makeToken(claims), { fetch: jwksFetch() });
    assert.equal(verdict.ok, false, `expected refusal for ${reason}`);
    assert.equal(verdict.reason, reason);
  }
});

test('alg none and HMAC tokens are refused before any key lookup', async () => {
  resetJwksCache();
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
  for (const alg of ['none', 'HS256', 'RS512']) {
    const verdict = await verifyIdentityToken('apple', makeToken({}, { header: { alg } }), { fetch: spy });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'unsupported_alg');
  }
  assert.equal(called, false);
});

test('a short RSA key is refused even when the signature checks out', async () => {
  resetJwksCache();
  const token = makeToken({}, { header: { kid: WEAK_KID }, key: weak.privateKey });
  const verdict = await verifyIdentityToken('apple', token, { fetch: jwksFetch([weakJwk]) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'weak_key');
});

test('an unreachable JWKS is reported as unavailable, not as a bad token', async () => {
  resetJwksCache();
  const verdict = await verifyIdentityToken('apple', makeToken(), {
    fetch: async () => { throw new Error('offline'); },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'jwks_unavailable');
});

test('the envelope must be a small, well shaped, honestly derived blob', () => {
  assert.equal(seedEnvelopeError(envelope()), null);
  assert.equal(seedEnvelopeError(null), 'invalid_envelope');
  assert.equal(seedEnvelopeError(envelope({ v: 2 })), 'invalid_envelope_version');
  assert.equal(seedEnvelopeError(envelope({ saltB64: Buffer.alloc(8).toString('base64') })), 'invalid_salt');
  assert.equal(seedEnvelopeError(envelope({ iters: 1000 })), 'invalid_iters');
  assert.equal(seedEnvelopeError(envelope({ iters: 9_000_000 })), 'invalid_iters');
  assert.equal(seedEnvelopeError(envelope({ dataB64: Buffer.alloc(4096).toString('base64') })), 'invalid_data');
  assert.equal(seedEnvelopeError(envelope({ savedAt: Date.now() + 60 * 60 * 1000 })), 'invalid_saved_at');
  assert.equal(seedEnvelopeError({ ...envelope(), extra: 1 }), 'unexpected_field');
});

test('the blind index separates providers and subjects', () => {
  const a = syncDb.seedBindingKey('apple', 'sub-1');
  assert.notEqual(a, syncDb.seedBindingKey('google', 'sub-1'));
  assert.notEqual(a, syncDb.seedBindingKey('apple', 'sub-2'));
  assert.equal(a, syncDb.seedBindingKey('apple', 'sub-1'));
  assert.equal(a.includes('sub-1'), false);
});

test('the HTTP surface stores, returns and drops a binding', async (t) => {
  resetJwksCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://appleid.apple.com/')) {
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    }
    return realFetch(url, init);
  };
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => realFetch(`${base}/v1/seed-binding/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const providers = await (await realFetch(`${base}/v1/seed-binding/providers`)).json();
  assert.deepEqual(providers, { providers: ['apple'] });

  const sub = `000999.${randomBytes(6).toString('hex')}.0001`;
  const idToken = makeToken({ sub });
  const stored = envelope();

  const missing = await post('get', { provider: 'apple', idToken });
  assert.equal(missing.status, 404);

  const put = await post('put', { provider: 'apple', idToken, envelope: stored });
  assert.equal(put.status, 200);

  const got = await post('get', { provider: 'apple', idToken });
  assert.equal(got.status, 200);
  assert.deepEqual((await got.json()).envelope, stored);

  // Другой Apple ID не видит чужой конверт.
  const strangerToken = makeToken({ sub: `000999.${randomBytes(6).toString('hex')}.0002` });
  const stranger = await post('get', { provider: 'apple', idToken: strangerToken });
  assert.equal(stranger.status, 404);

  const forged = await post('get', { provider: 'apple', idToken: `${idToken}x` });
  assert.equal(forged.status, 401);
  assert.deepEqual(await forged.json(), { error: 'identity_rejected' });

  const badEnvelope = await post('put', { provider: 'apple', idToken, envelope: envelope({ iters: 10 }) });
  assert.equal(badEnvelope.status, 400);

  const unknown = await post('get', { provider: 'facebook', idToken });
  assert.equal(unknown.status, 400);

  const offProvider = await post('get', { provider: 'google', idToken });
  assert.equal(offProvider.status, 503);

  const dropped = await post('delete', { provider: 'apple', idToken });
  assert.equal(dropped.status, 200);
  assert.deepEqual(await dropped.json(), { ok: true });
  assert.equal((await post('get', { provider: 'apple', idToken })).status, 404);
});
