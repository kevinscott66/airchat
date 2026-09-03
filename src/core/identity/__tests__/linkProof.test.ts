/**
 * Привязка внешнего профиля — это единственное место, где приложение говорит
 * «это точно он» про учётную запись за своими пределами. Проверяется ровно то,
 * ради чего заведено доказательство вместо поля ввода: чужую публикацию нельзя
 * выдать за свою, свою нельзя выдать за чужое имя, а правленую строку не
 * принимают вовсе.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import type { KeyPairBytes } from '../../crypto/keyManager';
import { signBytes, signJson } from '../../crypto/signature';
import {
  decodeProofToken,
  encodeLinkProofRecord,
  encodeProofToken,
  encodeProofTokenV2,
  linkState,
  proofBodyFor,
  proofFailureText,
  readLinkProofRecord,
  findProofTokens,
  normalizeHandle,
  profileUrl,
  proofStatementText,
  sameHandle,
  verifyProofInText,
  verifyProofToken,
  type ProofFailure,
  type LinkPlatform,
  type ProofExpectation,
} from '../linkProof';

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

/** То же доказательство в формате v2 — том, что публикуют начиная с 4.32.575. */
async function proofV2For(
  k: KeyPairBytes,
  platform: LinkPlatform,
  handle: string,
  now = 1_700_000_000_000
): Promise<string> {
  const built = proofBodyFor(platform, handle, pubB64(k), now);
  if (!built) throw new Error('тело токена не собралось');
  const sig = await signBytes(k.secretKey, new TextEncoder().encode(built.body));
  return encodeProofTokenV2(built.body, Buffer.from(sig).toString('base64'));
}

/**
 * Длина записи так, как её считает X: символы, а не байты. Кириллица и латиница
 * весят по единице, поэтому обычный length здесь честен.
 */
const X_LIMIT = 280;

describe('имя учётной записи', () => {
  it('принимается и с собакой, и без неё, и целым адресом', () => {
    expect(normalizeHandle('github', 'octocat')).toBe('octocat');
    expect(normalizeHandle('github', ' @octocat ')).toBe('octocat');
    expect(normalizeHandle('github', 'https://github.com/octocat')).toBe('octocat');
    expect(normalizeHandle('x', 'https://x.com/jack?lang=ru')).toBe('jack');
    expect(normalizeHandle('x', 'twitter.com/jack/')).toBe('jack');
  });

  it('регистр сохраняется в показе и не учитывается в сверке', () => {
    expect(normalizeHandle('github', 'OctoCat')).toBe('OctoCat');
    expect(sameHandle('OctoCat', 'octocat')).toBe(true);
  });

  it('адрес чужого хоста именем не считается: иначе профиль уводит куда угодно', () => {
    expect(normalizeHandle('github', 'https://evil.example/octocat')).toBeNull();
    expect(normalizeHandle('x', 'https://github.com/jack')).toBeNull();
  });

  it('обход по пути не проходит — на этом строится адрес профиля', () => {
    expect(normalizeHandle('github', 'foo/../../evil')).toBeNull();
    expect(normalizeHandle('x', 'jack/status/1')).toBeNull();
    expect(normalizeHandle('github', 'a'.repeat(40))).toBeNull();
    expect(normalizeHandle('x', 'a'.repeat(16))).toBeNull();
    expect(normalizeHandle('github', '-octocat')).toBeNull();
  });

  it('адрес профиля собирается только из принятого имени', () => {
    expect(profileUrl('github', '@octocat')).toBe('https://github.com/octocat');
    expect(profileUrl('x', 'jack')).toBe('https://x.com/jack');
    expect(profileUrl('x', 'no spaces')).toBeNull();
  });
});

