# Exported web acceptance

`node e2e/web/run.js /path/to/export` checks anonymous startup, accessibility,
phone-width overflow and the restore screen. It creates no account.

`NTFY_BIN=/absolute/path/to/ntfy node e2e/web/two-clients.js /path/to/export`
exercises two separate temporary Chrome profiles against real local cloud-vault,
signaling and ntfy services. Install the server dependencies first. Node 22,
Chrome, OpenSSL and an ntfy executable with the `serve` command are required.
The official macOS client-only binary does not provide that server command.
No API key or existing account is needed: both fixture accounts are created in
the browser onboarding flow and sign their own requests.

The harness copies the export to a temporary directory and replaces the known
service URL literals with loopback HTTPS proxies. The original export and
application source configuration are unchanged. The isolated Chrome profiles accept the fixture's self-signed HTTPS for this
run; no browser-wide trust setting is changed. Non-loopback HTTP requests
are denied through DevTools; a dead local proxy and resolver rules also prevent
external browser connections. The harness never uses production services to
create accounts or deliver messages. All fixture databases, browser profiles,
certificates and copied assets are removed on normal success or failure.

This is a desktop web test. It does not establish native OpenFlux availability,
Yandex browser-session integration, iOS provisioning, background Apple Push,
real microphone quality or delivery over restrictive external networks.

## Public-site manual acceptance, 24 October 2026

The published website reported version 4.32.1001 in both Safari and the Codex
in-app browser. Two fresh test accounts were created through onboarding; their
public contact links were exchanged. A distinct message sent once from Codex
was visibly received in Safari, and a reply sent once from Safari was visibly
received in Codex. This is evidence of first-send delivery on the published
version; it is separate from the local two-client harness above.

Safari private browsing failed before onboarding with a database-open startup
error. A fresh ordinary Safari window was anonymous, loaded successfully and
was used for the messaging test. Do not describe private browsing as supported
or suggest competing tabs were proven to cause this failure.

Opening the text chat in Safari prompted microphone access before any recording
or call action. Access was denied and text messaging still worked. This finding
has a source fix and needs a later published-build retest.

Both browsers were then reloaded. Each restored its own fixture account and
both original message bubbles without re-entering credentials. A new Codex-to-
Safari marker was sent once and visibly received in Safari after reload.
Safari then sent one new reply, which was visibly received in Codex. The microphone prompt repeated on reopening the
Safari chat after reload.

Safari's Security → Active sessions loaded one server-backed row with its
recognizable browser name/version, a current-device badge, application version
and recent activity. The operating-system label is derived from the browser's
user agent and the region from network information; they are not authoritative
hardware identity or physical location. The test used two different accounts,
so it does not establish same-account multi-device restoration/revocation.

Further public UI checks:

- The post-reload Safari reply was visibly received in Codex (parent browser
  verification), completing bidirectional delivery after both reloads.
- A personal text news post from Codex appeared in Safari with its author and
  exact body. The comment count updated to one.
- A second post labelled as a blue-image media test reached Safari, but the
  observed card was text-only. Image delivery is not counted as verified.
- Safari saved the fixture profile status and biography; both appeared after
  Save and profile completeness updated.
- Creating an explicit channel succeeded and its first post appeared. However,
  the timeline exposed the creator's profile name in both the creation event
  and the post's author label, with an owner badge. Channel settings defaulted
  “Hide sender names” to off. The invitation payload also includes the personal
  admin/member public keys. This does not satisfy administrator anonymity.
- Safari accessibility exposed each news card as a single button; the visible
  reaction, comment, bookmark and share controls were absent as separate AX
  elements. Their visual presence is not proof of screen-reader accessibility.

An ordinary group was created separately from the channel, with the Codex test
contact selected and two participants displayed. Both clients visibly received
the other client's exact group message, sent once. A newly subscribed channel
client's historical-message delivery was not established.

