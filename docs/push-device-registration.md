# Device-scoped push registration

Deploy the signaling server before the client. Signed `/register-token` claims
now contain `deviceId` (the same installation identity used for sync), alongside
`peerId`, `platform`, `token`, and `ts`. Old claims remain valid in a reserved
`legacy` slot. New clients retry that old format only on HTTP 400 from an old
server; capacity/network failures never trigger downgrade.

The registry key is `(peer_id, device_id)`, with at most eight slots per profile
and the existing global capacity/TTL. SQLite migrates the former single-device
table transactionally and moves existing registrations into the legacy slot.
A token rotation only replaces that installation. Fan-out is bounded by the
slot limit, deduplicates identical provider tokens, and isolates delivery errors.
A stale provider response deletes only the token and timestamp actually sent.

`POST /push-devices` accepts a signed `{act:'push_devices',peerId,ts}` claim and
returns device id, platform and last registration time, never provider tokens.
`POST /unregister-token` accepts a signed
`{act:'push_revoke',deviceId,peerId,ts}` claim. A newer stored registration gives
409 instead of falsely confirming removal. Revocation retains a timestamp
marker for ten minutes (longer than the signed request replay window); that
marker counts toward the eight-slot limit until cleanup. Existing slots can
renew; older captured enrollments cannot revive revoked slots.

Client disposal removes only its current profile/device subscription and also
invalidates its provider token. Settings shows registration status for the
active profile. Ending a sync session first revokes the selected device's push
slot for every locally known profile, each with its own signature. A push
failure leaves the action retryable. On older signaling servers the UI reports
that per-device push revocation is unavailable while still ending sync access.

Limits: a legacy subscription has no trustworthy installation association and
cannot be assigned to a sync device retrospectively. It expires, is removed as
stale, or is replaced when the older client registers again. Owners of the seed
retain profile signing authority and can explicitly enroll again; push slot
removal is not cryptographic revocation of that seed. Profiles absent from the
local profile list cannot be enumerated through the signaling server. Physical
FCM/APNs/Web Push delivery still requires device acceptance; unit/integration
coverage uses local fake provider responses and signed HTTP requests.

Revocation also stores a marker when enrollment has not arrived yet. A full registry returns 503 rather than acknowledging an unrecorded revoke. Newer revokes refresh the marker. Its ten-minute lifetime is independent of token TTL: signed requests allow five minutes of clock skew in either direction, so a future-dated request accepted now can remain fresh for ten minutes. The marker survives the inclusive boundary; afterward older enrollment requests fail freshness validation.
