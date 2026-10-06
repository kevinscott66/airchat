# Local Yandex session on iOS

AirChat uses its own embedded OpenFlux core and does not require the Agent app. Ordinary settings expose one OpenFlux switch. The existing build configuration supplies the document endpoint; never commit the actual document link or a user's credentials.

On explicit enable, iOS 17+ opens its dedicated Yandex browser if no matching local session exists. An explicit retry renews it. Automatic startup, network recovery and Agent bridge commands never present login. Only the settings enable/retry actions pass the explicit session option. Cancellation does not start the core. The browser supports separate login and document actions and limits top-level navigation to HTTPS Yandex RU; editor subframes have a separate narrow allowlist.

Cookies and browser user agent are captured natively, bound to the configured document, and stored in device-only, non-synchronizable Keychain. JS receives only a boolean. OpenFluxStartWithBrowserSession imports the local session before connecting and bypasses legacy global cookie files and automatic solver configuration. Authentication cookies use a domain-aware jar, including during WebSocket handshake; they are not copied to editor .net hosts.

Build the OpenFlux xcframework with scripts/build-openflux-ios.sh before pod install. The source dependency is the OpenFlux checkout at `7b837b7358efc2751abff3c2fae4b50ee01d0555`, recorded in `scripts/openflux-ios-revision`. Set `OPENFLUX_SRC` to that checkout. This is a local fork revision, not an upstream release; obtain the preserved fork source before building on another machine. Upstream `ba31d0f` (2026-10-04) removed the C exports used here and cannot replace this dependency directly. A prebuilt old core is not compatible with this integration. Android's existing transport remains unchanged; the new manual browser UI is iOS-only. Web cannot run the native tunnel.

Opening the document or starting SOCKS does not establish end-to-end availability. A fresh-device login and real message delivery over the tunnel remain release acceptance checks. No owner session is bundled in the app.

The separate system VPN prototype is not part of this app-scoped integration: its bridge is not wired to the native module and it needs its own Network Extension provisioning and device acceptance.

For simulator runtime checks, build with `ARCHS=arm64 CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES` so Xcode generates simulator Keychain entitlements. An unsigned build can compile successfully but fail SecureStore access at startup. This is simulator signing, not a device distribution signature.

The document address is build configuration, not an account session. Native clients necessarily contain the configured address. Web selects `src/core/openFluxDocument.web.ts` and receives no document address; the actual export is checked by `scripts/check-web-config.js`. CI exports with a synthetic address to catch accidental reintroduction. Local cookies and Keychain session data remain native.
