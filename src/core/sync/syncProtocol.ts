/**
 * Opaque, idempotent records exchanged with the server sync database.
 * The server may index account/device/entity ids and cursors, but payload and
 * media keys stay encrypted on the device.
 */
export type SyncEntityKind =
  | 'profile'
  | 'device'
  | 'contact'
  | 'conversation'
  | 'message'
  | 'group'
  | 'group_member'
  | 'group_message'
  | 'feed_post'
  | 'feed_comment'
  | 'story_album'
  | 'story_album_item'
  | 'reaction'
  | 'media_manifest'
  | 'setting'
  | 'presence';

export type SyncMutation = {
  mutationId: string;
  entityKind: SyncEntityKind;
  entityId: string;
  ownerProfileId: number;
  revision: number;
  deleted: boolean;
  ciphertextB64: string | null;
  updatedAt: number;
};

export type SyncPullRequest = {
  accountId: string;
  deviceId: string;
  ownerProfileId: number;
  cursor: string | null;
  limit: number;
};

export type SyncPullResponse = {
  serverEpoch: string;
  nextCursor: string | null;
  hasMore: boolean;
  mutations: SyncMutation[];
};

export type SyncPushResponse = {
  serverEpoch: string;
  acceptedMutationIds: string[];
  rejectedMutationIds: string[];
  nextCursor: string | null;
};