describe('токен доказательства', () => {
  it('свой токен проверяется своим ключом', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'octocat');
    await expect(verifyProofToken(token, expectFor(k, 'github', 'octocat'))).resolves.toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('регистр имени в токене не мешает: это одна учётная запись', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'OctoCat');
    await expect(verifyProofToken(token, expectFor(k, 'github', 'octocat'))).resolves.toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('чужое доказательство не становится своим от того, что его скопировали', async () => {
    const mine = keys();
    const other = keys();
    const token = await proofFor(other, 'github', 'octocat');
    await expect(verifyProofToken(token, expectFor(mine, 'github', 'octocat'))).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('своим доказательством нельзя подтвердить чужое имя', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'octocat');
    await expect(verifyProofToken(token, expectFor(k, 'github', 'torvalds'))).resolves.toEqual({
      ok: false,
      reason: 'wrong_handle',
    });
  });

  it('доказательство одной площадки не годится другой', async () => {
    const k = keys();
    const token = await proofFor(k, 'x', 'jack');
    await expect(verifyProofToken(token, expectFor(k, 'github', 'jack'))).resolves.toEqual({
      ok: false,
      reason: 'wrong_handle',
    });
  });

  it('правленая строка не принимается', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'octocat');
    const broken = token.slice(0, -4) + 'AAAA';
    const res = await verifyProofToken(broken, expectFor(k, 'github', 'octocat'));
    expect(res.ok).toBe(false);
  });

  it('мусор вместо токена — не крушение, а отказ', async () => {
    const k = keys();
    expect(decodeProofToken('airchat-proof:v1:@@@.###')).toBeNull();
    expect(decodeProofToken(42)).toBeNull();
    await expect(verifyProofToken('ничего', expectFor(k, 'github', 'octocat'))).resolves.toEqual({
      ok: false,
      reason: 'bad_token',
    });
  });
});

