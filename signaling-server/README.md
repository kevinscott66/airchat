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

```sh
fly secrets set FCM_SERVICE_ACCOUNT_JSON="$(base64 -i service-account.json)"
```

Tokens are held in memory with a 60-day TTL and a 200 000 cap; a sender is
limited to 60 pushes a minute. A token FCM reports as unregistered is deleted
on the spot.
