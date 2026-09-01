/**
 * Обои чата: набор фонов и правило «что читается поверх них».
 *
 * v4.32.410. Обои — единственный цвет интерфейса, который выбирает
 * пользователь и который лежит ПОД содержимым ленты. Из этого следуют две
 * вещи, и обе были нарушены.
 *
 * Первое: всё, что нарисовано прямо на ленте, — дата, системное событие,
 * цитата — должно считаться от обоев, а не от палитры. В группах это сделано
 * (v4.32.387, `chatBg` / `quoteFill`), в личной переписке — нет: разделитель
 * дат заливался серым 'rgba(128,128,128,0.25)' поверх чего угодно, а надпись
 * бралась из палитры. Правило одно, копий было две, и они разошлись.
 *
 * Второе: одиннадцать пресетов — все тёмные. Пока чернила брались из палитры,
 * это означало чёрным по тёмно-синему в светлой теме. Отсчёт от обоев чинит
 * и это, но набор всё равно неполон, поэтому здесь добавлены светлые фоны.
 *
 * Отдельный случай — снимок из галереи. Под ним не цвет, а произвольный кадр,
 * то есть ровно та задача, для которой заведён `mediaScrim` (v4.32.403):
 * гарантия берётся из худшего случая — белого кадра, — а не из удобного.
 */
import { badgeTint, contrastingInk, inkOn, mediaScrim, nestedFill, type AppColors, type FillInk } from './theme';

/** Что выбрал пользователь: цвет из набора или снимок из галереи. */
export interface Wallpaper {
  type: 'color' | 'image';
  value: string;
}

/** Пункт набора; `value === null` — «без обоев», фон берётся из темы. */
export interface WallpaperPreset {
  /** Название вслух: пункты набора — квадраты без подписи. */
  label: string;
  value: string | null;
}

/**
 * Набор фонов.
 *
 * Значения — ДАННЫЕ, а не цвета темы: их выбирает пользователь, и палитре они
 * не подчиняются. Поэтому файл назван в исключениях храповика литералов.
 */
export const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  { label: 'Без обоев', value: null },
  { label: 'Почти чёрный', value: '#0d1117' },
  { label: 'Тёмно-синий', value: '#0e2233' },
  { label: 'Индиго', value: '#1a1a2e' },
  { label: 'Тёмно-зелёный', value: '#0f2418' },
  { label: 'Тёмно-фиолетовый', value: '#1e0a2e' },
  { label: 'Тёмно-коричневый', value: '#2a1810' },
  { label: 'Грифельный', value: '#1c2333' },
  { label: 'Хвойный', value: '#223322' },
  { label: 'Тёмно-красный', value: '#2e1a1a' },
  { label: 'Морской', value: '#10202e' },
  // v4.32.410: светлая половина набора. До неё выбор «поставить обои» в
  // светлой теме означал «сделать ленту тёмной» — другого варианта не было.
  { label: 'Светло-серый', value: '#f2f2f7' },
  { label: 'Светло-голубой', value: '#eaf1fb' },
  { label: 'Светло-сиреневый', value: '#f3eefb' },
  { label: 'Светло-зелёный', value: '#eef6ee' },
  { label: 'Песочный', value: '#fbf1e8' },
];

/** Плашка на ленте и чернила на ней. */
export interface FeedPlate {
  fill: string;
  ink: FillInk;
}

/** Всё, что нужно нарисовать поверх ленты. */
export interface FeedGround {
  /**
   * Непрозрачный цвет под лентой. Для снимка — подложка-заглушка
   * `mediaScrim.fill`: настоящий цвет там неизвестен.
   */
  ground: string;
  /** Верно ли, что под лентой известный цвет, а не чужой кадр. */
  known: boolean;
  /** Нейтральная плашка: дата, системное событие, цитата. */
  quiet: FeedPlate;
  /** Она же с акцентом: непрочитанное. */
  loud: { fill: string; ink: string };
}

/**
 * Чернила слоя поверх чужого кадра.
 *
 * Здесь подложка — не `mediaScrim.fill`, а полупрозрачная `mediaScrim.bar`, и
 * худший случай у неё светлее: на белом снимке она даёт #666666. Измерено:
 * белый на ней 5.74:1, приглушённый #c7c7c7 — 3.40:1, а красный #ff7676 —
 * 2.22:1, то есть не дотягивает даже до графического порога 3:1. Поэтому
 * цветных чернил на ленте поверх снимка нет вовсе: смысл несёт текст, а не
 * оттенок. Приглушённый остаётся только там, где порог 3:1 — у подписей.
 */
function scrimInk(): FillInk {
  return {
    text: mediaScrim.ink,
    secondary: mediaScrim.ink,
    muted: mediaScrim.inkMuted,
    accent: mediaScrim.ink,
    error: mediaScrim.ink,
    star: mediaScrim.ink,
    success: mediaScrim.ink,
  };
}

/**
 * Плашки и чернила поверх ленты.
 *
 * Порядок тот же, что у всякого вложенного блока (см. `nestedFill`): сначала
 * подложка от того, что под ней, потом чернила от подложки. «Под ней» здесь —
 * обои, а не фон страницы, и в этом вся правка.
 */
export function feedGround(colors: AppColors, wallpaper: Wallpaper | null): FeedGround {
  if (wallpaper?.type === 'image') {
    // Кадр неизвестен, но ограничен: `mediaScrim.bar` доказан против белого
    // худшего случая, поэтому чернила на нём можно назвать, не зная снимка.
    const ink = scrimInk();
    return {
      ground: mediaScrim.fill,
      known: false,
      quiet: { fill: mediaScrim.bar, ink },
      loud: { fill: mediaScrim.bar, ink: mediaScrim.ink },
    };
  }
  const ground = wallpaper?.type === 'color' ? wallpaper.value : colors.background;
  const fill = nestedFill(ground);
  const loud = badgeTint(colors, 'accent', ground);
  return {
    ground,
    known: true,
    quiet: { fill, ink: inkOn(colors, fill, contrastingInk(fill)) },
    loud,
  };
}
