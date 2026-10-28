# Two-client service/protocol integration

Run with Node 22 after `npm ci` in `signaling-server` and `server/cloud-vault`:

```sh
npm run test:integration
```

The harness starts the actual services on random loopback ports with temporary
SQLite storage and no push-provider configuration. Two independent Socket.IO
clients register using real Ed25519 challenges, exchange signaling, disconnect,
reconnect and switch profile identity. Two enrolled device keys perform real
signed HTTP sync requests and verify profile isolation, recovery from a prior
cursor and repeatable current snapshots. Public-copy v2 publish/revoke is checked
against an in-flight stale refresh through actual HTTP and signatures.

There are no mocked HTTP/socket responses, production endpoints or Firebase
calls. Temporary storage and sockets are removed on completion. Payload encryption
uses a fixture AES-GCM helper solely to verify opaque-byte preservation; it does
not replace tests of the production client's encryption or storage projections.
This is a protocol integration harness, not browser UI E2E, RTCPeerConnection data
channel negotiation, audio/video delivery, or an iOS/Android two-device test.
The separate `e2e/web/run.js` remains a browser smoke test.
