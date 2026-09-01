import type { RelayEnvelope } from './types';

export type MeshQueuedItem = {
  id: string;
  envelope: RelayEnvelope;
  createdAt: number;
  attempts: number;
};

/** Локальная очередь store-and-forward (позже — SQLite). */
export async function enqueueMesh(_item: MeshQueuedItem): Promise<void> {
  return Promise.resolve();
}

export async function dequeueNextMesh(): Promise<MeshQueuedItem | null> {
  return null;
}

export async function removeMeshQueued(_id: string): Promise<void> {
  return Promise.resolve();
}
