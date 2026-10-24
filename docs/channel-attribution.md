# Channel post attribution

Channel posts are displayed as the channel, irrespective of the legacy
`anonymousPosting` flag. Ordinary groups default to personal attribution; the
optional administrator mode is described below. The channel
identity is used by the post header, reply composer, message information,
forwarding attribution, exports, favourites and recently deleted panels.
Channel posts do not offer the author's direct-message action. Search and the
conversation list omit the administrator's name. Receiver notifications use the
channel name. Free-text system events are shown/exported as “Событие канала”
because legacy event text may embed a member name anywhere.

This is **presentation privacy**, not cryptographic anonymity. Authenticated
sender keys and existing sender names remain in encrypted message envelopes and
local storage for authorization, editing and delivery. Members with access to the
protocol/storage can identify the signing administrator; the membership roster
also contains administrators. Existing exports/forwards cannot be revoked.
Explicit names in user-written content or attribution of an originally forwarded
message are not automatically censored. Public message links refer to the
channel/message; this flow does not publish through the news public-post API.

Do not replace sender keys with a channel identifier: that would break sender
verification and ownership checks. Strong anonymous administration would require
a separate channel signing/delegation protocol and a migration, not a UI toggle.

## Optional anonymous administrators in ordinary groups

New group messages default to the personal author. The owner can open their own
or another administrator's member card and grant/revoke permission to publish as
the group. Eligible administrators choose the mode beside the composer; regular
members cannot acquire it. Text, attachments, voice, location, contacts and polls
use the same authorized send path. Scheduled anonymous posts are explicitly
unavailable; scheduling never silently switches an anonymous post to personal.

Permission is an owner-signed, group/target-bound v1 proof with a monotonic
revision and issue timestamp. Receive checks bind the authenticated sender,
current owner, current member role, current revision and durable membership
watermark. Demotion clears the proof without reducing its revision. A stale proof
after removal/rejoin is rejected against the membership watermark. Invited
clients request a bounded per-target snapshot from the owner using a fresh nonce;
unsolicited/replayed snapshots cannot grant or restore permission. A newer local
membership decision takes precedence. Like existing group administration,
revocation takes effect on a peer when that peer receives the authority update;
it cannot instantly change disconnected peers.

Anonymous messages use a versioned control operation that old clients ignore,
rather than fall back to showing a personal author. Delivery still uses the
persistent ordinary outbox. A separate durable expected-recipient set waits for
ACKs emitted only after an authorized message is stored. The UI shows a clock
while awaiting confirmation, including offline and older clients; lack of an ACK
is neither successful delivery nor proof of incompatibility. New clients can
defer a post while requesting missing owner state. This mode requires updated
recipients and, for bootstrap, access to the group owner.

`author_as_group` is persisted per message. The one-time migration marks existing
messages in legacy hidden-name groups and clears the obsolete group toggle; new
personal posts stay personal. Backup/sync export projects anonymous and channel
rows to a reserved zero-key author plus the group name, with authenticated sender
metadata for new clients. Old clients retain valid rows/cursors and safe visual
attribution. New clients preserve known authenticated attribution when importing
an old client's stripped re-export. An old-only backup cannot reconstruct that
metadata; it remains an unknown non-member author, not an invented administrator.

These guarantees concern presentation, not cryptographic anonymity: group
message signatures and encrypted synchronization still identify the actual
administrator. The UI never offers their profile from an anonymous message.

Compatibility limit: a new device populated exclusively through legacy live sync
may receive old rows without any per-message author mode. The old global toggle
is deliberately ignored on sync so it cannot anonymize future personal messages.
Unlike the one-time existing-database migration and file-backup import, that
legacy-only live-sync stream cannot reconstruct which historical rows had hidden
names. Do not promise historical anonymity reconstruction for that path.
