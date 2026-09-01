// Eagerly resolve Expo's "winter" runtime lazy globals.
//
// jest-expo installs WinterCG polyfills (TextDecoder, URL, structuredClone, …)
// as LAZY global getters that `require()` their implementation on first access.
// In jest that first access often happens deep inside a test, after the module
// graph is sealed, which throws "import a file outside of the scope of the test
// code". Touching each global HERE (during setup, where requiring is allowed)
// forces the require eagerly so later accesses hit a resolved value.
const winterGlobals = [
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoderStream',
  'URL',
  'URLSearchParams',
  '__ExpoImportMetaRegistry',
  'structuredClone',
];
for (const name of winterGlobals) {
  try {
    // Reading the property triggers the lazy getter -> eager require.
    void globalThis[name];
  } catch {
    // Some polyfills may be absent on a given platform; ignore.
  }
}
