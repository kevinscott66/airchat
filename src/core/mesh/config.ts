export type MeshRuntimeConfig = {
  enabled: boolean;
  maxHops: number;
  maxPayloadBytes: number;
};

export const defaultMeshRuntimeConfig: MeshRuntimeConfig = {
  enabled: false,
  maxHops: 7,
  maxPayloadBytes: 64 * 1024,
};

export function mergeMeshConfig(patch: Partial<MeshRuntimeConfig> | undefined): MeshRuntimeConfig {
  return { ...defaultMeshRuntimeConfig, ...patch };
}
