# node-host: the AirChat core outside the phone, exposed through MCP

This directory contains two layers.

**Node core.** `host.ts` runs the application's existing database, identity, messaging service and relay transport. Only platform modules are replaced through `shims/`, matching the role of `metro.config.js` on mobile. `build.mjs` produces a single-file bundle.

**MCP server.** `mcp/` exposes capabilities that work without a phone: reading conversations and contacts, sending messages, and editing profile and privacy settings. It supports stdio, where an agent launches the process, and HTTP, where the process runs on a server.

## Build and run

```sh
node node-host/build.mjs node-host/mcp/main.ts node-host/dist/mcp.mjs

# Once: enroll the account seed in the directory's secure store.
AIRCHAT_SECURE_STORE_KEY=$(openssl rand -base64 32) \
  node node-host/dist/mcp.mjs enroll --workdir /var/lib/airchat

# Subsequent starts do not require the seed phrase.
AIRCHAT_SECURE_STORE_KEY=... node node-host/dist/mcp.mjs stdio --workdir /var/lib/airchat
AIRCHAT_MCP_TOKEN=... AIRCHAT_SECURE_STORE_KEY=... \
  node node-host/dist/mcp.mjs http --workdir /var/lib/airchat --port 8787
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `AIRCHAT_SECURE_STORE_KEY` | Always | 32-byte, base64-encoded secure-store encryption key |
| `AIRCHAT_MCP_TOKEN` | HTTP mode | Authentication token, at least 32 characters |
| `AIRCHAT_WORKDIR`, `AIRCHAT_MCP_HOST`, `AIRCHAT_MCP_PORT` | No | Equivalent to the corresponding command-line options |

## Encryption key requirement

The process **will not start** without `AIRCHAT_SECURE_STORE_KEY`. The working directory holds the account's seed phrase in encrypted form. A fallback key file beside it would put both ciphertext and its key into the same snapshot or backup. `mcp/main.ts` rejects that configuration before accessing disk.

Prefer systemd `LoadCredential=` or another credential source to a literal key in a service unit. Process environment variables can be visible through `/proc/<pid>/environ` and are inherited by child processes.

## Account enrollment

Supply the phrase once through `enroll`, using standard input:

```sh
pass show airchat/seed | node node-host/dist/mcp.mjs enroll --workdir /var/lib/airchat
```

Command-line arguments may appear in `ps` and shell history; environment variables remain in the process environment and reach child processes. Standard input avoids these locations. Interactive enrollment reads without echo, character by character, bypassing `readline` history.

This does not erase the phrase from JavaScript memory: strings are immutable. It limits exposure and keeps the phrase in memory for a single command. Only ciphertext remains in the directory; later server starts do not need the phrase.

## HTTP authentication

HTTP mode refuses to start without `AIRCHAT_MCP_TOKEN`: its tools operate on the account.

Send the token in `Authorization: Bearer`, never `?token=…`. URLs can reach proxy logs, browser history, `Referer` and command-line process listings. Comparison uses SHA-256 digests and `timingSafeEqual`.

The listener binds to loopback only. The process does not implement TLS; expose it through a TLS reverse proxy or SSH tunnel. There is deliberately no option to permit an unprotected `0.0.0.0` listener.

## Tools

| Name | Function |
| --- | --- |
| `status` | DID, profile, relay socket state and uptime |
| `conversations_list` | Conversations with unread counts and previews |
| `conversation_messages` | Cursor-paginated messages |
| `contacts_list` | Contacts |
| `contact_add` | Add a contact from `did:key:…`, `airchat://…`, a link or key |
| `message_send` | Send a direct message |
| `profile_get` / `profile_set` | Name, bio, status and pronouns |
| `privacy_get` / `privacy_set` | Privacy settings |

Failures return `isError: true` with a reason: `blocked`, `rate_limited`, `no_session`, `no_route`, `read_failed`, `write_failed`, `bad_contact_id` or `bad_cursor`.

- `read_failed` means the read failed, not that the account is empty. The core represents both an empty result and a failed read as `null`; treating both as empty could mislead the agent.
- `message_send` returns `null` for four different failures. The host recovers the reason from `runtime/logBus.ts`: a block needs human intervention, a rate limit expires, and a missing key requires adding the contact again.

## Visibility and capability limits

### Phone-sent messages are not visible here

Outgoing envelopes go to the recipient's topic, not the sender's. The transport suppresses self-echo using `senderDid === myDid`. A headless client subscribed to its own topic cannot observe messages sent from the phone. This is not a delay or configuration problem; it requires account synchronization, which is not connected here.

### Account synchronization is intentionally disconnected

`syncActiveAccount` would register another device, consume one of the account's eight slots, and retain the mutation log until this client consumes it. This is a user decision, not an implementation detail; a headless instance must not silently join the device list or cause log retention.

### A new instance starts with an empty database

An enrolled directory contains identity, not conversation history. It sees relay traffic received **after** startup. An empty `conversations_list` in a fresh directory is therefore a valid empty result.

### Relay-only transport; no IPFS

The core disables Helia on mobile (`ipfs_disabled_on_mobile`), and this host identifies as `ios`. Traffic uses the relay (`ntfy.sh` by default); `message_send` reports `internet`. IPFS-dependent attachments and profile photos do not work here.

### Tools not exposed

OpenFlux tunnel control and application settings belong to the native application process and phone UI. The in-app bridge (`feat/agent-bridge`) handles them; this server must not claim to enable something it cannot control.

Calls, feeds, groups and attachments are also excluded: without WebRTC, IPFS and native modules they are absent or incomplete.

## Verification

The scripts report measured results:

```sh
node node-host/build.mjs node-host/proof.ts    node-host/dist/proof.mjs
node node-host/build.mjs node-host/mcp/main.ts node-host/dist/mcp.mjs
node node-host/build.mjs node-host/mcp/scenario.ts node-host/dist/scenario.mjs

node node-host/dist/proof.mjs      # Core: DID, database, socket, relay envelope
node node-host/dist/scenario.mjs   # Server: two instances and a real MCP client
```

`scenario.mjs` creates two synthetic identities in a temporary directory, starts two `mcp.mjs` processes and talks to them over stdio using an MCP client. It checks missing-key/token startup rejection, absence of plaintext seeds on disk, delivery by a row in the recipient database rather than the sender's response, reasoned failures, HTTP 401 for missing or URL-supplied tokens, and graceful SIGTERM shutdown. Synthetic messages use the public relay.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Signal-driven shutdown or client channel closed |
| 2 | Invalid startup conditions: missing key, token or enrolled account |
| 70 | Runtime failure: unhandled exception or closed database; restart required |
| 75 | Shutdown exceeded 10 seconds; process exited rather than waiting to be killed |
| 130 | Second signal requested immediate exit |
