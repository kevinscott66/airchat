# AirChat signaling server

Minimal Socket.IO signaling relay for WebRTC. The server does not inspect or
persist SDP or ICE data. A client must register before it can send signals;
signals are routed only to the currently registered `peerId`.

## Run

```sh
npm install
PORT=3001 npm start
```

`GET /health` returns a small readiness response. Deploy behind HTTPS/WSS in
production. The server accepts `CORS_ORIGIN` (default `*`).

## Client contract

After connecting, the server sends `registration_challenge` with a short-lived
random challenge. The client proves possession of the Ed25519 private key by
signing `${challenge}\n${roomId}\n${peerId}`. Client-to-server events:

- `register`: `{ roomId, peerId, signature }` (the peer id is the base64 Ed25519 public key)
- `offer`: `{ roomId, targetPeerId, sdp }`
- `answer`: `{ targetPeerId, sdp }`
- `ice-candidate`: `{ targetPeerId, candidate }`
- `hangup`: `{ targetPeerId }`

Forwarded messages include `fromPeerId`. An unavailable target produces
`peer_unavailable` with `{ targetPeerId, roomId }`; malformed, oversized, or
rate-limited requests produce `signaling_error`.

The default limits are a 128 KiB Socket.IO payload, 64 KiB SDP, 16 KiB ICE
candidate, and 120 signaling events per socket per 10 seconds.

## Push relay — 4.32.537

Both push endpoints existed in the client since 4.31 and answered `404` here,
so a notification with the application closed never arrived at all. They are
served now.

- `POST /register-token` — payload keys `peerId`, `platform`, `token`, `ts`
- `POST /send-push` — payload keys `cid`, `kind`, `senderDid`, `senderPeerId`,
  `targetPeerId`, `ts`

Both take the same signed envelope, `{ payload, signature }`, where `payload`
is the canonical JSON string the client signed and `signature` is base64 of the
Ed25519 signature over its bytes. The signing key is read *out of the signed
payload* (`peerId` / `senderPeerId`), so a captured signature cannot be
re-presented under someone else's name. `ts` must be within five minutes of
server time, and a registration older than the one on file is refused — the
replay window alone would let an intercepted request roll a token back.

Both answer `204` in every non-malformed case, including an unknown recipient:
a different status code would turn the endpoint into a directory of who has
push enabled.

### What the relay learns

`{ cid, contactDid, kind }` and nothing else. No name, no text, no group id —
the device looks the message up locally by `cid`. The iOS alert text is
composed here, which is why it is impersonal ("Новое сообщение — откройте
приложение"): the server has nothing personal to put in it.

### Payload shape, and why it differs per platform

Android gets a data-only message at `priority: HIGH`. A `notification` block
would make FCM draw its own tray banner and skip the background handler
entirely, which is where mute, "Do not disturb" and the per-group switches are
applied. iOS gets an `alert` payload with `apns-push-type: alert` and
`apns-priority: 10`, because a data-only push is never displayed there with the
application closed.

### Credentials

`FCM_SERVICE_ACCOUNT_JSON` — the Firebase service-account JSON, raw or base64.
It is read from the environment only and is never in the repository. Without
it the endpoints still answer `204`, log once, and signaling keeps working:
push is the part that degrades, not the call.

## Web Push — 4.32.561

The browser has background delivery and needs nobody's certificate for it:
Service Worker + Push API + a VAPID signature. A page installed as a PWA is
notified with the tab closed — which is exactly what an IPA signed with someone
else's team certificate cannot do.

The subscription arrives through the same signed `/register-token` with
`platform: "web"`; its "token" is the JSON the browser hands out
(`PushSubscription.toJSON()`), and it is accepted only if it parses into an
`https` endpoint — an `http://` or internal address is refused, so the endpoint
cannot be turned into a request generator against our own network.

- `GET /webpush-key` — the public VAPID key, or `404 not_configured`. It is
  public by definition: the browser needs it to tell our pushes from anyone
  else's. No signature required.

The push itself is **empty** (RFC 8030). That is not an economy: the payload
would pass through Google, Mozilla or Apple, and the only way to tell them
nothing is to send nothing. The Service Worker draws an impersonal banner, and
what actually arrived the page finds out for itself once it is opened. This
also removes the payload-encryption machinery of RFC 8291 — there is nothing to
encrypt. A `404`/`410` from the push service means the subscription is gone and
the entry is dropped.

The page asks for the permission on a tap, in Settings → Notifications →
«Уведомления в браузере», and never on load: Safari — the only route to
notifications on an iPhone without the App Store — hands out the Push API in
response to a gesture, and a browser remembers a refusal for the whole domain.
Turning the switch off unsubscribes the browser; the entry here dies with the
next push (`410 Gone`), because a page cannot withdraw its own permission.

### Credentials

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (base64url raw scalar or a PKCS#8 PEM)
and `VAPID_SUBJECT` (`mailto:` or `https:`). Generate the pair yourself with
`npm run vapid` and put it into the server's secrets; nothing is written to
disk. Without the three variables web-push is simply off — the endpoints still
answer `204` and `/webpush-key` answers `404`. Changing the keys invalidates
every existing browser subscription; people re-subscribe when they next open
the page.

```sh
fly secrets set FCM_SERVICE_ACCOUNT_JSON="$(base64 -i service-account.json)"
```

A sender is limited to 60 pushes a minute, and a token FCM reports as
unregistered is deleted on the spot.

### Where the tokens live — 4.32.538

`PUSH_TOKEN_DB` — path to the SQLite file, `/data/push-tokens.db` on the fly
volume declared in `fly.toml`. Unset, the registry stays in memory, which is
what tests and a local run use.

Memory was the original behaviour and it was wrong for this data. A device
sends its token once, at application start, and the token is needed exactly
when the application is closed and cannot send it again — so one deploy of the
relay silenced everyone until they next opened the app, which is precisely when
they no longer needed the notification. A 60-day TTL and a 200 000 cap still
apply; expiry now makes room before the cap refuses a new device.

SQLite comes from `node:sqlite` in the standard library — no new dependency.
The volume is attached to a machine, so **this service runs exactly one
machine** (`min_machines_running = 1`, `auto_stop_machines = false`). Two
machines would each hold a slice of the registry and drop the pushes for the
other slice; scaling out means moving the registry to shared storage first.

The container drops to the `node` user, and a fly volume mounts as root, so
`docker-entrypoint.sh` chowns the database directory and immediately drops
privileges with `su-exec`. If the file cannot be opened for any reason the
relay logs `push_tokens_disk_failed` and falls back to memory: signaling must
come up even when push cannot.

The row is `peerId → device token`. No contacts, no conversations, no address
book.
