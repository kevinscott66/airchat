// Имена обязаны начинаться с `mock`: babel-plugin-jest-hoist поднимает
// jest.mock() выше объявлений, и ссылаться из factory можно только на
// переменные с этим префиксом (иначе ReferenceError на out-of-scope variable).
const mockAddIgnorePatterns = jest.fn();
const mockSetDisabled = jest.fn();
const mockClear = jest.fn();
const mockIgnoreAllLogs = jest.fn();
const mockIgnoreLogs = jest.fn();
const mockClearAllLogs = jest.fn();

jest.mock('react-native/Libraries/LogBox/Data/LogBoxData', () => ({
  addIgnorePatterns: mockAddIgnorePatterns,
  setDisabled: mockSetDisabled,
  clear: mockClear,
}));

jest.mock('react-native/Libraries/LogBox/LogBox', () => ({
  __esModule: true,
  default: {
    ignoreLogs: mockIgnoreLogs,
    ignoreAllLogs: mockIgnoreAllLogs,
    clearAllLogs: mockClearAllLogs,
  },
}));

describe('bootstrap-logbox', () => {
  beforeEach(() => {
    jest.resetModules();
    delete (globalThis as { __airchat_fusebox_pinned?: boolean }).__airchat_fusebox_pinned;
    Reflect.deleteProperty(globalThis, '__FUSEBOX_HAS_FULL_CONSOLE_SUPPORT__');
    if (typeof global !== 'undefined') {
      try {
        Reflect.deleteProperty(global as object, '__FUSEBOX_HAS_FULL_CONSOLE_SUPPORT__');
      } catch {
        /* */
      }
    }
    mockAddIgnorePatterns.mockClear();
    mockSetDisabled.mockClear();
    mockClear.mockClear();
    mockIgnoreAllLogs.mockClear();
    mockIgnoreLogs.mockClear();
    mockClearAllLogs.mockClear();
  });

  it('отключает Fusebox-баннер и настраивает LogBox', () => {
    require('../bootstrap-logbox');
    expect(
      (globalThis as { __FUSEBOX_HAS_FULL_CONSOLE_SUPPORT__?: boolean }).__FUSEBOX_HAS_FULL_CONSOLE_SUPPORT__
    ).toBe(false);
    expect(mockAddIgnorePatterns).toHaveBeenCalledWith([
      'Open debugger to view warnings.',
      /Open debugger to view warnings/i,
    ]);
    expect(mockSetDisabled).toHaveBeenCalledWith(true);
    expect(mockIgnoreLogs).toHaveBeenCalledWith([
      'Open debugger to view warnings.',
      /Open debugger to view warnings/i,
    ]);
    expect(mockIgnoreAllLogs).toHaveBeenCalledWith(true);
    expect(mockClearAllLogs).toHaveBeenCalled();
  });
});
