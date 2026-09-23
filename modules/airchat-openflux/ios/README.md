# OpenFlux core for iOS

Place `OpenFlux.xcframework` here: the OpenFlux Go core built with the `mobile` tag as static archives for iPhone and simulator. The adjacent C API header, `OpenFluxCoreAPI.h`, is **handwritten**. Unlike Android, it is tracked rather than generated so a fresh clone can build without the core.

The 29 MB xcframework is generated from core source and excluded by `.gitignore`. Build it locally:

```sh
bash scripts/build-openflux-ios.sh
```

Requires Go and full Xcode, not just Command Line Tools. The default core source is `~/programs/OpenFlux`; override with `OPENFLUX_SRC`.

**Build before `pod install`.** `AirChatOpenFlux.podspec` includes the core only if the xcframework exists when pods are installed. If built later, reinstall:

```sh
bash scripts/build-openflux-ios.sh
npx expo prebuild -p ios
```

Without the core, the app still builds and runs; the tunnel returns `isSupported() === false` and appears unavailable in settings. The same applies on iOS 16 and earlier: traffic interception requires Network.framework APIs from iOS 17.

Only arm64 is supported, not 32-bit iPhones or Intel simulators. The module deliberately cannot download a prebuilt core: an unverified binary would undermine the tunnel's trust boundary.
