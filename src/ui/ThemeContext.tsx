import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Appearance, StyleSheet } from 'react-native';
import { log } from '../core/logger';
import { kvTryGet, kvSetChecked } from '../core/storage/local';
import { parseHourOfDay } from '../core/time/hourOfDay';
import { showError } from './components/userFeedback';
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
  /** `false` — не легло на диск: вид возвращён прежний, человеку сказано. */
  setMode: (mode: ThemeMode) => Promise<boolean>;
  fontSize: FontSizeValue;
  setFontSize: (size: FontSizeValue) => Promise<boolean>;
  autoNightEnabled: boolean;
  autoNightStart: number;
  autoNightEnd: number;
  setAutoNight: (enabled: boolean, start: number, end: number) => Promise<boolean>;
  accentColor: string | null;
  setAccentColor: (color: string | null) => Promise<boolean>;
};

/**
 * Настройка вида не легла на диск (v4.32.878).
 *
 * До этого тема, акцент, размер шрифта и часы ночного режима писались через
 * `kvSet` — он гасит отказ базы и возвращает void, то есть отказа не терялось
 * даже, его неоткуда было взять. Экран перекрашивался сразу, и выглядело всё
 * сделанным; на диске при этом оставался прежний выбор, и настройка молча
 * откатывалась при следующем запуске. Слова те же, что у остальных настроек
 * (applyPref в настройках), — беда одна и та же.
 */
export const THEME_SAVE_FAILED_TEXT = 'Настройка не сохранилась. Попробуйте ещё раз.';

/**
 * Сколько раз переспросить вид у базы и с каким шагом (v4.32.964).
 *
 * Шаг больше паузы, которую база держит после неудачного открытия
 * (`DB_REOPEN_COOLDOWN_MS`, 2 с): переспрашивать раньше — значит получить тот
 * же отказ из памяти, не дойдя до диска. Пять попыток кроют около двенадцати
 * секунд — столько длится затор на этих устройствах; дальше молчим, потому что
 * вечный таймер на мёртвой базе ничего не чинит, а тикать будет до закрытия.
 */
const THEME_READ_ATTEMPTS = 5;
const THEME_READ_RETRY_MS = 2500;

