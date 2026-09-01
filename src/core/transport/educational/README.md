# Educational communication modules

## Legal notice

This repository includes **optional, disabled-by-default** code paths for learning how common internet protocols and public APIs work (HTTPS, DNS-over-HTTPS, official HTTP APIs).

- The project is open source and intended for transparency and education.
- Integrations use **documented** endpoints where tokens are required; tokens must be obtained **officially** and stored securely (never committed to git).
- Nothing in these modules is intended to encourage misuse of third-party services or to violate applicable law or Terms of Service.

## What is implemented

1. **Domain / CDN study** (`domainFronting.ts`): optional `HEAD` request to a public HTTPS host when explicitly enabled.
2. **DNS / DoH study** (`dnsTunnel.ts`): optional `application/dns-json` query for an A record when explicitly enabled.
3. **Public API study** (`publicServices.ts`): optional calls to official VK / Telegram Bot API **when tokens are configured and the module is enabled**.
4. **Router** (`bypassRouter.ts`): combines the above and provides lightweight connectivity checks.

## Defaults

- All experimental toggles in `assets/config.json` are **`enabled: false`**.
- Runtime classes default to **`enabled: false`** unless you pass `true` in code.

## Enabling (development only)

1. Set environment variable (Expo client): `EXPO_PUBLIC_ENABLE_EDUCATIONAL_MODULES=true`  
   (Alternatively `ENABLE_EDUCATIONAL_MODULES=true` if your bundler injects it.)
2. Optionally set `educational.experimentalModules.*.enabled` in `assets/config.json` or user override `airchat-config.json` **only** if you understand that this may trigger real network requests.

## Official API tokens (high level)

- **VK**: create an app in the VK developer console, obtain a token with the scopes required for your scenario, follow VK Platform Policy.
- **Telegram**: create a bot via @BotFather, use Bot API token only in secure storage; follow Telegram ToS.
- **Yandex**: OAuth application in the Yandex developer console, minimal scopes, follow Yandex API terms.

## Important

These modules demonstrate **standard protocols**. Always comply with the Terms of Service of any service you use, and with local regulations applicable to your research.
