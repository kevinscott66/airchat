# OpenFlux core

Place `arm64-v8a/libopenflux.so` here: the OpenFlux Go core built for Android with the `mobile` tag. The generated C API header is placed in `../cpp/include/libopenflux.h` for compiling the JNI wrapper.

The 12 MB binary is reproducible from core source and excluded by `.gitignore`. Build locally:

```sh
bash scripts/build-openflux-android.sh
```

Requires Go and the Android NDK. The default core source is `~/programs/OpenFlux`; override with `OPENFLUX_SRC`.

Without this file, the application build stops at `checkOpenFluxCore` with the same instructions. The module deliberately cannot download a prebuilt core: an unverified binary would undermine the tunnel's trust boundary.

Only arm64-v8a is built. On x86_64 emulators, the tunnel returns `isSupported() === false`.
