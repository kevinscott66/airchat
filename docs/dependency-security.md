# Root dependency security boundaries

The root lockfile includes the mobile/web client, Metro/Expo development tools,
Jest and optional Node IPFS tooling. An npm audit count includes vulnerable
transitive parents; it is not a count of independently reachable client flaws.
Do not use `npm audit fix --force`: its suggested Expo/Jest/Firebase downgrades
are incompatible with this project's native SDK.

## Maintained compatibility fixes

- React Navigation core 7.22.1+ removed its `query-string` dependency. Use the
  compatible 7.x release selected by the lockfile; this removes the vulnerable
  `decode-uri-component` parser from navigation without forcing an ESM decoder
  into the older CommonJS query-string API.
- Firestore's Node-only grpc-js dependency is overridden to 1.13.6, the first
  release fixing GHSA-m9gg-hp2v-232j and GHSA-f596-whhp-79r4. The override is
  scoped to Firestore; Firebase/native SDK versions are unchanged. Its existing
  proto-loader and public grpc client interfaces remain in use.
- `@istanbuljs/load-nyc-config` uses only `js-yaml.load`. Its override to js-yaml
  4 removes argparse 1 / sprintf-js. Ordinary YAML coverage configuration is
  preserved; executable JavaScript YAML tags are intentionally unsupported.

Run `npm run check:dependency-security` after installation. It exercises the
actual navigation parser, grpc/proto-loader client interface and YAML loader.
Run TypeScript, relevant Jest suites and a web export when updating the lockfile.

## October 24 refresh

Targeted compatible lockfile updates patched body-parser, fast-uri,
follow-redirects, handlebars, hono, ip-address, markdown-it, shell-quote, undici
and their affected callers. MCP SDK is now 1.32.2. The direct Zod dependency is 4.6.7:
its only application consumer is the optional Node-host MCP tool schema module,
whose string/number/object schemas are supported by the new SDK. The compatibility
script verifies schema discovery, successful invocation and rejection of invalid
arguments through an in-memory MCP client/server pair.

Raw root `npm audit` on October 24 reports 8 high entries, zero critical,
moderate or low (down from 21 entries including 2 critical). These eight entries
include affected parents; two vulnerable leaf packages remain. The registry no longer reports the earlier braces advisory; installed braces
remains 3.0.3, so this is not claimed as a local patch. No audit entries
are suppressed. Framework major versions and scoped overrides are unchanged.

## Residual upstream advisories (2026-10-24)

### Expo CLI's nested Zod 3: GHSA-mrhx-c7xc-m3w5

The project-owned MCP schemas use patched Zod 4.6.7, but Expo CLI retains its
own Zod 3.25.76. Oversized constrained collection validation can exhaust memory.
This is development tooling, not the mobile/web application schema parser.
Expo's dependency requires Zod 3; forcing a cross-major replacement globally
would bypass that compatibility contract. Keep the developer server private,
use trusted dev-tool extensions, and review the upstream Expo CLI update before
accepting remote tooling/schema inputs. A framework downgrade suggested by npm
is not applied. This remaining dependency is not represented as fixed.

### node-forge: GHSA-86w9-cpqp-85rv

Installed 1.4.0 has an RSA PKCS#1 v1.5 DigestAlgorithm validation defect; no
patched release exists. AirChat message/identity verification uses noble, not
forge. Expo tooling uses forge for local developer certificate/key material and
for signatures it generates itself. Do not import untrusted developer signing
keys/certificates/CSRs into this tooling. Forge is also retained as the **legacy**
`acme.forge` export of acme-client; libp2p auto-TLS does not call that export and
uses Node/WebCrypto certificate helpers. A dependency merely being imported
is not evidence that the vulnerable verification API processes network input.
Before accepting external certificates/CSRs in tooling or using `acme.forge`,
require a patched release or independent replacement review. Do not implement
local cryptographic patches simply to suppress an audit entry.

## Official sources

- [Zod collection validation advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
- [MCP SDK release history](https://github.com/modelcontextprotocol/typescript-sdk/releases)

- [grpc-js 1.13.6 release](https://github.com/grpc/grpc-node/releases/tag/%40grpc%2Fgrpc-js%401.13.6)
- [decode-uri-component advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)
- [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
- [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
- [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
