# AirChat

[English](README.md) · [Русский](README.ru.md)

[![CI](https://github.com/kevinscott66/airchat/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinscott66/airchat/actions/workflows/ci.yml) · [MIT](LICENSE)

A messenger without phone numbers or sign-up. Your seed phrase is your account: one identity unlocks encrypted history on another device.

**Status:** Active development · web available. Current snapshot: September 2026.

[ Case study ](https://dobropalm.tech/case-studies/airchat/) · [Portfolio](https://dobropalm.tech) · [Live product](https://air.dobropalm.tech)

![Actual public web client in a clean browser session. No account was created; no private conversations or seed phrases are present.](https://dobropalm.tech/assets/media/airchat.webp)

_Actual public web client in a clean browser session. No account was created; no private conversations or seed phrases are present._

## Problem & outcome

Changing phones often means depending on a phone number, an account operator or a separate backup. The goal is a portable identity and synchronized history without giving the server the keys to the content.

A browser client is available. The source implements portable identity, encrypted account sync, revisions, tombstone deletion and profile boundaries. Native builds add LAN messaging. The visual below shows the actual entry screen, not an end-to-end cryptographic audit.

## My contribution

I define account and recovery behavior, user journeys, client/server trust boundaries and the synchronization design. I own the product logic that explains what is protected, what remains visible and what losing the key means.

I use AI tools in development; product and architectural decisions are my responsibility.

## Engineering highlights

- **Retry delivery, not the mutation.** Idempotent mutations and cursors let a client recover after a connection loss. Signed requests and nonces address the separate problem of replay.
- **Deletion is synchronized state.** A tombstone preserves the deletion. Otherwise another client can reload an old record and bring a deleted message back.
- **History and connectivity are separate.** Signaling establishes peer connections; it does not become a second message database.

## Architecture & stack

| Layer | Implementation |
|---|---|
| Frontend | React Native, Expo 55, TypeScript; web and native clients |
| Backend | Node.js, cloud-vault / sync, separate WebRTC signaling |
| Data | Client SQLite; encrypted entities, revisions and server cursors |
| Security | BIP39, did:key, @noble; client-side keys and encryption |

A mutation carries an identifier, revision, owner and tombstone. sync_entity_heads tracks local record versions; sync_state stores the cursor and sync state. Schema ownership follows service boundaries rather than one shared database for every client.

## Quick start

```bash
# Requires Node.js 22.22+ (node:sqlite).
git clone https://github.com/kevinscott66/airchat.git
cd airchat/server/cloud-vault
npm ci
npm test
CLOUD_VAULT_DIR=/tmp/airchat-demo-data HOST=127.0.0.1 PORT=3010 npm start
```

This starts the sync/vault service with a separate local data directory. For the mobile/web client, return to the repository root, run `npm ci`, then `npm run web` or the platform build command. Native modules require a development build, Android SDK or Xcode; the server quick start alone does not launch a complete messenger.

## Checks

```bash
# From the repository root
npm run typecheck
npm run lint
npm test -- --runInBand
npm run test:servers
npm run web:export
```

The badge links to the actual workflow. Listing a command does not claim every check ran for each README edit.

## Deployment, observability & API

Sync, signaling and notifications are separate services. Source includes log scrubbing and Sentry integration. Native clients require platform builds and dependencies; web has its own capability limits.

```bash
curl --fail http://127.0.0.1:3010/health
# {"ok":true,"service":"airchat-cloud-vault-example","release":null}
```

Sync uses signed envelopes, not anonymous mutations. See `server/cloud-vault/README.md` for push/pull, cursors and enrollment. Never paste a real seed phrase into an API example.

## Security & limits

Servers see metadata. Public-link posts are unencrypted. Browser key storage is weaker than native secure storage. Sync and calls require connectivity. No independent cryptographic audit is claimed here.

Seed-based recovery removes dependence on a phone number, but the operator cannot reset a lost phrase. Encrypted records protect content, not all connection and synchronization metadata.

Disclosure policy: [SECURITY.md](SECURITY.md).

## History & documentation

The repository contains client and self-hostable server source. Public commit and package versions describe source state, not independently audited security or availability of every native build.

- [Sync architecture](docs/sync-architecture.md)
- [Cloud-vault service](server/cloud-vault/index.js)
- [Client sync implementation](src/core)
- [Threat model](SECURITY.md)
- [Server setup and signed sync API](server/cloud-vault/README.md)

## License

MIT - [LICENSE](LICENSE).
