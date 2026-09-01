/** Pubsub «я онлайн как релей» — осторожно с трафиком (фаза 6). */

export async function announceMeshRelay(_topic: string, _payload: Uint8Array): Promise<void> {
  return Promise.resolve();
}

export async function subscribeMeshGossip(
  _topic: string,
  _onPayload: (data: Uint8Array) => void
): Promise<() => void> {
  return () => {};
}
