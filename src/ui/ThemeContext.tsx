import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Appearance, StyleSheet } from 'react-native';
import { kvGet, kvSet } from '../core/storage/local';
import { applyAccent, colorsForScheme, normalizeAccent, resolveScheme, type AppColors, type ColorScheme, type ThemeMode } from './theme';

export const FONT_SIZE_OPTIONS = [
  { label: 'Мелкий', value: 13 },
  { label: 'Средний', value: 15 },
  { label: 'Крупный', value: 17 },
  { label: 'Очень крупный', value: 20 },
] as const;

export type FontSizeValue = 13 | 15 | 17 | 20;

type ThemeContextValue = {
  mode: ThemeMode;
  /**
   * Схема, которая нарисована сейчас. Из `mode` она не выводится: при 'system'
   * её задаёт ОС, а авторежим ночи переключает тему, вообще не трогая `mode`.
   * Нужна тем, кому мало палитры, — статус-бару, фону окна, теме навигации.
   */
  scheme: ColorScheme;
  colors: AppColors;
  setMode: (mode: ThemeMode) => Promise<void>;
  fontSize: FontSizeValue;
  setFontSize: (size: FontSizeValue) => Promise<void>;
  autoNightEnabled: boolean;
  autoNightStart: number;
  autoNightEnd: number;
  setAutoNight: (enabled: boolean, start: number, end: number) => Promise<void>;
  accentColor: string | null;
  setAccentColor: (color: string | null) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'dark',
  scheme: 'dark',
  colors: colorsForScheme('dark'),
  setMode: async () => {},
  fontSize: 15,
  setFontSize: async () => {},
  autoNightEnabled: false,
  autoNightStart: 21,
  autoNightEnd: 7,
  setAutoNight: async () => {},
  accentColor: null,
  setAccentColor: async () => {},
});

