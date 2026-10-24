# AirChat sync architecture

## Storage boundary

The server database is the source of truth for synchronized entities. SQLite
and the file-system cache on the device are projections used for fast rendering,
search, media previews and short-lived drafts. A cache miss must trigger a
server pull, not a second local account.

The cloud-vault service has two separate storage interfaces: an encrypted backup
snapshot per account and the live SQLite sync API with entity snapshots, cursors
and tombstones. Media ciphertext lives in files referenced by SQLite. Signaling
handles WebRTC discovery and bounded missed-call delivery, not account sync.

## Server entities

The sync database must cover profiles, authorized devices, contacts, private
conversations and messages, groups/channels/members/messages, feed posts,
comments, reactions, media manifests, settings and presence metadata. Media
bytes belong in encrypted object storage; database rows contain an encrypted
manifest, content hash, mime type, size and blob reference.

Every mutation has an idempotency key, entity revision, owner profile,
tombstone flag and server cursor. Replaying a mutation is harmless, while each
signed request nonce is accepted only once. Each mutation contains a full entity
snapshot, not an incremental patch. The server retains the latest ciphertext row
referenced by every entity head, including deletion tombstones. Superseded rows
can be compacted independently of device/profile cursors: a fresh or returning
device receives the latest state. Pull records only its input cursor as the
acknowledgement; a returned cursor is not proof of durable client application.
Retries after a lost response retain current snapshots. Already removed
ciphertext from older compaction behavior cannot be reconstructed by migration.

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


## Server storage bounds and schema

Schema version 6 adds persistent public-copy ownership/revision and avatar
revocation timestamps. Startup refuses a newer schema before changing it. Existing
live public copies and avatars are backfilled; deleted historical ownership is
unavailable and cannot be inferred safely. Superseded sync mutation rows are
compacted on write/pull; current heads and tombstones remain durable.

The account sync quota counts ciphertext, ID lengths and 512 bytes of metadata
per retained entity snapshot. Replacement credits the old snapshot in the same
transaction, so repeated updates alone do not fill the account quota. Empty
legacy tombstones cost metadata. The database has a global SQLite page ceiling
(default 8 GiB, `SYNC_MAX_DATABASE_BYTES`) and 100,000 accounts; exceeding a
ceiling refuses new allocation rather than evicting private state. File admission
counts all files under the vault data directory against 16 GiB and reserves
256 MiB of free filesystem space before allocating a temporary copy. SQLite write
transactions also check the reserve. These are admission limits, not an OS disk
quota: WAL, concurrent processes and other services require operational headroom.
File admission currently scans the directory synchronously; large installations
should replace this with transactionally maintained usage before increasing caps.

Unexpected uncaught runtime failures exit with status 1 so the configured service
supervisor restarts and SQLite recovers its journal. Expected request failures
remain bounded HTTP errors. Nonce GC uses an indexed expiry range and at most
500 rows per authenticated request without shortening the replay window.

## Public copy protocol v2

Public copies are intentionally readable signed content, unlike encrypted sync.
Every public link ID has a permanent owner key and revision, retained when its
content is revoked or evicted by GC. Owner registry limits are 1,000,000 total
IDs and 10,000 per author; existing-owner operations work when the registry is
full, while new IDs fail closed. Bindings are never TTL-evicted. This prevents
future reuse of known IDs but cannot recover bindings deleted before migration.

An intent signs `{v:2, act, postId, publicKeyB64, ts, nonce, expectedRevision}`.
`expectedRevision` is a nonnegative safe integer and is omitted for `state`.
All intents retain signature, timestamp and nonce validation.

- `POST /v1/post/:id/state`: owner key plus signed `state` intent returns
  `{ok:true, revision, active}`; unknown IDs return revision 0/inactive. Other
  owners receive 403.
- `POST /v1/post/:id`: signed content envelope plus `publish` or `refresh` intent.
  Both compare expected revision atomically. Explicit `publish` can activate a
  new or revoked copy; background `refresh` requires an already active copy.
- `POST /v1/post/:id/delete`: signed `del` intent compares revision and persists
  revocation, including for an unknown ID. A successful write/delete increments
  revision. GC also increments revision and deactivates the binding.

Success includes `revision` and boolean `active`; publish/refresh also returns
`postId` and `bytes`, delete returns `removed`. CAS mismatch/inactive refresh is
409; foreign owner is 403; registry capacity is 413. Clients must not turn a
failed refresh into a publish. The public GET includes revision while active.
Legacy v1 publication is refused with 426 `public_post_upgrade_required` because
it cannot distinguish explicit republishing from stale background refresh.
Authenticated v1 deletion remains compatible for the existing owner. Deploy the
server before the v2 client; an older server rejects v2 rather than misinterpreting
it. No production deployment is implied by this source change.

Local migration failure, retained failed projections and historical missing-row diagnostics are described in [client storage recovery](client-storage-recovery.md).
