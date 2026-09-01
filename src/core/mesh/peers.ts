import type { NextHopCandidate } from './types';

export type MeshPeerSnapshot = {
  peerDid: string;
  lastSeenAt: number;
  transport: NextHopCandidate['transport'];
};

export async function listMeshCandidates(_recipientDid: string): Promise<NextHopCandidate[]> {
  return [];
}
