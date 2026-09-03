# AirChat cloud vault

This is a blind storage service for the optional AirChat cloud backup and live
account synchronization. The mobile app encrypts the whole seed-bound vault
with a key derived from the seed phrase and the cloud password. Live sync
mutations are encrypted on the device before upload. Every request is signed
with the Ed25519 identity derived from the seed phrase.

The backup endpoint stores one encrypted envelope per account id. The sync
database stores opaque ciphertext plus ordering metadata, device registry,
revisions and tombstones. It never sees a seed phrase, cloud password, profile
data, or database plaintext. Put the data directory on persistent storage and
expose the service through HTTPS.

Node 22 or newer is required because the service uses the built-in
`node:sqlite` driver.

```sh
npm ci
CLOUD_VAULT_DIR=/var/lib/airchat-cloud-vault-example PORT=3010 npm start
```

For the production VPS, use the included systemd unit and Nginx location
snippet in `deploy/`. The current deployment keeps Node on localhost and
publishes the service through the existing Cloudflare-proxied
`agents.example.com:8443` origin at `/cloud-vault/`.

`fly.toml` remains an optional fallback deployment manifest and is not the
production endpoint.

For Fly.io, `fly.toml` provisions an HTTPS service and mounts the encrypted
`airchat_cloud_vault_data` volume. Deploy from this directory with:

```sh
flyctl deploy --remote-only --config fly.toml
```

`SYNC_DB_FILE` is optional. By default the SQLite database is
`$CLOUD_VAULT_DIR/sync.sqlite`.

## Sync API

All sync requests use the same signed envelope as the vault:
`{ payload: stableJsonString, signature: base64Ed25519 }`. The payload includes
`v`, `op`, `accountId`, `publicKeyB64`, `deviceId`, `timestamp` and `nonce`.
Pull requests also include `ownerProfileId`, keeping several profiles derived
from one seed isolated while sharing one account cursor namespace on the server.

- `POST /v1/sync/:accountId/push` accepts up to 100 encrypted mutations.
- `POST /v1/sync/:accountId/pull` returns up to 100 mutations after `cursor`.
- `POST /v1/sync/:accountId/devices` lists registered devices, coarse Cloudflare
  country/city metadata and client-reported model/OS/app version.
- `POST /v1/sync/:accountId/devices/revoke` revokes another device.
- `POST /v1/sync/:accountId/username/claim` takes `@name` for `ownerProfileId`,
  `.../username/release` gives it back, and the unsigned
  `GET /v1/username/:name` answers only `taken` — never the owner, because the
  account id is the address of that account's storage.

Username rules are enforced here, not only on the screen: a rebuilt client must
not be able to take `support`. Names reserved for the app (`reserved-usernames.js`,
mirrored from the client and checked by a test) are refused outright, with one
exception. A claim may carry `badge`: an Ed25519 grant, signed by a key whose
public half lives in `official-badge.js`, whose payload names the `did` of the
account and the single `username` it unlocks. The grant is part of the signed
payload, so it cannot be swapped in transit, and it is verified against the
did:key of `accountPublicKeyB64` — the grant travels to contacts inside profile
envelopes in the clear, so without that binding anyone who received one could
present it as their own. A grant for `founder` does not unlock `support`.

Mutation delivery is idempotent by `mutationId`. Per-entity revisions reject
stale writes; the revision key includes `ownerProfileId`, so two local profiles
cannot block one another. Deletes are retained as tombstones so a device that
was offline can converge instead of resurrecting old data. Every signed
request nonce is single-use for the validity window, which prevents captured
`push`, `revoke` and vault requests from being replayed.

In v1 the registered device public key is required to equal the Ed25519 key
that signs the request. This keeps the registry honest until a separate device
enrollment flow is introduced.

Session geo is deliberately coarse: the service stores only the normalized
`CF-IPCountry` and optional `CF-IPCity` headers. It does not store the source IP,
coordinates or a location history. Existing SQLite databases receive the six
session metadata columns on service startup.

Point the app at the service in one of two places.

At build time, with `EXPO_PUBLIC_CLOUD_VAULT_URL`. `assets/config.json` in git
carries a placeholder host on purpose, so a build that is not given this
variable talks to nowhere and the feature stays off. The variable answers
"where", not "whether": `cloudBackup.enabled` still comes from the file.

```sh
EXPO_PUBLIC_CLOUD_VAULT_URL=https://cloud.example.com npx expo start
```

At runtime, with the override file, which wins over the build-time value —
someone running their own vault keeps their own choice:

```json
{
  "cloudBackup": {
    "enabled": true,
    "baseUrl": "https://cloud.example.com"
  }
}
```

The app must use HTTPS. The mobile projection sends changed encrypted rows for
messages, conversations, groups, profile settings, feed posts/comments and
tombstones. The service does not receive media plaintext or media keys. New
media ciphertext can be stored and fetched with the signed
`POST /v1/sync/:accountId/media/put` and `media/get` endpoints. Files are stored
outside SQLite under the account's opaque blob id, with a default 512 MiB
per-account quota and an 8.1 MB per-blob limit; override the account quota with
`MEDIA_MAX_ACCOUNT_BYTES`. Legacy relay-only references remain supported. The
service has no password reset path by design: a lost cloud password means the
encrypted cloud copy cannot be decrypted.

## Environment

`USERNAME_REGISTRY_PEPPER` — secret behind the username registry's blind index
(v4.32.557). Usernames are stored as `HMAC(pepper, name)`, never in the clear,
so a leaked database file yields no list of who is who. Set it to at least 32
characters and keep it in the platform's secret store, outside the database
file:

```
fly secrets set USERNAME_REGISTRY_PEPPER="$(openssl rand -hex 32)" -a airchat-cloud-vault
```

Without the variable the server generates a pepper on first start and keeps it
in `sync_meta`. That still removes plaintext names, but the secret then travels
with the database — a full dump allows an offline dictionary attack over the
(small) username space. The startup path records which of the two is in effect.

**The pepper is not rotatable in place.** Changing it orphans every existing
claim: the server would report every taken name as free, and two people could
end up holding the same one. Rotating means re-deriving the whole table from
names the server does not have. Set it once, before the registry has rows.

`SYNC_MAX_ACTIVE_DEVICES` — ceiling on simultaneously active devices per
account (default 8). Independent of it, enrolling a *new* device is capped at 3
per hour per account and every enrollment is written to `sync_device_enrollments`,
which survives revoking the device. `POST /v1/sync/:accountId/devices` returns
that trail next to the device list: an enrollment with no matching device is how
the owner learns that someone used their seed phrase and cleaned up after
themselves.
