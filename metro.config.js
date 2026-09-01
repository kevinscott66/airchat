// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: конфиг разрешает node:* полифиллы, firebase, @expo/vector-icons и
//          задаёт cacheVersion для изоляции кешей между версиями.
// Metro cannot resolve Node built-ins like `node:process` (used by libp2p/helia).
//
// Офлайн без Metro: в release-сборках (`expo run:android --variant release`, AAB/APK) JS-бандл
// встроен в приложение; Metro нужен только в dev. Не подменяйте /index.bundle — это ломает dev.
// Map `node:*` specifiers to browser/RN-friendly polyfills.
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// ─── Изолированный кеш Metro per-version ─────────────────────────────────────
// Каждая версия приложения получает собственный подкаталог кеша.
// Это исключает смешивание модулей старых и новых версий при сборке.
const APP_VERSION = require('./package.json').version;
config.cacheVersion = APP_VERSION;
config.cacheStores = [];   // сброс — Metro создаёт свой дефолтный под новым cacheVersion
// ─────────────────────────────────────────────────────────────────────────────

if (!config.resolver.assetExts.includes('db')) {
  config.resolver.assetExts.push('db');
}

// expo-asset (pulled in via expo/Expo.fx) imports `expo-constants`; ensure Metro resolves it from the app root.
// @expo/vector-icons: hoisted to root — Metro must not resolve to missing expo/node_modules/@expo/vector-icons (ENOENT on package.json).
// Local native modules live in main repo's /modules
// release-v4.30 is at ~/airchat/release-v4.30/ — main repo is one level up.
// Fallback: if ../modules doesn't exist, try the .claude/worktrees layout (../../..+/modules).
const MAIN_REPO_CANDIDATE1 = path.resolve(__dirname, '..');
const MAIN_REPO_CANDIDATE2 = path.resolve(__dirname, '../../..');
const MAIN_REPO = fs.existsSync(path.join(MAIN_REPO_CANDIDATE1, 'modules'))
  ? MAIN_REPO_CANDIDATE1
  : MAIN_REPO_CANDIDATE2;
const MODULES_DIR = path.join(MAIN_REPO, 'modules');

// node_modules: use worktree's own or fall back to adoring-poitras sibling worktree.
const ADORING_POITRAS_MODULES = path.resolve(__dirname, '../.claude/worktrees/adoring-poitras/node_modules');
const OWN_MODULES = path.resolve(__dirname, 'node_modules');
const NODE_MODULES_DIR = fs.existsSync(OWN_MODULES) ? OWN_MODULES : ADORING_POITRAS_MODULES;

if (!config.watchFolders) config.watchFolders = [];
if (fs.existsSync(MODULES_DIR)) { config.watchFolders.push(MODULES_DIR); }
if (NODE_MODULES_DIR !== OWN_MODULES && fs.existsSync(NODE_MODULES_DIR)) {
  config.watchFolders.push(NODE_MODULES_DIR);
}

config.resolver.nodeModulesPaths = [NODE_MODULES_DIR];

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'expo-constants': path.join(NODE_MODULES_DIR, 'expo-constants'),
  '@expo/vector-icons': path.join(NODE_MODULES_DIR, '@expo/vector-icons'),
  'airchat-vpn': path.join(MODULES_DIR, 'airchat-vpn'),
};

const nodePolyfills = {
  process: 'process/browser',
  buffer: 'buffer/',
  stream: 'readable-stream',
  util: 'util',
  events: 'events',
  path: 'path-browserify',
  os: 'os-browserify',
};

const origResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Явный entry: иногда цепочка Expo resolvers не находит пакет в Haste (UnableToResolveError на устройстве).
  if (moduleName === '@expo/vector-icons') {
    const entry = path.join(NODE_MODULES_DIR, '@expo/vector-icons/build/IconsLazy.js');
    if (fs.existsSync(entry)) {
      return { type: 'sourceFile', filePath: entry };
    }
  }

  // @react-native-firebase: Metro may resolve the "source" condition to `lib/*.ts`, which then
  // resolves deep imports to `@react-native-firebase/app/lib/internal/...` — not listed in
  // package.json `exports`. Map those to the published `dist/module/...` files.
  const rnfbLib = '@react-native-firebase/app/lib/';
  if (moduleName.startsWith(rnfbLib)) {
    let rest = moduleName.slice(rnfbLib.length).replace(/\.(ts|tsx|js)$/, '');
    const distPath = path.join(NODE_MODULES_DIR, '@react-native-firebase/app/dist/module', `${rest}.js`);
    if (fs.existsSync(distPath)) {
      return { type: 'sourceFile', filePath: distPath };
    }
  }

  if (moduleName.startsWith('node:')) {
    const id = moduleName.slice('node:'.length);
    const mapped = nodePolyfills[id];
    if (mapped) {
      if (origResolveRequest) {
        return origResolveRequest(context, mapped, platform);
      }
      return context.resolveRequest(context, mapped, platform);
    }
  }
  if (origResolveRequest) {
    return origResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

const origEnhance = config.server?.enhanceMiddleware;
config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    const inner = origEnhance ? origEnhance(middleware) : middleware;
    return (req, res, next) => {
      if (process.env.NODE_ENV === 'production') {
        res.setHeader('X-React-Native-Dev-Support', 'false');
      }
      return inner(req, res, next);
    };
  },
};


// Polyfill for browser Event/EventTarget — required by @libp2p/* on Hermes
const origGetPolyfills = config.serializer && config.serializer.getPolyfillModulePaths;
config.serializer = {
  ...config.serializer,
  getPolyfillModulePaths: () => {
    const base = origGetPolyfills ? origGetPolyfills() : [];
    const polyfillPath = path.resolve(__dirname, 'polyfills/event-polyfill.js');
    return fs.existsSync(polyfillPath) ? [...base, polyfillPath] : base;
  },
};

module.exports = config;
