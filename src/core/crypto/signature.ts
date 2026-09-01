import { ed25519 } from '@noble/curves/ed25519.js';
import { log } from '../logger';
import type { KeyPairBytes } from './keyManager';
import { ED25519_SIGNATURE_BYTES, isEd25519PublicKey } from './pubKeyFormat';

export async function signBytes(secretKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  return ed25519.sign(message, secretKey);
}

export async function verifyBytes(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch (e) {
    log.warn('verify_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function signJson(
  pair: KeyPairBytes,
  payload: Record<string, unknown>
): Promise<{ payload: string; signature: string }> {
  const canonical = stableStringify(payload);
  const msg = new TextEncoder().encode(canonical);
  const sig = await signBytes(pair.secretKey, msg);
  return {
    payload: canonical,
    signature: Buffer.from(sig).toString('base64'),
  };
}

export async function verifySignedJson(
  publicKey: Uint8Array,
  envelope: { payload: string; signature: string }
): Promise<Record<string, unknown> | null> {
  // v4.32.203 (Round-33 #4): defensive caps at the shared primitive.
  // Ed25519 signatures are 64 bytes (~88 base64 chars). Payloads used across
  // feed/profile envelopes are already capped upstream; mirror here so new
  // callers can't accidentally skip the check.
  if (typeof envelope.signature !== 'string' || envelope.signature.length === 0 || envelope.signature.length > 128) return null;
  if (typeof envelope.payload !== 'string' || envelope.payload.length === 0 || envelope.payload.length > 64 * 1024) return null;
  // v4.32.349: длина в БАЙТАХ, а не в символах base64. Buffer.from(s,'base64')
  // молча выбрасывает недопустимые символы и не жалуется на обрезанный хвост,
  // поэтому ограничение на длину строки не гарантирует ничего о результате.
  // Ed25519 — ровно 64 байта подписи и 32 байта ключа; всё прочее verify всё
  // равно отвергнет, но отвергнуть до обращения к кривой и дешевле, и понятнее.
  if (!isEd25519PublicKey(publicKey)) return null;
  const msg = new TextEncoder().encode(envelope.payload);
  const sig = Buffer.from(envelope.signature, 'base64');
  if (sig.length !== ED25519_SIGNATURE_BYTES) return null;
  const ok = await verifyBytes(publicKey, msg, new Uint8Array(sig));
  if (!ok) return null;
  try {
    return JSON.parse(envelope.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// v4.32.215 (Audit-44 M1): make stableStringify recursive. Previously only
// top-level keys were sorted; nested objects relied on insertion order, so
// cross-client sign/verify of FeedEnvelopePayload.data would silently break
// the moment any code path re-canonicalized nested objects before verify.
// Arrays keep their order (semantic); objects are sorted; primitives/null
// pass through JSON.stringify unchanged.
function stableStringify(obj: unknown): string {
  return JSON.stringify(canonicalize(obj));
}

// v4.32.349: накопитель — Object.create(null), а не `{}`.
// На обычном объекте присваивание out['__proto__'] = v не создаёт собственное
// свойство, а МЕНЯЕТ ПРОТОТИП. Последствий два, и оба серьёзные:
//   1. Ключ исчезает из результата, потому что JSON.stringify перечисляет
//      только собственные. Значит {"__proto__":{…},"a":1} и {"a":1} дают одну
//      и ту же каноническую строку — а значит и одну подпись. Подпись,
//      выданную под безобидную нагрузку, можно предъявить под другую.
//   2. Свойства подложенного прототипа наследуются: у результата читается
//      isAdmin===true, хотя такого поля в нём нет.
// У объекта без прототипа '__proto__' — обычный строковый ключ: попадает в
// вывод, канонизация снова взаимно однозначна, наследовать нечего.
function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const src = v as Record<string, unknown>;
  const keys = Object.keys(src).sort();
  const out: Record<string, unknown> = Object.create(null);
  for (const k of keys) out[k] = canonicalize(src[k]);
  return out;
}