describe('строка в чужом тексте', () => {
  it('находится среди разметки и лишних слов', async () => {
    const k = keys();
    const token = await proofFor(k, 'x', 'jack');
    const html = `<blockquote><p>Привет! ${token}</p></blockquote>`;
    expect(findProofTokens(html)).toEqual([token]);
    await expect(verifyProofInText(html, expectFor(k, 'x', 'jack'))).resolves.toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('когда строки нет — так и говорится, а не «подпись не сходится»', async () => {
    const k = keys();
    await expect(verifyProofInText('обычная запись', expectFor(k, 'x', 'jack'))).resolves.toEqual({
      ok: false,
      reason: 'no_token',
    });
  });

  it('несколько строк подряд: годится любая своя', async () => {
    const k = keys();
    const other = await proofFor(keys(), 'x', 'jack');
    const mine = await proofFor(k, 'x', 'jack');
    await expect(verifyProofInText(`${other}\n${mine}`, expectFor(k, 'x', 'jack'))).resolves.toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('огромный текст не разбирается целиком', async () => {
    const k = keys();
    const token = await proofFor(k, 'x', 'jack');
    const huge = 'x'.repeat(300 * 1024) + token;
    expect(findProofTokens(huge)).toEqual([]);
  });
});

describe('текст публикации', () => {
  it('человек видит, чей это аккаунт, не читая base64', async () => {
    const k = keys();
    const token = await proofFor(k, 'github', 'octocat');
    const text = proofStatementText(token, 'AC-ABCDE-FGHIJ', 'github');
    expect(text).toContain('AC-ABCDE-FGHIJ');
    expect(text).toContain('GitHub');
    expect(findProofTokens(text)).toEqual([token]);
  });
});

describe('запись о подтверждении', () => {
  it('переживает круг «записали — прочитали»', () => {
    const rec = { url: 'https://gist.github.com/kevinscott66/abc', verifiedAt: 1_700_000_000_000 };
    expect(readLinkProofRecord(encodeLinkProofRecord(rec))).toEqual(rec);
  });

  it('не принимает мусор вместо записи', () => {
    expect(readLinkProofRecord('')).toBeNull();
    expect(readLinkProofRecord('не json')).toBeNull();
    expect(readLinkProofRecord('{}')).toBeNull();
    expect(readLinkProofRecord('{"url":"","verifiedAt":1}')).toBeNull();
    expect(readLinkProofRecord('{"url":"https://x","verifiedAt":0}')).toBeNull();
    expect(readLinkProofRecord('{"url":"https://x"}')).toBeNull();
    expect(readLinkProofRecord(null)).toBeNull();
  });

  it('различает «нет имени», «заявлено» и «подтверждено»', () => {
    const rec = { url: 'https://x.com/a/status/1', verifiedAt: 1 };
    expect(linkState('', rec)).toBe('empty');
    expect(linkState('   ', rec)).toBe('empty');
    expect(linkState('kevin', null)).toBe('claimed');
    expect(linkState('kevin', rec)).toBe('verified');
  });
});

describe('текст отказа', () => {
  const ALL: ProofFailure[] = [
    'no_token', 'bad_token', 'bad_signature', 'wrong_account',
    'wrong_handle', 'owner_mismatch', 'network', 'not_found', 'bad_url',
  ];

  it('на каждую причину даёт свою фразу', () => {
    const texts = ALL.map((r) => proofFailureText(r, 'github'));
    expect(new Set(texts).size).toBe(ALL.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(10);
  });

  it('не отвечает «не сходится» там, где площадка просто молчит', () => {
    // Это разные новости: одна ведёт «попробуйте позже», другая — «так
    // подтверждения не будет». Слить их в одно «ошибка» нельзя.
    expect(proofFailureText('network', 'x')).toMatch(/не ответил/);
    expect(proofFailureText('owner_mismatch', 'x')).toMatch(/другому аккаунту/);
  });

  it('подсказывает адрес той площадки, о которой речь', () => {
    expect(proofFailureText('bad_url', 'github')).toMatch(/gist\.github\.com/);
    expect(proofFailureText('bad_url', 'x')).toMatch(/x\.com/);
  });
});

describe('формат v2: то же доказательство, но помещается в запись X', () => {
  it('строка подтверждения влезает в 280 символов', async () => {
    const k = keys();
    // Самое длинное имя, какое X вообще выдаёт, — 15 символов.
    const token = await proofV2For(k, 'x', 'a_very_long_han');
    const text = proofStatementText(token, 'AC-ABCDE-FGHIJ', 'x');
    expect(text.length).toBeLessThanOrEqual(X_LIMIT);
    // Ради этого всё и затевалось: старый формат не влезал.
    const old = proofStatementText(await proofFor(k, 'x', 'a_very_long_han'), 'AC-ABCDE-FGHIJ', 'x');
    expect(old.length).toBeGreaterThan(X_LIMIT);
  });

  it('проверяется так же, как v1', async () => {
    const k = keys();
    const token = await proofV2For(k, 'x', 'jack');
    await expect(verifyProofToken(token, expectFor(k, 'x', 'jack'))).resolves.toMatchObject({
      ok: true,
      payload: { v: 2, p: 'x', h: 'jack' },
    });
  });

  it('чужой ключ и чужое имя не проходят', async () => {
    const k = keys();
    const token = await proofV2For(k, 'x', 'jack');
    await expect(verifyProofToken(token, expectFor(keys(), 'x', 'jack'))).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    await expect(verifyProofToken(token, expectFor(k, 'x', 'other'))).resolves.toEqual({
      ok: false,
      reason: 'wrong_handle',
    });
    await expect(verifyProofToken(token, expectFor(k, 'github', 'jack'))).resolves.toEqual({
      ok: false,
      reason: 'wrong_handle',
    });
  });

  it('правка внутри строки ломает подпись — имя подписано вместе со всем', async () => {
    const k = keys();
    const token = await proofV2For(k, 'x', 'jack');
    const swapped = token.replace(':jack:', ':mallory:');
    expect(swapped).not.toBe(token);
    await expect(verifyProofToken(swapped, expectFor(k, 'x', 'mallory'))).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('обрезанная строка — это «повреждено», а не «подпись не сошлась»', async () => {
    const k = keys();
    const token = await proofV2For(k, 'x', 'jack');
    await expect(verifyProofToken(token.slice(0, 60), expectFor(k, 'x', 'jack'))).resolves.toEqual({
      ok: false,
      reason: 'bad_token',
    });
  });

  it('старые публикации продолжают проверяться', async () => {
    const k = keys();
    const v1 = await proofFor(k, 'github', 'octocat');
    await expect(verifyProofToken(v1, expectFor(k, 'github', 'octocat'))).resolves.toMatchObject({
      ok: true,
      payload: { v: 1, h: 'octocat' },
    });
  });

  it('в тексте публикации находятся строки обоих форматов', async () => {
    const k = keys();
    const v1 = await proofFor(k, 'x', 'jack');
    const v2 = await proofV2For(k, 'x', 'jack');
    expect(findProofTokens(`было: ${v1}\nстало: ${v2}`)).toEqual([v1, v2]);
    await expect(verifyProofInText(`шум ${v2} шум`, expectFor(k, 'x', 'jack'))).resolves.toMatchObject({
      ok: true,
    });
  });

  it('время в строке — минуты, и восстанавливается обратно', () => {
    const k = keys();
    const built = proofBodyFor('x', 'jack', pubB64(k), 1_700_000_045_678);
    expect(built?.payload.t).toBe(Math.floor(1_700_000_045_678 / 60_000) * 60_000);
    expect(built?.body.startsWith('airchat-proof:v2:x:jack:')).toBe(true);
  });

  it('негодное имя строкой не становится', () => {
    expect(proofBodyFor('github', 'foo/../evil', 'AAAA', 1_700_000_000_000)).toBeNull();
    const k = keys();
    expect(proofBodyFor('x', 'слишкомдлинноеимя', pubB64(k), 1_700_000_000_000)).toBeNull();
  });
});
