import { Buffer } from 'buffer';

import type { MeshMessageId, RelayEnvelope, RelayEnvelopeV1 } from './types';

export function createRelayEnvelopeV1(params: {
  id: MeshMessageId;
  recipientDid: string;
  cipherBlob: Uint8Array;
  expiresAt: number;
  hopsLeft: number;
  nextHopDid?: string;
}): RelayEnvelopeV1 {
  return {
    v: 1,
    id: params.id,
    recipientDid: params.recipientDid,
    nextHopDid: params.nextHopDid,
    cipherBlob: params.cipherBlob,
    expiresAt: params.expiresAt,
    hopsLeft: params.hopsLeft,
  };
}

/** Сериализация для транспорта (JSON + base64 для cipherBlob; при необходимости — CBOR/MessagePack). */
export function encodeRelayEnvelope(env: RelayEnvelope): Uint8Array {
  if (env.v !== 1) return new Uint8Array(0);
  const v1 = env as RelayEnvelopeV1;
  const obj = {
    v: 1 as const,
    id: v1.id,
    recipientDid: v1.recipientDid,
    nextHopDid: v1.nextHopDid,
    cipherBlobB64: Buffer.from(v1.cipherBlob).toString('base64'),
    expiresAt: v1.expiresAt,
    hopsLeft: v1.hopsLeft,
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * v4.32.196 (Round-26 #1): strict shape + byte-caps.
 * Mesh relay envelopes arrive from untrusted peers; unbounded JSON.parse and
 * unbounded base64 decode would OOM the device. 2 MB covers legitimate
 * payloads (attachments travel via IPFS CIDs, not mesh).
 */
const RELAY_ENVELOPE_MAX_BYTES = 2 * 1024 * 1024;
const RELAY_CIPHERBLOB_MAX_BYTES = 2 * 1024 * 1024;
const RELAY_HOPS_MAX = 32;
const RELAY_DID_MAX = 256;
const RELAY_ID_MAX = 128;

export function decodeRelayEnvelope(bytes: Uint8Array): RelayEnvelope | null {
  try {
    if (bytes.byteLength > RELAY_ENVELOPE_MAX_BYTES) return null;
    const j = JSON.parse(new TextDecoder().decode(bytes)) as {
      v?: unknown;
      id?: unknown;
      recipientDid?: unknown;
      nextHopDid?: unknown;
      cipherBlobB64?: unknown;
      expiresAt?: unknown;
      hopsLeft?: unknown;
    };
    if (j.v !== 1) return null;
    if (typeof j.id !== 'string' || j.id.length === 0 || j.id.length > RELAY_ID_MAX) return null;
    if (typeof j.recipientDid !== 'string' || j.recipientDid.length === 0 || j.recipientDid.length > RELAY_DID_MAX) return null;
    if (j.nextHopDid !== undefined && (typeof j.nextHopDid !== 'string' || j.nextHopDid.length > RELAY_DID_MAX)) return null;
    if (typeof j.cipherBlobB64 !== 'string' || j.cipherBlobB64.length === 0) return null;
    // base64 expands ~4/3 → cap raw string to ~(max * 4/3 + 4).
    if (j.cipherBlobB64.length > Math.ceil(RELAY_CIPHERBLOB_MAX_BYTES * 4 / 3) + 4) return null;
    if (typeof j.expiresAt !== 'number' || !Number.isFinite(j.expiresAt)) return null;
    // v4.32.199 (Round-29 #5): clamp relay TTL window. Without this a peer
    // can set expiresAt: 9e15 and the envelope would sit in store-and-forward
    // forever (never GC'd). Reject already-expired + >7d future.
    const relayNow = Date.now();
    const MAX_RELAY_TTL_MS = 7 * 24 * 60 * 60_000;
    if (j.expiresAt < relayNow - 60_000 || j.expiresAt > relayNow + MAX_RELAY_TTL_MS) return null;
    if (typeof j.hopsLeft !== 'number' || !Number.isFinite(j.hopsLeft) || j.hopsLeft < 0 || j.hopsLeft > RELAY_HOPS_MAX) return null;
    const cipherBlob = new Uint8Array(Buffer.from(j.cipherBlobB64, 'base64'));
    if (cipherBlob.byteLength === 0 || cipherBlob.byteLength > RELAY_CIPHERBLOB_MAX_BYTES) return null;
    return {
      v: 1,
      id: j.id,
      recipientDid: j.recipientDid,
      nextHopDid: typeof j.nextHopDid === 'string' ? j.nextHopDid : undefined,
      cipherBlob,
      expiresAt: j.expiresAt,
      hopsLeft: j.hopsLeft,
    };
  } catch {
    return null;
  }
}
