# AirChat sync architecture

## Storage boundary

The server database is the source of truth for synchronized entities. SQLite
and the file-system cache on the device are projections used for fast rendering,
search, media previews and short-lived drafts. A cache miss must trigger a
server pull, not a second local account.

The current cloud-vault service is intentionally different: it stores one
encrypted backup snapshot. It is not suitable for live sync because it has no
entity rows, cursors, tombstones or conflict resolution. The signaling server
is only a WebRTC signaling channel and must not become the data store.

## Server entities

The sync database must cover profiles, authorized devices, contacts, private
conversations and messages, groups/channels/members/messages, feed posts,
comments, reactions, media manifests, settings and presence metadata. Media
bytes belong in encrypted object storage; database rows contain an encrypted
manifest, content hash, mime type, size and blob reference.

Every mutation has an idempotency key, entity revision, owner profile,
tombstone flag and server cursor. Replaying a mutation is harmless, while each
signed request nonce is accepted only once. Deletions are tombstones until all
active devices have acknowledged a cursor beyond the tombstone.

## Encryption and devices

The client encrypts entity payloads before upload. A device is enrolled with a
seed-derived signing key and has a separate device id/public key. The server
stores public keys, last-seen timestamps and revocation state only; private
keys, seed phrases and cloud passwords never leave the device.

Presence is ephemeral with a TTL. The durable `last_seen` value is an encrypted
account setting and is synchronized only when the privacy settings allow it.
The server's authorized-device registry stores the signed device model, OS/app
versions and only coarse Cloudflare location metadata (country and optional
city); it never stores source IPs or coordinates.

## Client behavior

The client keeps cached rows for instant UI. Writes require an online path and
must not be represented as sent while disconnected. The old P2P/outbox paths
remain only as a compatibility bridge until the server sync API is deployed;
new code must not add another offline queue. The local `sync_state` table stores
the server epoch, pull cursor and last push/pull timestamps per profile.

The server sync API is implemented in `server/cloud-vault`: `pull(cursor)` and
idempotent `push(mutations)` are backed by SQLite. The client projection now
fingerprints existing encrypted rows, uploads only changed entities, and keeps
local revisions/tombstones in `sync_entity_heads`. Pulled mutations are
decrypted and applied to the existing SQLite/feed writers before `sync_state`
advances. Pulls are filtered by local profile, so multiple profiles under one
seed cannot mix their databases.

The first live projection covers messages, conversation metadata, dialog
settings, profile/privacy settings, groups, group members/messages, feed posts,
feed comments and comment tombstones. Media references synchronize with their
entities. New encrypted media ciphertext is also copied to the VPS media store
by blob id; the server never receives the per-blob key or plaintext. Legacy
relay-only references remain compatible and are fetched from the relay when no
VPS copy exists.
