// ESLint 8 config for the v432 app (eslintrc format).
// Non-type-aware (no parserOptions.project) for speed; tsc already covers types.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  env: { es2022: true, node: true, browser: true },
  ignorePatterns: [
    'node_modules/',
    'android/',
    'ios/',
    'modules/',
    'babel.config.js',
    'jest.config.js',
    'jest.setup.js',
    '.eslintrc.js',
    '*.config.js',
  ],
  rules: {
    // Pragmatic severities: surface real issues without drowning in noise.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    '@typescript-eslint/no-require-imports': 'off', // RN/Expo lazy require() pattern
    '@typescript-eslint/no-var-requires': 'off', // deliberate lazy native-module require()
    '@typescript-eslint/ban-ts-comment': 'warn',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-constant-condition': ['error', { checkLoops: false }],
  },
};
