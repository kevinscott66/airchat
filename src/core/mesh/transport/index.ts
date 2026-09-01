import type { RelayEnvelope } from '../types';

export type MeshTransport = {
  name: string;
  send: (env: RelayEnvelope) => Promise<boolean>;
};

export async function sendViaBestTransport(
  _transports: MeshTransport[],
  _env: RelayEnvelope
): Promise<boolean> {
  return false;
}

export { publishMeshEnvelopeViaIpfs, subscribeMeshIpfsTopic } from './ipfsRelay';
