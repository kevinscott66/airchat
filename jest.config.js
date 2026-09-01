// Jest config for the v432 app. Uses the jest-expo preset (already installed)
// so TS/TSX + React Native + Expo modules transform correctly.
//
// This is the full project checkout (local node_modules present), so rootDir is
// the project directory and tests are discovered under src/.
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
  // `multiformats` ships an exports map with only an `import` (ESM) condition —
  // no `require` — so jest's CommonJS resolver can't find its subpaths. Map them
  // to the built ESM files and let the transform (below) compile them to CJS.
  moduleNameMapper: {
    '^multiformats$': '<rootDir>/node_modules/multiformats/dist/src/index.js',
    '^multiformats/(.*)$': '<rootDir>/node_modules/multiformats/dist/src/$1.js',
  },
  // jest-expo's default ignores all node_modules. Extend the allowlist with the
  // ESM-only packages our code imports (@noble/curves, @noble/hashes, multiformats)
  // so jest transforms them instead of choking on `import` statements.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@noble|multiformats))',
  ],
};