/** Returns whether the current hour falls within [start, end) wrapping midnight. */
function isInNightWindow(hour: number, start: number, end: number): boolean {
  if (start <= end) return hour >= start && hour < end;
  // wraps midnight: e.g. 21 → 7
  return hour >= start || hour < end;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [mode, setModeState] = useState<ThemeMode>('dark');
  const [scheme, setScheme] = useState<ColorScheme>('dark');
  const [baseColors, setBaseColors] = useState<AppColors>(() => colorsForScheme('dark'));
  const [accentColor, setAccentColorState] = useState<string | null>(null);
  // v4.32.344: без useMemo здесь получался новый объект палитры на каждый
  // рендер провайдера — а провайдер перерисовывается вместе с App (gate,
  // блокировка, статус VPN, сплэш). Любой потребитель темы, включая
  // React.memo-обёрнутые строки списка, перерисовывался бы вместе с ним.
  const colors = useMemo(
    () => (accentColor ? applyAccent(baseColors, accentColor) : baseColors),
    [baseColors, accentColor]
  );
  const [fontSize, setFontSizeState] = useState<FontSizeValue>(15);
  const [autoNightEnabled, setAutoNightEnabled] = useState(false);
  const [autoNightStart, setAutoNightStart] = useState(21);
  const [autoNightEnd, setAutoNightEnd] = useState(7);

  // Keep refs in sync for the timer callback
  const modeRef = useRef<ThemeMode>('dark');
  const autoNightRef = useRef({ enabled: false, start: 21, end: 7 });

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { autoNightRef.current = { enabled: autoNightEnabled, start: autoNightStart, end: autoNightEnd }; }, [autoNightEnabled, autoNightStart, autoNightEnd]);

  const applyEffectiveColors = useCallback((baseMode: ThemeMode, nightEnabled: boolean, nStart: number, nEnd: number) => {
    // v4.32.345: схема и палитра выводятся из одного разрешения. Раньше палитра
    // ставилась двумя ветками с отдельными вызовами resolveColors, и схемы как
    // значения не существовало вовсе — узнать «что сейчас нарисовано» можно было
    // только сравнив объект палитры с эталоном.
    const effective: ThemeMode = nightEnabled
      ? (isInNightWindow(new Date().getHours(), nStart, nEnd) ? 'dark' : 'light')
      : baseMode;
    const next = resolveScheme(effective);
    setScheme(next);
    setBaseColors(colorsForScheme(next));
  }, []);

  useEffect(() => {
    void Promise.all([
      kvGet('app_theme_mode'),
      kvGet('app_font_size'),
      kvGet('auto_night_mode'),
      kvGet('auto_night_start'),
      kvGet('auto_night_end'),
      kvGet('app_accent_color'),
    ]).then(([saved, savedSize, nightMode, nightStart, nightEnd, accentVal]) => {
      const m = (saved as ThemeMode | null) ?? 'dark';
      const nightEnabled = nightMode === 'true';
      const nStart = nightStart ? parseInt(nightStart, 10) : 21;
      const nEnd = nightEnd ? parseInt(nightEnd, 10) : 7;
      setModeState(m);
      setAutoNightEnabled(nightEnabled);
      setAutoNightStart(nStart);
      setAutoNightEnd(nEnd);
      applyEffectiveColors(m, nightEnabled, nStart, nEnd);
      const fs = savedSize ? (parseInt(savedSize, 10) as FontSizeValue) : 15;
      if ([13, 15, 17, 20].includes(fs)) setFontSizeState(fs);
      // v4.32.347: в хранилище лежит выбор, сделанный старым пикером, — в том
      // числе цвета, на которых белая надпись не читается. Приводим при чтении
      // и, если значение изменилось, переписываем: иначе миграция повторялась бы
      // при каждом запуске, а настройки показывали бы не тот цвет, что нарисован.
      if (accentVal) {
        const safe = normalizeAccent(accentVal);
        if (safe) setAccentColorState(safe);
        if (safe !== accentVal) void kvSet('app_accent_color', safe ?? '');
      }
    });
  }, [applyEffectiveColors]);

  // Реагируем на системные изменения темы когда режим — 'system'
  useEffect(() => {
    const sub = Appearance.addChangeListener(() => {
      setModeState((current) => {
        const { enabled, start, end } = autoNightRef.current;
        applyEffectiveColors(current, enabled, start, end);
        return current;
      });
    });
    return () => sub.remove();
  }, [applyEffectiveColors]);

  // Периодически проверяем авторежим ночи (раз в минуту)
  useEffect(() => {
    const tick = () => {
      const { enabled, start, end } = autoNightRef.current;
      if (enabled) {
        applyEffectiveColors(modeRef.current, enabled, start, end);
      }
    };
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [applyEffectiveColors]);

  const setMode = useCallback(async (newMode: ThemeMode) => {
    setModeState(newMode);
    const { enabled, start, end } = autoNightRef.current;
    applyEffectiveColors(newMode, enabled, start, end);
    await kvSet('app_theme_mode', newMode);
  }, [applyEffectiveColors]);

  const setFontSize = useCallback(async (size: FontSizeValue) => {
    setFontSizeState(size);
    await kvSet('app_font_size', String(size));
  }, []);

  const setAutoNight = useCallback(async (enabled: boolean, start: number, end: number) => {
    setAutoNightEnabled(enabled);
    setAutoNightStart(start);
    setAutoNightEnd(end);
    applyEffectiveColors(modeRef.current, enabled, start, end);
    await Promise.all([
      kvSet('auto_night_mode', String(enabled)),
      kvSet('auto_night_start', String(start)),
      kvSet('auto_night_end', String(end)),
    ]);
  }, [applyEffectiveColors]);

  const setAccentColor = useCallback(async (color: string | null) => {
    const safe = color ? normalizeAccent(color) : null;
    setAccentColorState(safe);
    await kvSet('app_accent_color', safe ?? '');
  }, []);

  // Значение контекста — тоже мемоизировано, по той же причине: объектный литерал
  // прямо в value обесценивал бы useMemo выше.
  const value = useMemo(
    () => ({ mode, scheme, colors, setMode, fontSize, setFontSize, autoNightEnabled, autoNightStart, autoNightEnd, setAutoNight, accentColor, setAccentColor }),
    [mode, scheme, colors, setMode, fontSize, setFontSize, autoNightEnabled, autoNightStart, autoNightEnd, setAutoNight, accentColor, setAccentColor]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Convenience: returns current colors palette. */
export function useColors(): AppColors {
  return useContext(ThemeContext).colors;
}

/**
 * Creates a memoised StyleSheet that rebuilds when the theme changes.
 * Usage:
 *   const styles = useThemedStyles((c) => ({ container: { backgroundColor: c.background } }));
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (colors: AppColors) => T,
): T {
  const { colors } = useContext(ThemeContext);
  return useMemo(() => StyleSheet.create(factory(colors)), [colors]); // eslint-disable-line react-hooks/exhaustive-deps
}