/** Записать значения вида; `false` — хотя бы одно не легло. */
async function persistTheme(entries: readonly (readonly [string, string])[]): Promise<boolean> {
  const done = await Promise.all(entries.map(([k, v]) => kvSetChecked(k, v)));
  return done.every(Boolean);
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'dark',
  scheme: 'dark',
  colors: colorsForScheme('dark'),
  setMode: async () => true,
  fontSize: 15,
  setFontSize: async () => true,
  autoNightEnabled: false,
  autoNightStart: 21,
  autoNightEnd: 7,
  setAutoNight: async () => true,
  accentColor: null,
  setAccentColor: async () => true,
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
  // v4.32.878: прежний выбор нужен для отката, а отката раньше не было вовсе.
  const fontSizeRef = useRef<FontSizeValue>(15);
  const accentRef = useRef<string | null>(null);

  useEffect(() => { fontSizeRef.current = fontSize; }, [fontSize]);
  useEffect(() => { accentRef.current = accentColor; }, [accentColor]);
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

  /**
   * Вид читается с диска один раз — но только если он прочитался (v4.32.964).
   *
   * Дефект. Шесть значений читались через `kvGet`, а он отдаёт `null` и когда
   * записи нет, и когда база не открылась. Провайдер темы поднимается самым
   * первым, ещё до опознания профиля, — то есть ровно в ту секунду, когда база
   * занята миграциями или держит паузу после неудачного открытия. Отказ читался
   * как «человек ничего не выбирал», и поверх выбора вставали запасные значения.
   *
   * Цена. Светлая тема становится тёмной, акцент — общим, а размер шрифта
   * падает с «очень крупного» до среднего. Последнее хуже всего: крупный шрифт
   * выбирают не для красоты, и человек, который его выбрал, после такого
   * запуска экран просто не читает. Сказать ему нечего — настройки показывают
   * те же подставленные значения, а не его собственные.
   *
   * И это не только на один запуск. Часы ночной темы пишутся тремя ключами
   * разом: если человек после такого старта всего лишь щёлкнет выключателем
   * авторежима, на диск уйдут подставленные 21:00–07:00 поверх его настоящих —
   * он менял выключатель, а потерял расписание.
   *
   * Правка. Читаем `kvTryGet`, который отличает «нет записи» от «не прочитали».
   * Непрочитанное не подменяем: оставляем то, что уже показано, и переспрашиваем
   * базу — она самолечится, `closeLocalDatabase` снимает и отказ, и паузу.
   */
  useEffect(() => {
    let alive = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async (): Promise<void> => {
      const [saved, savedSize, nightMode, nightStart, nightEnd, accentVal] = await Promise.all([
        kvTryGet('app_theme_mode'),
        kvTryGet('app_font_size'),
        kvTryGet('auto_night_mode'),
        kvTryGet('auto_night_start'),
        kvTryGet('auto_night_end'),
        kvTryGet('app_accent_color'),
      ]);
      if (!alive) return;
      // Непрочитанный ключ берёт значение, которое уже показано: на первом
      // проходе это начальное состояние, на переспросе — то, что успело лечь.
      const shown = autoNightRef.current;
      const m = saved ? ((saved.value as ThemeMode | null) ?? 'dark') : modeRef.current;
      const nightEnabled = nightMode ? nightMode.value === 'true' : shown.enabled;
      // v4.32.929: раньше здесь стоял голый parseInt. Испорченная запись в kv
      // давала NaN, и это било дважды: «Тёмная: NaN:00 – NaN:00» в настройках и
      // тема, которая не переключается вовсе — сравнения с NaN всегда ложны.
      // Границы «не беспокоить» такую проверку получили ещё в v4.32.195,
      // размер шрифта строкой ниже — тоже; ночные часы её не получили.
      const nStart = nightStart ? parseHourOfDay(nightStart.value, 21) : shown.start;
      const nEnd = nightEnd ? parseHourOfDay(nightEnd.value, 7) : shown.end;
      setModeState(m);
      setAutoNightEnabled(nightEnabled);
      setAutoNightStart(nStart);
      setAutoNightEnd(nEnd);
      applyEffectiveColors(m, nightEnabled, nStart, nEnd);
      if (savedSize) {
        const fs = savedSize.value ? (parseInt(savedSize.value, 10) as FontSizeValue) : 15;
        if ([13, 15, 17, 20].includes(fs)) setFontSizeState(fs);
      }
      // v4.32.347: в хранилище лежит выбор, сделанный старым пикером, — в том
      // числе цвета, на которых белая надпись не читается. Приводим при чтении
      // и, если значение изменилось, переписываем: иначе миграция повторялась бы
      // при каждом запуске, а настройки показывали бы не тот цвет, что нарисован.
      if (accentVal?.value) {
        const safe = normalizeAccent(accentVal.value);
        if (safe) setAccentColorState(safe);
        if (safe !== accentVal.value) void kvSetChecked('app_accent_color', safe ?? '');
      }
      const unread = [saved, savedSize, nightMode, nightStart, nightEnd, accentVal].some(
        (r) => r === null,
      );
      if (!unread) return;
      if (attempts >= THEME_READ_ATTEMPTS) {
        log.warn('theme_read_unreadable', { attempts });
        return;
      }
      attempts += 1;
      timer = setTimeout(() => { void load(); }, THEME_READ_RETRY_MS);
    };

    void load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
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

  /**
   * Смена темы, размера шрифта, акцента и часов ночного режима.
   *
   * v4.32.878: вид меняется сразу — ждать записи, глядя на неперекрашенный
   * экран, было бы хуже. Но если запись не легла, вид возвращается прежний и
   * об этом говорят: иначе человек выбирает светлую тему, видит светлую тему,
   * а после перезапуска получает обратно тёмную и не знает почему.
   */
  const setMode = useCallback(async (newMode: ThemeMode): Promise<boolean> => {
    const prev = modeRef.current;
    const { enabled, start, end } = autoNightRef.current;
    setModeState(newMode);
    modeRef.current = newMode;
    applyEffectiveColors(newMode, enabled, start, end);
    const ok = await persistTheme([['app_theme_mode', newMode]]);
    if (!ok) {
      setModeState(prev);
      modeRef.current = prev;
      applyEffectiveColors(prev, enabled, start, end);
      showError(THEME_SAVE_FAILED_TEXT);
    }
    return ok;
  }, [applyEffectiveColors]);

  const setFontSize = useCallback(async (size: FontSizeValue): Promise<boolean> => {
    const prev = fontSizeRef.current;
    setFontSizeState(size);
    fontSizeRef.current = size;
    const ok = await persistTheme([['app_font_size', String(size)]]);
    if (!ok) {
      setFontSizeState(prev);
      fontSizeRef.current = prev;
      showError(THEME_SAVE_FAILED_TEXT);
    }
    return ok;
  }, []);

  const setAutoNight = useCallback(async (enabled: boolean, start: number, end: number): Promise<boolean> => {
    const prev = autoNightRef.current;
    const apply = (v: { enabled: boolean; start: number; end: number }): void => {
      setAutoNightEnabled(v.enabled);
      setAutoNightStart(v.start);
      setAutoNightEnd(v.end);
      autoNightRef.current = v;
      applyEffectiveColors(modeRef.current, v.enabled, v.start, v.end);
    };
    apply({ enabled, start, end });
    const ok = await persistTheme([
      ['auto_night_mode', String(enabled)],
      ['auto_night_start', String(start)],
      ['auto_night_end', String(end)],
    ]);
    if (!ok) {
      apply(prev);
      // Три ключа пишутся вместе, и лечь могла часть: возвращаем на диск
      // прежние значения, чтобы расписание не осталось наполовину новым.
      void persistTheme([
        ['auto_night_mode', String(prev.enabled)],
        ['auto_night_start', String(prev.start)],
        ['auto_night_end', String(prev.end)],
      ]);
      showError(THEME_SAVE_FAILED_TEXT);
    }
    return ok;
  }, [applyEffectiveColors]);

  const setAccentColor = useCallback(async (color: string | null): Promise<boolean> => {
    const prev = accentRef.current;
    const safe = color ? normalizeAccent(color) : null;
    setAccentColorState(safe);
    accentRef.current = safe;
    const ok = await persistTheme([['app_accent_color', safe ?? '']]);
    if (!ok) {
      setAccentColorState(prev);
      accentRef.current = prev;
      showError(THEME_SAVE_FAILED_TEXT);
    }
    return ok;
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

/**
 * v4.32.540: «Размер текста» в настройках раньше доезжал только до пузырей
 * переписки — на ленте, в списках и в комментариях он ничего не менял, и со
 * стороны выглядел как неработающая настройка. Глобально подменить `Text`
 * нельзя: в RN 0.83 это обычная функция-компонент без `render`, а `defaultProps`
 * у функциональных компонентов React 19 игнорирует. Поэтому масштабируем явно —
 * хук отдаёт функцию, которая пересчитывает базовый размер из токенов `font`
 * пропорционально выбору (15 pt — «Средний», то есть множитель 1).
 */
export function useScaledFont(): (base: number) => number {
  const { fontSize } = useContext(ThemeContext);
  return useCallback((base: number) => Math.round((base * fontSize) / 15), [fontSize]);
}
