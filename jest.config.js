// Jest config for the v432 app. Uses the jest-expo preset (already installed)
// so TS/TSX + React Native + Expo modules transform correctly.
//
// This is the full project checkout (local node_modules present), so rootDir is
// the project directory and tests are discovered under src/.
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Потолок на один тест — тридцать секунд вместо пяти по умолчанию
  // (v4.32.827).
  //
  // Потолок меряется настоящими часами, а тесты гонки сидят на поддельных: их
  // собственное время не идёт вовсе, и пять секунд там взяться неоткуда. Зато
  // прогон целиком — семьсот с лишним наборов разом, — и на всплеске нагрузки
  // набор, который в одиночку укладывается в три секунды, растягивается втрое
  // и больше. Один такой всплеск уронил callStartRace740 на полном прогоне, а
  // двадцать пять запусков того же набора по отдельности прошли подряд.
  //
  // Тридцать секунд не прячут зависание: висящий тест всё равно падает, просто
  // сообщает об этом позже. А красное на ровном месте делает бессмысленным
  // любой полный прогон.
  testTimeout: 30_000,
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/', '/.claude/'],
  // Каталоги, которые нельзя даже обходить. testPathIgnorePatterns прячет
  // только сами тесты, а карту модулей haste строит по всему дереву — и
  // спотыкается о копии.
  //   .claude/worktrees — рабочие копии репозитория целиком, лежащие внутри
  //     него же. Без этой строки jest считает каждую копию отдельным деревом:
  //     сюит становится втрое больше, каждый модуль дублируется, и сотни сюит
  //     падают на _assertNoDuplicates вместо своей настоящей проверки.
  //   ios/, android/ — после pod install и prebuild там появляются копии
  //     package.json из Pods и node_modules.
  modulePathIgnorePatterns: [
    '<rootDir>/.claude/',
    '<rootDir>/ios/',
    '<rootDir>/android/',
  ],
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
