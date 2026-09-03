/**
 * Здесь проверяется вторая половина: кто автор публикации. Подпись своя у всех
 * этих случаев, и именно поэтому одной её мало — тесты ниже об этом.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import type { KeyPairBytes } from '../../crypto/keyManager';
import { signJson } from '../../crypto/signature';
import { encodeProofToken, type LinkPlatform, type ProofExpectation } from '../linkProof';
import { checkGithubGist, checkLinkProof, checkXPost, parseGistId, parseTweetUrl, type FetchLike } from '../linkProofCheck';

function keys(): KeyPairBytes {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}
const pubB64 = (k: KeyPairBytes): string => Buffer.from(k.publicKey).toString('base64');

async function proofFor(k: KeyPairBytes, platform: LinkPlatform, handle: string): Promise<string> {
  const signed = await signJson(k, { v: 1, p: platform, h: handle, k: pubB64(k), t: 1_700_000_000_000 });
  return encodeProofToken(signed.payload, signed.signature);
}
const expectFor = (k: KeyPairBytes, platform: LinkPlatform, handle: string): ProofExpectation =>
  ({ platform, handle, publicKeyB64: pubB64(k) });

/** Площадка, отвечающая заранее оговорённым телом. */
function reply(status: number, body: unknown): FetchLike {
  return async () => ({ ok: status === 200, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
}
const dead: FetchLike = async () => { throw new Error('сеть недоступна'); };

const GIST = 'https://gist.github.com/octocat/aa11bb22cc33dd44ee55ff6677889900';
const TWEET = 'https://x.com/jack/status/20';

describe('разбор адресов', () => {
  it('gist узнаётся с именем автора в пути и без него', () => {
    expect(parseGistId(GIST)).toBe('aa11bb22cc33dd44ee55ff6677889900');
    expect(parseGistId('gist.github.com/aa11bb22cc33dd44ee55ff6677889900')).toBe('aa11bb22cc33dd44ee55ff6677889900');
    expect(parseGistId('https://github.com/octocat')).toBeNull();
    expect(parseGistId('https://gist.github.com/octocat/../evil')).toBeNull();
  });

  it('запись X узнаётся на обоих доменах', () => {
    expect(parseTweetUrl(TWEET)).toEqual({ handle: 'jack', id: '20' });
    expect(parseTweetUrl('https://twitter.com/jack/statuses/20')).toEqual({ handle: 'jack', id: '20' });
    expect(parseTweetUrl('https://x.com/jack')).toBeNull();
  });
});

describe('gist', () => {
  it('свой gist со своей строкой — привязка подтверждена', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'octocat');
    const res = await checkGithubGist(GIST, expectFor(k, 'github', 'octocat'), {
      fetch: reply(200, { owner: { login: 'octocat' }, files: { 'airchat.md': { content: token } } }),
    });
    expect(res.ok).toBe(true);
  });

  it('чужой gist со СВОЕЙ строкой не подтверждает ничего — ради этого и сверка автора', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'octocat');
    const res = await checkGithubGist(GIST, expectFor(k, 'github', 'octocat'), {
      fetch: reply(200, { owner: { login: 'somebody-else' }, files: { 'a.md': { content: token } } }),
    });
    expect(res).toEqual({ ok: false, reason: 'owner_mismatch' });
  });

  it('свой gist без строки — «строки нет», а не «не ваш gist»', async () => {
    const k = keys();
    const res = await checkGithubGist(GIST, expectFor(k, 'github', 'octocat'), {
      fetch: reply(200, { owner: { login: 'octocat' }, files: { 'a.md': { content: 'привет' } } }),
    });
    expect(res).toEqual({ ok: false, reason: 'no_token' });
  });

  it('строка ищется во всех файлах и в описании', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'octocat');
    const res = await checkGithubGist(GIST, expectFor(k, 'github', 'octocat'), {
      fetch: reply(200, { owner: { login: 'octocat' }, description: token, files: { 'a.md': { content: 'пусто' } } }),
    });
    expect(res.ok).toBe(true);
  });

  it('удалённый или приватный gist — «не найдено»', async () => {
    const k = keys();
    const res = await checkGithubGist(GIST, expectFor(k, 'github', 'octocat'), { fetch: reply(404, {}) });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('площадка молчит — «не смогли проверить», а не «не сходится»', async () => {
    const k = keys();
    await expect(checkGithubGist(GIST, expectFor(k, 'github', 'octocat'), { fetch: dead }))
      .resolves.toEqual({ ok: false, reason: 'network' });
    await expect(checkGithubGist(GIST, expectFor(k, 'github', 'octocat'), { fetch: reply(500, {}) }))
      .resolves.toEqual({ ok: false, reason: 'network' });
    await expect(checkGithubGist(GIST, expectFor(k, 'github', 'octocat'), { fetch: reply(200, 'не json') }))
      .resolves.toEqual({ ok: false, reason: 'network' });
  });

  it('не тот адрес — говорится про адрес', async () => {
    const k = keys();
    await expect(checkGithubGist('https://github.com/octocat', expectFor(k, 'github', 'octocat'), { fetch: reply(200, {}) }))
      .resolves.toEqual({ ok: false, reason: 'bad_url' });
  });
});

describe('запись X', () => {
  it('своя запись со своей строкой — привязка подтверждена', async () => {
    const k = keys();
    const token = await proofFor(k, 'x', 'jack');
    const res = await checkXPost(TWEET, expectFor(k, 'x', 'jack'), {
      fetch: reply(200, { author_url: 'https://twitter.com/jack', html: `<blockquote>${token}</blockquote>` }),
    });
    expect(res.ok).toBe(true);
  });

  it('автор берётся из ответа площадки, а не из вставленного адреса', async () => {
    const k = keys();
    const token = await proofFor(k, 'x', 'jack');
    // Адрес говорит «jack», площадка отвечает «impostor» — верить надо площадке.
    const res = await checkXPost(TWEET, expectFor(k, 'x', 'jack'), {
      fetch: reply(200, { author_url: 'https://twitter.com/impostor', html: token }),
    });
    expect(res).toEqual({ ok: false, reason: 'owner_mismatch' });
  });

  it('oembed не ответил — «не смогли проверить»', async () => {
    const k = keys();
    await expect(checkXPost(TWEET, expectFor(k, 'x', 'jack'), { fetch: dead }))
      .resolves.toEqual({ ok: false, reason: 'network' });
  });
});

describe('одна дверь', () => {
  it('площадку выбирает ожидание, а не вызывающий', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'octocat');
    const res = await checkLinkProof(GIST, expectFor(k, 'github', 'octocat'), {
      fetch: reply(200, { owner: { login: 'octocat' }, files: { 'a.md': { content: token } } }),
    });
    expect(res.ok).toBe(true);
    await expect(checkLinkProof(GIST, expectFor(k, 'x', 'jack'), { fetch: reply(200, {}) }))
      .resolves.toEqual({ ok: false, reason: 'bad_url' });
  });
});
