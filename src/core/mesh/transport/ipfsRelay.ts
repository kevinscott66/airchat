import type { RelayEnvelope } from '../types';

export async function publishMeshEnvelopeViaIpfs(_env: RelayEnvelope): Promise<string | null> {
  return null;
}

export async function subscribeMeshIpfsTopic(_topic: string, _onCid: (cid: string) => void): Promise<() => void> {
  return () => {};
}
