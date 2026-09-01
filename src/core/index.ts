/**
 * Barrel for documentation (TypeDoc). Prefer importing from concrete modules in app code.
 */
export { MessagingService, getMessagingService, initMessagingService } from './social/messaging';
export { IPFSMessageStore, type EncryptedMessage } from './social/messageStore';
export { syncDmHistoryFromProfile, dmPairKey } from './social/messageSync';
export type { ProfilePayload } from './identity/profile';
export { multiTransportRouter, MultiTransportRouter } from './transport/multiTransport';
export {
  MeshCoordinator,
  createMeshCoordinatorIfEnabled,
  mergeMeshConfig,
  defaultMeshRuntimeConfig,
  type MeshRuntimeConfig,
  type RelayEnvelope,
  type NextHopCandidate,
} from './mesh';
