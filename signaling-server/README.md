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
