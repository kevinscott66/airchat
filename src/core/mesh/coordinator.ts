import type { KeyPairBytes } from '../crypto/keyManager';
import type { AppConfig } from '../config';
import type { RelayEnvelope } from './types';
import { mergeMeshConfig, type MeshRuntimeConfig } from './config';

export class MeshCoordinator {
  private readonly cfg: MeshRuntimeConfig;

  constructor(
    _pair: KeyPairBytes,
    cfg?: Partial<MeshRuntimeConfig>
  ) {
    this.cfg = mergeMeshConfig(cfg);
  }

  getConfig(): MeshRuntimeConfig {
    return this.cfg;
  }

  dispose(): void {
    /* остановка scheduler / подписок — при расширении */
  }

  async sendMesh(_toRecipientDid: string, _innerPayloadBytes: Uint8Array): Promise<MeshMessageRef | null> {
    if (!this.cfg.enabled) return null;
    return null;
  }

  async handleIncomingRelay(_env: RelayEnvelope): Promise<'consumed' | 'relayed' | 'ignored'> {
    return 'ignored';
  }
}

export type MeshMessageRef = { id: string };

/** Создаёт координатор только если в конфиге приложения mesh включён. */
export function createMeshCoordinatorIfEnabled(
  pair: KeyPairBytes,
  mesh: AppConfig['mesh'] | undefined
): MeshCoordinator | null {
  if (!mesh?.enabled) return null;
  return new MeshCoordinator(pair, {
    enabled: mesh.enabled,
    maxHops: mesh.maxHops,
    maxPayloadBytes: mesh.maxPayloadBytes,
  });
}
