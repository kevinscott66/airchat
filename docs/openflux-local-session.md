# Local Yandex session on iOS

AirChat uses its own embedded OpenFlux core and does not require the Agent app. Ordinary settings expose one OpenFlux switch. The existing build configuration supplies the document endpoint; never commit the actual document link or a user's credentials.

On explicit enable, iOS 17+ opens its dedicated Yandex browser if no matching local session exists. An explicit retry renews it. Automatic startup, network recovery and Agent bridge commands never present login. Only the settings enable/retry actions pass the explicit session option. Cancellation does not start the core. The browser supports separate login and document actions and limits top-level navigation to HTTPS Yandex RU; editor subframes have a separate narrow allowlist.

Cookies and browser user agent are captured natively, bound to the configured document, and stored in device-only, non-synchronizable Keychain. JS receives only a boolean. OpenFluxStartWithBrowserSession imports the local session before connecting and bypasses legacy global cookie files and automatic solver configuration. Authentication cookies use a domain-aware jar, including during WebSocket handshake; they are not copied to editor .net hosts.

Build the OpenFlux xcframework with scripts/build-openflux-ios.sh before pod install. The source dependency is the OpenFlux checkout at `7b837b7358efc2751abff3c2fae4b50ee01d0555`, recorded in `scripts/openflux-ios-revision`. Set `OPENFLUX_SRC` to that checkout. This is a local fork revision, not an upstream release; obtain the preserved fork source before building on another machine. Upstream `ba31d0f` (2026-10-04) removed the C exports used here and cannot replace this dependency directly. A prebuilt old core is not compatible with this integration. Android's existing transport remains unchanged; the new manual browser UI is iOS-only. Web cannot run the native tunnel.

Opening the document or starting SOCKS does not establish end-to-end availability. A fresh-device login and real message delivery over the tunnel remain release acceptance checks. No owner session is bundled in the app.

`scripts/build-release.sh` rebuilds an existing embedded OpenFlux library from the
configured local source before packaging Android or iOS. Its iOS archive also
cleans build products so CocoaPods cannot reuse an older copied static archive.
If no embedded library is present, the existing build without a tunnel remains
available. Direct Xcode or Gradle builds require an explicit core rebuild first;
after replacing the iOS xcframework, clean build products before relinking.
Changing the app version or rebuilding JavaScript does not refresh the Go core.

The separate system VPN prototype is not part of this app-scoped integration: its bridge is not wired to the native module and it needs its own Network Extension provisioning and device acceptance.

For simulator runtime checks, build with `ARCHS=arm64 CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES` so Xcode generates simulator Keychain entitlements. An unsigned build can compile successfully but fail SecureStore access at startup. This is simulator signing, not a device distribution signature.

The document address is build configuration, not an account session. Native clients necessarily contain the configured address. Web selects `src/core/openFluxDocument.web.ts` and receives no document address; the actual export is checked by `scripts/check-web-config.js`. CI exports with a synthetic address to catch accidental reintroduction. Local cookies and Keychain session data remain native.

Controller start/stop mutations are serialized. Disabling invalidates pending authorization and retry work immediately; if a native start finishes late, it is stopped before a newer mutation runs. A retry cannot start over an unconfirmed stop. These are controller ordering guarantees; they do not replace physical-device login and delivery acceptance.

iOS registers the same proxy configuration provider for React Native HTTP and
`expo/fetch`, which owns a separate lazy URLSession. The Expo public extension
is registered on the main thread during OpenFlux module preparation, before
attachment requests begin. This keeps bounded, redirect-rejecting media requests
on the existing app routing path. Actual tunnel delivery remains a device check.

Native builds can migrate a retired factory document with
`EXPO_PUBLIC_OPENFLUX_PREVIOUS_DOC_URLS`, a JSON array supplied privately at build
time, together with the current `EXPO_PUBLIC_OPENFLUX_DOC_URL`. Only an exact
match to an allowlisted previous URL is replaced, and only when the current URL
is nonempty and different. Custom documents, `enabled`, `autoStart`, and other
settings remain unchanged. Missing or invalid allowlists do nothing. Loading is
read-only: the effective migration repeats after restart; the next explicit
settings save persists it through the existing recoverable override replacement.
An unreadable override is never overwritten. Keep the previous URL allowlist in
subsequent native builds until affected installations have saved their settings.
The web shim returns an empty allowlist, and CI checks an export containing
synthetic current and previous build inputs for leaked native document URLs.

The official repository was checked on 24 October 2026. Its latest published
stable release is [v0.13.0](https://github.com/p1neappleXpress/OpenFlux/releases/tag/v0.13.0),
commit 4f9c786cdd1d9fcd0c133e2e0fec0c5a12522610. Its mobile API uses the shared
packet/Session stack, with negotiated framing and recovery; AirChat's preserved
C bridge and classic fork cannot be replaced by that binary without adaptation
and client/exit interoperability checks. A running local SOCKS listener does not
prove a carrier handshake or an exit round trip. Compare the native build and
effective saved document against the active exit before attributing an outage
to the core version; never print document URLs or copy account sessions.
