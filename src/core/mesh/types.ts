/** Идентификатор пакета mesh-слоя (UUID или хеш). */
export type MeshMessageId = string;

/** Один шаг маршрута (для логов / отладки, без текста сообщения). */
export type HopRecord = {
  at: number;
  peerDid: string;
};

/** Конверт для ретрансляции; plaintext для B — только внутри cipherBlob после unwrap. */
export type RelayEnvelopeV1 = {
  v: 1;
  id: MeshMessageId;
  recipientDid: string;
  nextHopDid?: string;
  cipherBlob: Uint8Array;
  expiresAt: number;
  hopsLeft: number;
};

export type RelayEnvelope = RelayEnvelopeV1;

/** Кандидат на следующий прыжок. */
export type NextHopCandidate = {
  peerDid: string;
  transport: 'ipfs' | 'webrtc';
  score: number;
};
