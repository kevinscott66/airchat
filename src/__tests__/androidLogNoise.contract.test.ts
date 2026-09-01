/**
 * Известные строки в adb/logcat при RN New Architecture + Expo, не являющиеся багами JS-приложения.
 * Используйте при разборе `logs/android-latest.log`: совпадение с паттерном — ожидаемый шум старта.
 */
export const ANDROID_LOG_NOISE_LINE_PATTERNS: RegExp[] = [
  /onWindowFocusChange while context is not ready/,
  /ReactNoCrashSoftException/,
  /Packager connection already open, nooping/,
  /unknown:BridgelessReact: ReactHost/,
];

describe('android log noise contract', () => {
  it('matches sample ReactHost soft exception line', () => {
    const line =
      'raiseSoftException(onWindowFocusChange(hasFocus = "true")): Tried to access onWindowFocusChange while context is not ready';
    expect(ANDROID_LOG_NOISE_LINE_PATTERNS.some((r) => r.test(line))).toBe(true);
  });

  it('lists patterns for triage docs', () => {
    expect(ANDROID_LOG_NOISE_LINE_PATTERNS.length).toBeGreaterThanOrEqual(3);
  });
});
