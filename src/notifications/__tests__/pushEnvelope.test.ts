/**
 * Конверты для ретранслятора push. Ретранслятор проверяет их сам, но проверить
 * можно только то, что до него доехало в верной форме, — поэтому форма держится
 * с обеих сторон.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { peerIdFromDid, signPushPayload } from '../pushEnvelope';
import { publicKeyToDidKey } from '../../core/identity/did';
import { publicKeyToB64 } from '../../core/crypto/pubKeyFormat';
import { loadKeyPair } from '../../core/crypto/keyManager';

jest.mock('../../core/crypto/keyManager', () => ({
  loadKeyPair: jest.fn(),
}));

const mockedLoadKeyPair = loadKeyPair as jest.MockedFunction<typeof loadKeyPair>;

function makePair() {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

describe('peerIdFromDid', () => {
  it('переводит did:key в тот же base64, которым человек представляется сигналингу', () => {
    const pair = makePair();
    expect(peerIdFromDid(publicKeyToDidKey(pair.publicKey))).toBe(publicKeyToB64(pair.publicKey));
  });

  it('молчит на всём, что не did:key', () => {
    for (const raw of ['', 'did:web:example.com', 'z6Mk', null, undefined, 42, {}]) {
      expect(peerIdFromDid(raw)).toBeNull();
    }
  });
});

describe('signPushPayload', () => {
  afterEach(() => {
    mockedLoadKeyPair.mockReset();
  });

  it('подписывает нагрузку ключом личности', async () => {
    const pair = makePair();
    mockedLoadKeyPair.mockResolvedValue(pair);
    const envelope = await signPushPayload({ peerId: 'x', ts: 1 });
    expect(envelope).not.toBeNull();
    const ok = ed25519.verify(
      Buffer.from(envelope!.signature, 'base64'),
      new TextEncoder().encode(envelope!.payload),
      pair.publicKey
    );
    expect(ok).toBe(true);
  });

  it('подписывает ровно ту строку, которую отдаёт наружу', async () => {
    mockedLoadKeyPair.mockResolvedValue(makePair());
    const envelope = await signPushPayload({ b: 2, a: 1 });
    // Ретранслятор разбирает `payload` как JSON и проверяет подпись по его
    // байтам: разойдись строка с объектом — и проверка упадёт на сервере.
    expect(JSON.parse(envelope!.payload)).toEqual({ a: 1, b: 2 });
  });

  it('без ключа возвращает null, а не неподписанный конверт', async () => {
    mockedLoadKeyPair.mockResolvedValue(null);
    expect(await signPushPayload({ ts: 1 })).toBeNull();
  });
});
