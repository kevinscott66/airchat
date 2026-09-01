import type { RelayEnvelope } from './types';

export const MESH_MAX_HOPS_DEFAULT = 7;
export const MESH_MAX_PAYLOAD_BYTES_DEFAULT = 64 * 1024;

export function clampHopsLeft(hopsLeft: number): number {
  return Math.max(0, Math.min(MESH_MAX_HOPS_DEFAULT, hopsLeft));
}

export function isExpired(env: RelayEnvelope, nowMs: number = Date.now()): boolean {
  return nowMs > env.expiresAt;
}

export function canRelay(env: RelayEnvelope): boolean {
  return env.hopsLeft > 0;
}
