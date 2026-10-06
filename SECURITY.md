# Security Policy

## Threat model

AirChat is built for privacy-conscious communication in networks that may be
unreliable, filtered or monitored. The account is kept online and synchronised
through a server; the server is treated as hostile infrastructure that happens
to be useful, not as a trusted party. The design addresses three vectors:

1. **Hostile network.** ISP or state surveillance, man-in-the-middle attempts on
   transport channels, traffic analysis, partitioning and censorship.
2. **Compromised endpoint.** A lost or seized device should not expose message
   history: the local database is encrypted at rest and key material is held in
   the platform secure store.
3. **Untrusted infrastructure.** Private content — direct and group messages,
   media, contacts, profile data and the account backup — never reaches a
   server in plaintext. The signalling relay brokers handshakes only; the cloud
   vault stores a backup archive it cannot decrypt; the sync database holds
   per-entity records encrypted on the device with a key derived from the seed
   phrase. The exceptions below are deliberate and are the whole list.

### What servers do see

- **Posts published by link.** the Publish by link action uploads a signed but
  **unencrypted** copy of the post (text and attachments) to the cloud vault,
  which serves it to anyone holding the link (`GET /v1/post/:postId`). The app
  asks for explicit confirmation before the first upload and lets the author
  revoke the link (`POST /v1/post/:postId/delete`). Copying the link of an
  already published post does not publish anything new; a private post is
  never published implicitly by «copy» or «share». Automatic updates require
  a versioned record of explicit consent on that device; a server HEAD response
  is not consent. Legacy copies can still be revoked, but must be explicitly
  republished before this device automatically updates their plaintext.
- **Public profile photos.** Choosing photo visibility «everybody» uploads a
  signed, unencrypted image to the avatar directory. Lookup keys and image
  versions are public. Choosing «contacts» or «nobody» requests removal of
  that public copy; it cannot erase copies already downloaded by others.
- **Username discovery.** A claimed `@name` is public on purpose:
  `GET /v1/username/:name` answers whether it is taken and, for names claimed
  by current clients, the owner's **profile public key** (`pub`), so that a
  person can be reached by name. The account id (the address of the
  account's storage) is never returned.
- **Sync metadata.** Account and device ids, entity kind, revision and
  timestamps, the device registry (model, OS, app version, coarse country)
  and request timing. This reveals who talks to the server, from how many
  devices and how often; the encryption above does not protect it.
- **Signalling and push metadata.** The relay sees peer ids, IP addresses and
  call timing; missed-call receipts are held until acknowledged (at most 24 h).
  Push requests name the sender and the recipient's push token; push payloads
  carry no message text (web-push is empty, RFC 8030).
- **Network addresses.** Every server sees client IP addresses; nginx and the
  services use them for rate limiting.

### Native vs web clients

- **Android / iOS:** identity keys and the database key live in the platform
  secure store (Keystore / Keychain) via `expo-secure-store`.
- **Web:** there is no hardware-backed store. Secrets are encrypted with a
  non-extractable AES-GCM `CryptoKey` kept in IndexedDB. Script running in the
  page (XSS, a malicious extension) can *use* that key while the page is open,
  though it cannot export it; the key is not bound to device unlock. Treat the
  web client as weaker than the native apps for high-risk use.

LAN (Wi-Fi) delivery exists only in the native apps. Long-range radio
transports (HF, LoRa, Wi-Fi Direct mesh) are **not** shipped: they are disabled
in code and are not part of this threat model.

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

Keep credentials and account sessions out of source and build logs. Service
addresses and other public configuration may appear in distributed clients;
they must not be treated as secrets. Web exports additionally reject native
Yandex document URLs. Test identities are fixtures, not credentials.
