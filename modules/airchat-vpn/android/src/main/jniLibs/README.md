# Native Xray core

`libairchat_xray.so` (arm64-v8a, x86_64) is a compiled build of the Xray core
used by the VPN transport. The binaries are ~73 MB combined and are not
committed here; supply them for both ABIs before running `assembleRelease`, or
the Gradle jniLibs packaging step will fail.
