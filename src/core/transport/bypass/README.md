# Bypass transport scaffold

The repository does **not** contain the original specification's `MultiTransportRouter`, `OpportunisticSync`, global `db` or `encryptForTarget`. This directory contains types, disabled-by-default flags, a stub `BypassRouter`, and SQL for a possible future migration.

## Why this is not the full proposed stack

- Domain fronting through unrelated domains without agreement from the CDN/operator carries technical and legal risks. React Native does not reproduce browser SNI/Host behavior.
- DNS tunneling through public DoH endpoints using long names can abuse third-party infrastructure and violate service terms.
- VK, Telegram and Yandex require explicit user tokens and compliance with service rules. Automatic chat delivery through them is a separate product and compliance concern.

For actual P2P, use `src/core/transport/webrtc/` and your signaling service.

## Token setup for future bridges

- **VK:** register a VK app with `messages` and any scenario-required scopes. Store the user token in build environment variables or secure storage, never Git.
- **Telegram:** obtain a Bot API token from @BotFather. The user must initiate the chat with `/start`. Keep the token in CI secrets or local secure storage.
- **Yandex Disk:** register a developer application, use OAuth and minimum scopes.

## Application integration

1. Enable `"bypass": { "enabled": true, ... }` in `assets/config.json`, or override through `airchat-config.json` in the document directory.
2. Create `createBypassRouterFromFlags(cfg.bypass)` and connect it to message delivery only when real channel implementations exist.

## Future test scenarios

All current channels return `available: false` and `send: false`. After implementation, test each independently with a mock server, test account and agreed policy.
