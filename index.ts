// Веб-рантайм Metro: HMR, обработчик отказов промисов и мост к dev-серверу.
// На ios/android разрешается в native-заглушку самого пакета и ничего не делает,
// поэтому импорт общий, а не за Platform-веткой.
import '@expo/metro-runtime';
import './src/bootstrap-logbox';
import './polyfill-event-target';
import 'react-native-gesture-handler';
import './src/firebaseMessagingBackground';
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import process from 'process';
import React from 'react';
import { initFileLogging } from './src/core/fileLogSink';

if (!__DEV__) {
  // Сохраняем до no-op: logger.ts шлёт маркеры e2e в adb (ReactNativeJS), иначе grep пустой.
  const g = globalThis as unknown as {
    __airchatOrigConsoleLog?: (msg: string) => void;
    __airchatOrigConsoleInfo?: (msg: string) => void;
  };
  g.__airchatOrigConsoleLog = console.log.bind(console);
  g.__airchatOrigConsoleInfo = console.info.bind(console);
  // eslint-disable-next-line no-console
  console.log = () => {};
  // eslint-disable-next-line no-console
  console.info = () => {};
  // eslint-disable-next-line no-console
  console.warn = () => {};
  // eslint-disable-next-line no-console
  console.debug = () => {};
  // eslint-disable-next-line no-console
  console.error = () => {};
  try {
    (console as { disableYellowBox?: boolean }).disableYellowBox = true;
  } catch {
    /* older RN / Hermes may ignore */
  }
}

void initFileLogging().then(() => {
  log.info('boot_trace', { step: 'index_after_all_imports' });
});

if (typeof globalThis !== 'undefined' && (globalThis as { Buffer?: unknown }).Buffer == null) {
  (globalThis as { Buffer: typeof Buffer }).Buffer = Buffer;
}
if (typeof globalThis !== 'undefined' && (globalThis as { process?: unknown }).process == null) {
  (globalThis as { process: typeof process }).process = process;
}
import { View } from 'react-native';

// После react-native: иначе requireOptionalNativeModule('ExpoSplashScreen') → runtime not ready.
import './src/splashGate';

import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import './src/i18n';
import App from './src/App';
import { AppErrorBoundary } from './src/ui/AppErrorBoundary';
import { log } from './src/core/logger';
import { darkColors } from './src/ui/theme';
import { installWebFocusRing } from './src/ui/webFocusRing';
import { installMotionPrefs } from './src/ui/motionPrefs';

if (__DEV__) {
  // eslint-disable-next-line no-console
  console.log('[App] File loaded');
}

function Root(): React.ReactElement {
  // Root is outside ThemeProvider, so use the same default token as the
  // pre-theme error/loading surfaces instead of duplicating a hex literal.
  const bootstrapBackground = darkColors.background;
  return React.createElement(
    SafeAreaProvider,
    { style: { flex: 1, backgroundColor: bootstrapBackground } },
    React.createElement(
      View,
      { style: { flex: 1, backgroundColor: bootstrapBackground } },
      React.createElement(AppErrorBoundary, null, React.createElement(App, null))
    )
  );
}

installWebFocusRing();
installMotionPrefs();

registerRootComponent(Root);
