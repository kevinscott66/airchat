# Security Policy

## Threat model

AirChat is built for offline-first, privacy-conscious communication in networks
that may be unreliable, filtered or monitored. The design addresses three
vectors:

1. **Hostile network.** ISP or state surveillance, man-in-the-middle attempts on
   transport channels, traffic analysis, partitioning and censorship.
2. **Compromised endpoint.** A lost or seized device should not expose message
   history: the local database is encrypted at rest and key material is held in
   the platform secure store.
3. **Untrusted infrastructure.** No server is trusted with plaintext. The
   signalling relay brokers handshakes only; the cloud vault stores an archive
   it cannot decrypt.

## Cryptography

Identity is an ed25519 keypair derived from a BIP39 seed phrase and published as
a `did:key`. Message encryption uses the `@noble` primitives (`curves`,
`ciphers`, `hashes`). No custom cipher constructions are used.

No external cryptographic audit has been completed. **Independent security
review is recommended before relying on this in a high-risk setting.**

## Reporting a vulnerability

Report privately to **hello@dobropalm.tech** or via Telegram
[@dobropalm](https://t.me/dobropalm). Do not open a public issue for an
unpatched vulnerability.

In scope: cryptographic implementation and key management, authentication or
authorisation bypass, data leakage and privacy violations, remote code
execution, privilege escalation.

Include a description, reproduction steps, an impact assessment and a suggested
remediation if you have one. Expect acknowledgement within 72 hours and a
90-day coordinated disclosure window.

## Repository hygiene

No credentials are committed. Host names, IP addresses and deployment
identifiers in source, tests and server configuration are placeholders. The
`did:key` values in tests are the public example identifiers from the W3C
specification, not live keys.
