import { base58btc } from 'multiformats/bases/base58';
import type { KeyPairBytes } from '../crypto/keyManager';
import { publicKeyFromB64 } from '../crypto/pubKeyFormat';

/**
 * Мультибейз-форма ключа: base58btc (префикс 'z') над multicodec 0xed 0x01.
 * Ровно то, что стоит после `did:key:` — и ровно то, чего требует
 * Ed25519VerificationKey2020 в поле publicKeyMultibase. Одно вычисление на
 * оба применения, чтобы они не могли разойтись.
 */
function ed25519Multibase(publicKey: Uint8Array): string {
  const prefix = new Uint8Array([0xed, 0x01]);
  const mh = new Uint8Array(prefix.length + publicKey.length);
  mh.set(prefix, 0);
  mh.set(publicKey, prefix.length);
  return base58btc.encode(mh);
}

/** did:key for Ed25519 public key (multicodec 0xed 0x01). */
export function publicKeyToDidKey(publicKey: Uint8Array): string {
  return `did:key:${ed25519Multibase(publicKey)}`;
}

/**
 * Строка base64 открытого ключа → did:key, либо null.
 *
 * v4.32.427. Девятнадцать мест писали это выражение вручную —
 * `publicKeyToDidKey(new Uint8Array(Buffer.from(pubB64, 'base64')))` — и ни
 * одно из них не проверяло, что получилось тридцать два байта.
 *
 * Пара функций здесь несимметрична, и в этом всё дело. `parseDidKey` отвергает
 * что угодно, кроме 34 байт полезной нагрузки, а `publicKeyToDidKey` кодирует
 * СКОЛЬКО УГОДНО байт и всегда отдаёт строку, начинающуюся с `did:key:z`.
 * Значит, испорченная строка контакта — обрезанная миграцией, пришедшая от
 * чужого клиента — превращалась во внешне правильный DID, который не примет
 * обратно ни один разборщик, включая наш собственный. Сообщение уходило по
 * адресу, которого не существует, отказа не было нигде: ни исключения, ни
 * записи в журнале, ни строки на экране.
 */
export function didFromPubB64(pubB64: unknown): string | null {
  const pk = publicKeyFromB64(pubB64);
  return pk ? publicKeyToDidKey(pk) : null;
}

/**
 * v4.32.125 (AUDIT P2): length guards против malformed/attacker DID strings.
 * Без них base58btc.decode падал / молча возвращал мусор; Ed25519 pubkey — 32 байта,
 * значит фиксированная длина всего multihash = 34 (0xed 0x01 + 32).
 * Верхний predecode-guard ставим щедрее (≤200) чтобы не тратить CPU на обход.
 */
const DID_KEY_MAX_INPUT_LEN = 200;
const DID_KEY_ED25519_PAYLOAD_LEN = 34;

export function parseDidKey(did: string): Uint8Array | null {
  try {
    if (typeof did !== 'string') return null;
    if (did.length > DID_KEY_MAX_INPUT_LEN) return null;
    if (!did.startsWith('did:key:z')) return null;
    const mb = did.slice('did:key:'.length);
    const bytes = base58btc.decode(mb);
    if (bytes.length !== DID_KEY_ED25519_PAYLOAD_LEN) return null;
    if (bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
    return bytes.slice(2);
  } catch {
    return null;
  }
}

export async function createLocalDidDocument(pair: KeyPairBytes): Promise<Record<string, unknown>> {
  const id = publicKeyToDidKey(pair.publicKey);
  return {
    '@context': 'https://www.w3.org/ns/did/v1',
    id,
    verificationMethod: [
      {
        id: `${id}#key-1`,
        type: 'Ed25519VerificationKey2020',
        controller: id,
        // v4.32.350: было `z` + base64url(ключ) — неверно вдвойне. Префикс 'z'
        // в multibase объявляет base58btc, а значение было в base64url; и сам
        // multicodec-префикс 0xed 0x01 отсутствовал. Любой сторонний
        // верификатор, декодируя это поле по объявленной базе, получал мусор.
        publicKeyMultibase: ed25519Multibase(pair.publicKey),
      },
    ],
    authentication: [`${id}#key-1`],
  };
}
