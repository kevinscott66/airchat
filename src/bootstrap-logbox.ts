/**
 * Должен быть первым импортом в entry (index.ts), до Firebase и прочих модулей.
 *
 * Нельзя использовать `import { LogBox } from 'react-native'` в этом файле: при первом импорте
 * `react-native` вызывается `LogBox.install()` (setUpDefaultReactNativeEnvironment) ещё до тела
 * модуля, и первый warn может попасть в LogBox без ignore-паттернов. Поэтому сначала
 * регистрируем паттерны на LogBoxData, затем подключаем фасад LogBox через require пути.
 */
import { pinFuseboxMigrationBannerOff } from './bootstrap-fusebox-global';

pinFuseboxMigrationBannerOff();

const LOGBOX_IGNORE: (string | RegExp)[] = [
  'Open debugger to view warnings.',
  /Open debugger to view warnings/i,
];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const LogBoxData = require('react-native/Libraries/LogBox/Data/LogBoxData') as {
  addIgnorePatterns: (patterns: readonly (string | RegExp)[]) => void;
  setDisabled: (value: boolean) => void;
  clear?: () => void;
};

LogBoxData.addIgnorePatterns(LOGBOX_IGNORE);
LogBoxData.setDisabled(true);
LogBoxData.clear?.();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const LogBox = require('react-native/Libraries/LogBox/LogBox').default as {
  ignoreLogs: (patterns: readonly (string | RegExp)[]) => void;
  ignoreAllLogs: (value?: boolean | null) => void;
  clearAllLogs?: () => void;
};

LogBox.ignoreLogs(LOGBOX_IGNORE);
LogBox.ignoreAllLogs(true);
LogBox.clearAllLogs?.();
