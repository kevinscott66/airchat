/**
 * byteSize — сколько весит файл, СЛОВАМИ. Одна подпись на всё приложение.
 *
 * v4.32.422. Подпись размера была написана шесть раз — в переписке, в
 * настройках, дважды в ленте, в «Общих файлах» чата и в «Общих файлах» группы
 * — и седьмой раз как текст предела в uploadRoute. Ни одна пара не совпадала:
 *
 *  1. Пределы заданы в ДЕСЯТИЧНЫХ мегабайтах (MAX_BLOB_BYTES = 8 000 000), а
 *     подписи делили на 1024. Файл ровно на пределе отклоняется словами
 *     «предел 8 МБ», а в переписке подписан «7.6 МБ»: пользователь видит файл
 *     меньше предела и не понимает, почему его не взяли.
 *
 *  2. Лента и «Общие файлы» не переходили в мегабайты вовсе — документ на
 *     50 МБ подписан «51200 KB». Латиницей, посреди русского интерфейса, а в
 *     модальных окнах ещё и без пробела: «51200KB».
 *
 *  3. Файл меньше килобайта в тех же местах — «0 KB».
 *
 *  4. Нулевой размер давал три разных ответа: «—» в ленте, «0KB» в чате и
 *     пустую строку в группе, потому что одна копия проверяла `size != null`,
 *     а другая — просто `size`.
 *
 * Единицы здесь десятичные — ровно те, в которых заданы сами пределы, — чтобы
 * подпись и проверка говорили об одном числе.
 */

export const BYTES_PER_KB = 1_000;
export const BYTES_PER_MB = 1_000_000;
export const BYTES_PER_GB = 1_000_000_000;

const UNITS = [
  { suffix: 'Б', scale: 1, decimals: 0 },
  { suffix: 'КБ', scale: BYTES_PER_KB, decimals: 0 },
  { suffix: 'МБ', scale: BYTES_PER_MB, decimals: 1 },
  { suffix: 'ГБ', scale: BYTES_PER_GB, decimals: 1 },
] as const;

export type ByteSizeOptions = {
  /**
   * Округлять вниз, а не к ближайшему.
   *
   * Нужно там, где число — обещание: подпись предела не имеет права назвать
   * больше, чем пропустит проверка. Для веса уже существующего файла округление
   * к ближайшему честнее.
   */
  roundDown?: boolean;
};

function quantize(value: number, decimals: number, roundDown: boolean): number {
  const factor = 10 ** decimals;
  return (roundDown ? Math.floor(value * factor) : Math.round(value * factor)) / factor;
}

/**
 * Размер словами: «400 Б», «12 КБ», «1.2 МБ».
 *
 * Пустая строка — ответ на «размер неизвестен»: не число, не конечное,
 * отрицательное. Это единственный случай, и он один на все экраны; раньше
 * каждый решал сам, и решения разошлись. Вызывающий, которому нужен прочерк,
 * пишет `formatByteSize(x) || '—'` — и делает это видимо.
 */
export function formatByteSize(
  bytes: number | null | undefined,
  opts: ByteSizeOptions = {}
): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  const roundDown = opts.roundDown === true;

  let i = 0;
  while (i + 1 < UNITS.length && bytes >= UNITS[i + 1].scale) i++;

  let unit = UNITS[i];
  let shown = quantize(bytes / unit.scale, unit.decimals, roundDown);
  // Округление способно перевалить через следующую единицу: 999 999 байт — это
  // не «1000 КБ», а «1 МБ». Проверяется после округления, а не до.
  if (i + 1 < UNITS.length && shown * unit.scale >= UNITS[i + 1].scale) {
    unit = UNITS[i + 1];
    shown = quantize(bytes / unit.scale, unit.decimals, roundDown);
  }

  return `${shown} ${unit.suffix}`;
}
