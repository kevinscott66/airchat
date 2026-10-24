# Channel post attribution

Channel posts are displayed as the channel, irrespective of the legacy
`anonymousPosting` flag. Ordinary group attribution is unchanged. The channel
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
