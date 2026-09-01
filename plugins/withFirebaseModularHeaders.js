/**
 * Expo config plugin — restore the scoped `:modular_headers => true` block that
 * Firebase needs on iOS, so it survives a clean `expo prebuild` (which
 * regenerates ios/Podfile from scratch and would otherwise drop the manual
 * edit; ios/ is gitignored).
 *
 * Why scoped and not a global `use_modular_headers!`:
 *   FirebaseCoreInternal needs GoogleUtilities to expose Clang module maps so it
 *   can integrate as a static lib. A GLOBAL use_modular_headers! instead breaks
 *   ExpoModulesCore symbol visibility (expo-image-picker fails with
 *   "cannot find 'EXFatal' in scope"). So we opt in only the Firebase chain.
 *
 * Idempotent: if the block (matched by MARKER) is already present, it's a no-op.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# --- withFirebaseModularHeaders ---';
const BLOCK = `
  ${MARKER}
  # Firebase (FirebaseCoreInternal) needs GoogleUtilities to expose module maps
  # to integrate as a static lib. Scope modular_headers to just that chain —
  # a GLOBAL use_modular_headers! breaks ExpoModulesCore symbol visibility
  # (expo-image-picker: "cannot find 'EXFatal' in scope").
  pod 'GoogleUtilities', :modular_headers => true
  pod 'FirebaseCoreInternal', :modular_headers => true
  pod 'FirebaseCore', :modular_headers => true
  pod 'GoogleDataTransport', :modular_headers => true
  pod 'nanopb', :modular_headers => true
`;

module.exports = function withFirebaseModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let src = fs.readFileSync(podfile, 'utf8');
      if (src.includes(MARKER)) return cfg; // already injected
      // Insert right after `use_expo_modules!` inside the app target.
      const anchor = /(\n\s*use_expo_modules!\s*\n)/;
      if (!anchor.test(src)) {
        throw new Error(
          '[withFirebaseModularHeaders] could not find `use_expo_modules!` anchor in Podfile',
        );
      }
      src = src.replace(anchor, `$1${BLOCK}`);
      fs.writeFileSync(podfile, src, 'utf8');
      return cfg;
    },
  ]);
};
