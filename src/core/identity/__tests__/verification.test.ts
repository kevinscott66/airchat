import { ed25519 } from '@noble/curves/ed25519.js';
import type { KeyPairBytes } from '../../crypto/keyManager';
import { signJson } from '../../crypto/signature';
import { publicKeyToDidKey } from '../did';
import { badgeFor, encodeGrant, readGrant, MAX_GRANT_LEN } from '../verification';

// v4.32.547: галочка — единственное место, где приложение верит бумаге, а не
// арифметике. Проверяется здесь ровно то, ради чего бумага заведена вместо
// поля `verified: true` в конверте профиля: подделать её нельзя, предъявить
// чужую нельзя, и переименовавшийся аккаунт её теряет.
//
// Подписать настоящим ключом тест не может — закрытая половина в репозитории
// не лежит. Поэтому модуль с корнем доверия подменяется целиком; всё
// остальное — настоящее, включая канонизацию и проверку подписи.
const mockVerifierKeys: string[] = [];
jest.mock('../officialKeys', () => ({
  get OFFICIAL_VERIFIER_KEYS(): readonly string[] {
    return mockVerifierKeys;
  },
}));

function keys(): KeyPairBytes {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

/** Аккаунт, которому выдают бумагу: DID у него настоящий, из ключа. */
function account(): { did: string } {
  return { did: publicKeyToDidKey(keys().publicKey) };
}

let issuer: KeyPairBytes;

async function grantFor(
  did: string,
  username: string,
  signer: KeyPairBytes = issuer
): Promise<string> {
  return encodeGrant(
    await signJson(signer, { v: 1, kind: 'official', did, username, issuedAt: 1_700_000_000_000 })
  );
}

beforeEach(() => {
  issuer = keys();
  mockVerifierKeys.length = 0;
  mockVerifierKeys.push(b64(issuer.publicKey));
});

describe('readGrant', () => {
  it('бумага, выданная этому аккаунту, читается', async () => {
    const me = account();
    const claim = await readGrant(await grantFor(me.did, 'founder'), me.did);
    expect(claim).toEqual({ badge: 'official', username: 'founder', issuedAt: 1_700_000_000_000 });
  });

  it('чужую бумагу предъявить нельзя', async () => {
    // Конверты профиля ходят открытым текстом внутри переписки: получатель
    // официального аккаунта видит его бумагу целиком. Привязка к DID — ровно
    // то, что мешает переслать её как свою.
    const owner = account();
    const thief = account();
    const paper = await grantFor(owner.did, 'founder');

    expect(await readGrant(paper, owner.did)).not.toBeNull();
    expect(await readGrant(paper, thief.did)).toBeNull();
  });

  it('подпись чужим ключом не считается', async () => {
    const me = account();
    const outsider = keys();
    expect(await readGrant(await grantFor(me.did, 'founder', outsider), me.did)).toBeNull();
  });

  it('правка нагрузки ломает подпись', async () => {
    const me = account();
    const paper = JSON.parse(await grantFor(me.did, 'support')) as {
      payload: string;
      signature: string;
    };
    const tampered = encodeGrant({
      payload: paper.payload.replace('support', 'founder'),
      signature: paper.signature,
    });
    expect(await readGrant(tampered, me.did)).toBeNull();
  });

  it('неизвестная версия нагрузки отвергается', async () => {
    const me = account();
    const paper = encodeGrant(
      await signJson(issuer, { v: 2, kind: 'official', did: me.did, username: 'founder' })
    );
    expect(await readGrant(paper, me.did)).toBeNull();
  });

  it('мусор, пустота и слишком длинная строка не роняют разбор', async () => {
    const me = account();
    for (const raw of [null, undefined, 42, '', '   ', '{', '{"payload":1}', 'x'.repeat(MAX_GRANT_LEN + 1)]) {
      expect(await readGrant(raw, me.did)).toBeNull();
    }
  });

  it('без DID предъявителя галочки нет', async () => {
    const me = account();
    const paper = await grantFor(me.did, 'founder');
    expect(await readGrant(paper, null)).toBeNull();
    expect(await readGrant(paper, '')).toBeNull();
  });
});

describe('badgeFor', () => {
  it('галочка видна рядом с тем именем, на которое выдана', async () => {
    const me = account();
    const paper = await grantFor(me.did, 'founder');
    expect(await badgeFor(paper, me.did, 'founder')).toBe('official');
    expect(await badgeFor(paper, me.did, '@Founder')).toBe('official');
  });

  it('переименовавшийся аккаунт галочку теряет', async () => {
    const me = account();
    const paper = await grantFor(me.did, 'founder');
    expect(await badgeFor(paper, me.did, 'someone_else')).toBeNull();
  });

  it('без имени галочки нет', async () => {
    const me = account();
    const paper = await grantFor(me.did, 'founder');
    expect(await badgeFor(paper, me.did, null)).toBeNull();
  });
});