| Public-site scenario | Result |
| --- | --- |
| Fresh Safari and Codex accounts, first-send DM both ways | PASS |
| Both reload, restore account/history, new DM both ways | PASS |
| Safari current browser session label and badge | PASS |
| Profile status and biography save | PASS |
| Personal news text received by second browser | PASS |
| Ordinary group create and messages both ways | PASS |
| Channel administrator identity hidden | FAIL: personal author/system-event labels |
| Channel file upload (synthetic PNG) | FAIL: upload error, no attachment bubble |
| News image delivered | FAIL: received text-only card |
| Microphone requested only by explicit recording/call | FAIL: text chat triggered permission prompt |
| Safari private browsing startup | FAIL: database initialization error |
| News nested controls independently accessible | FAIL: card flattens accessibility children |
| Same-account device restore/revoke, native calls/push/OpenFlux | NOT TESTED |

The local harness exposed a genuine enrollment validation mismatch: an unknown
web user agent supplies an empty optional OS version, while the server rejected
that metadata despite a valid signature. The server now accepts an empty string
while retaining type and maximum-length validation. With that fix, two real
local accounts enrolled, both session panels displayed the current device, the
server persisted distinct account/device IDs, and the second browser received
messages in both directions through real local ntfy. The coherent export from
commit `89cc797` also passed account/history restoration after reload, a new
message after reload, a document uploaded and received through the UI, and a
news photo received by the second browser with its decoded blue pixel checked.
Composer and horizontal-overflow bounds passed at 1043×988, 390×640 and 700×400.
The subsequent resize export passed exact visible-message bounds and an actual
inverted-list history offset test: offset 249 before increasing viewport height
by 20 pixels became 229, rather than jumping to newest offset zero.

The download probe identified two transport defects, now fixed in source: private
web attachments selected a local-only Helia CID, and the encrypted ntfy upload
set `Cache: no`, leaving no cache entry required by ntfy's download handler.
The secure acceptance export passed a real attachment PUT and GET, received the
document in the second browser, and downloaded bytes identical to the original.
It did not navigate to an IPFS gateway. Photo news also reached the second
browser and passed decoded pixel verification.

Harmless HTML-shaped messages and news posts are tested only against isolated
local services. Each is received as literal text, without injected image/script
nodes or execution of its inert marker. The targeted news security scenario is
available through `--news-security-only`.

The test waits for transient in-app notification banners to disappear before
asserting message contents or clicking a document. A notification preview is
not proof that the actual chat bubble is rendered. Optional
`AIRCHAT_E2E_SCREENSHOT=/absolute/path.png` retains the 700×400 layout screenshot;
otherwise fixture files are cleaned up.

`--groups-only` runs the role/grant UI scenario after creating the two accounts
and reciprocal contacts. It creates an ordinary group, checks the member's
missing anonymous option, exercises the owner's self grant, promotes the other
account, grants and revokes its anonymous posting permission, and checks the
receiver's displayed author. It never fabricates signed grants or writes roles
directly into storage. The default complete run includes this scenario after
media checks. The current source export passed this complete role/grant scenario
through real UI actions. Promotion alone did not grant anonymous posting; grant
and revoke changed the available composer choice and received author label.
Revocation preserved the identity shown on an existing anonymous message.
These checks establish current-client display behavior, not cryptographic
unlinkability of authenticated administrators or old-client live-sync behavior.

## Current combined-run limitation

The latest secure export passed accounts/devices, bidirectional DM, reload,
viewport/history, byte-exact encrypted document download, news photo pixels,
and literal HTML-shaped DM/news checks in one run. Its group portion passed
member restrictions and owner self-grant/anonymous posting, then the new
physical-click helper timed out hit-testing the “Подтвердить” administrator
promotion confirmation. The earlier groups-only scenario passed all role/grant
assertions using DOM click activation. This mismatch is an unresolved harness
locator/hit-testing limitation, not evidence that promotion fails for a user.
The default combined command currently exits nonzero and must not be enabled as
a required CI check until its confirmation target is validated with a captured
DOM/screenshot and the complete physical-click scenario passes.
