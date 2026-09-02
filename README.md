<p align="center">
  <img src="assets/logo/airchat-mark.png" alt="" width="96" height="96">
</p>

# AirChat

A decentralised mobile messenger with no account, no phone number and no server
that holds your messages.

AirChat is a React Native application. Messages travel over the internet by
default — direct peer connections over WebRTC, with a signaling relay that sees
who is connecting and nothing else. Identity is a self-owned `did:key` derived
from a BIP39 seed phrase.

The offline transports are the reserve, not the default: when the internet is
unavailable, censored or untrusted, the same message routes over LAN discovery,
Wi-Fi Direct, long-range radio or a store-and-forward mesh instead. They are
kept, tested and shipped — they are simply not what the ordinary day looks
like.

## Web build

A browser port is deployed at [air.dobropalm.tech](https://air.dobropalm.tech).

It offers only the channels a browser can actually reach — ordinary
connectivity and WebRTC. LAN discovery over mDNS, Wi-Fi Direct and the
long-range radio transports are hidden there rather than stubbed: no browser
can open those sockets or drive that hardware, and a control that pretends
otherwise is worse than an absent one.

## Transports

The router ranks available channels per peer and falls back automatically.

| Channel | Use |
|---------|-----|
| `internet` | Ordinary connectivity, used when it is available and trusted |
| `webrtc` | Direct peer-to-peer connections via a signalling handshake |
| `ipfs` | Decentralised pubsub over libp2p (noise + yamux, Helia) |
| `lan` | Local discovery over mDNS with a framed TCP transport |
| `longrange` | LoRa, HF radio and WiFi mesh with geographic routing |
| `bypass` | Alternative delivery channels for restricted networks |
| `whitelist` | Encrypted transport over allowlisted third-party APIs |

A store-and-forward mesh (`src/core/mesh`) carries messages across peers that
are never online at the same time, with hop limits and payload caps.

## Security

- **Self-owned identity.** A BIP39 seed phrase derives an ed25519 keypair and a
  `did:key` identifier. Keys never leave the device.
- **End-to-end encryption** on every transport, using `@noble` primitives.
- **Encryption at rest.** The local SQLite database is encrypted; sensitive
  values route through a queued SecureStore wrapper.
- **Log scrubbing.** Secrets are stripped from logs and crash reports before
  they leave the device — an always-on pass, separate from PII redaction.
- **VPN transport.** An Xray core integration (`modules/airchat-vpn`) for
  environments where the transport layer itself is filtered.

See [SECURITY.md](SECURITY.md) for the threat model and disclosure process.

## Cloud vault (optional)

Three optional services live under `server/`, none of which is trusted with
plaintext:

- **`cloud-vault`** — zero-knowledge backup. It stores an encrypted archive
  keyed by material derived from the seed phrase and a separate cloud password;
  the server sees neither and cannot decrypt what it holds. There is no password
  reset path, by design.
- **`signaling-server`** — a small WebRTC signalling relay. It brokers
  handshakes and never sees message content.
- **`ntfy-vps`** — configuration for a self-hosted push relay, so notifications
  do not have to route through a vendor.

The app works without all three; they only widen connectivity.

## Stack

React Native 0.83 · Expo SDK 55 · Hermes · TypeScript · libp2p / Helia ·
`@noble/curves`, `@noble/ciphers`, `@noble/hashes` · BIP39 · `did-jwt` ·
expo-sqlite · React Navigation · Sentry · Gradle / Xcode native modules

101k lines of TypeScript across `src/`, 334 test suites.

## Build

```bash
npm install --ignore-scripts
npx expo start --android
```

Release build:

```bash
cd android && ./gradlew assembleRelease
```

Prerequisites: Node.js 18+, Android SDK with `ANDROID_HOME` set, and Xcode for
the iOS target. The Xray core shared libraries are not committed — see
`modules/airchat-vpn/android/src/main/jniLibs/README.md`.

## Notes on this repository

Host names, IP addresses and deployment identifiers in source, tests and server
configuration are placeholders. No credentials are committed.

## Licence

MIT — see [LICENSE](LICENSE).
