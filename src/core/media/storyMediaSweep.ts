/**
 * Уборка файлов истёкших сторис, когда адрес файла не прочитан (v4.32.586).
 *
 * Сторис живёт сутки, а её снимок лежит в кэше приложения расшифрованным —
 * поэтому вместе со строкой стирается и файл. Адрес файла хранится в столбце
 * `media_uri` зашифрованным, и читался он двумя состояниями: строка либо
 * пустота. Столбец, который ключ этого устройства не открывает, приходил
 * пустотой — и обе половины уборки ломались молча.
 *
 * Первая: у истёкшей сторис адрес неизвестен, значит стирать нечего, и
 * расшифрованный снимок остаётся на диске навсегда. Эфемерность, обещанная на
 * экране, на диске не выполняется — а это ровно тот файл, ради которого её и
 * заводили.
 *
 * Вторая, хуже: список «ещё живых» адресов собирался из тех же чтений. Один
 * файл бывает у двух сторис — своя и та же самая, пришедшая от контакта. Если
 * адрес живой сторис не прочитан, её в списке нет, и файл, доставшийся от
 * истёкшей сестры, стирается у неё из-под ног: живая сторис становится пустым
 * чёрным прямоугольником.
 *
 * Отсюда правило: пока хоть один живой адрес не прочитан, не стираем ничего.
 * Оба исхода оставляют файл на диске, но осторожный не портит показанное —
 * а суточный sweepMediaCache подберёт лишнее и без нас.
 *
 * Модуль намеренно чистый: ни SQLite, ни файловой системы, ни ключей.
 */

/** Состояние столбца с адресом: столбца нет, прочитан, не открылся. */
export type StoryUriCell = { state: 'absent' | 'plain' | 'unreadable'; uri: string | null };

/** Что делать уборщику. */
export type StoryMediaSweepPlan = {
  /** Адреса, которые можно стереть прямо сейчас. */
  deletable: string[];
  /** Уборка отложена: адрес живой сторис не прочитан. */
  blocked: boolean;
};

/** Сколько истёкших строк унесли адрес своего файла с собой. */
export function lostAddressCount(cells: readonly StoryUriCell[]): number {
  let n = 0;
  for (const c of cells) if (c.state === 'unreadable') n++;
  return n;
}

/** Есть ли среди живых сторис такая, чей файл мы назвать не можем. */
export function aliveAddressUnknown(cells: readonly StoryUriCell[]): boolean {
  for (const c of cells) if (c.state === 'unreadable') return true;
  return false;
}

/**
 * План уборки.
 *
 * `ourDoomed` — адреса истёкших сторис, уже отобранные по признаку «файл наш,
 * созданный при расшифровке»: чужой снимок из галереи стирать нельзя, и это
 * решение принимается там, где известно правило имени файла.
 */
export function planStoryMediaSweep(
  ourDoomed: readonly string[],
  alive: readonly StoryUriCell[]
): StoryMediaSweepPlan {
  if (ourDoomed.length === 0) return { deletable: [], blocked: false };
  if (aliveAddressUnknown(alive)) return { deletable: [], blocked: true };
  const kept = new Set<string>();
  for (const c of alive) if (c.state === 'plain' && c.uri) kept.add(c.uri);
  const deletable: string[] = [];
  for (const uri of ourDoomed) {
    if (kept.has(uri) || deletable.includes(uri)) continue;
    deletable.push(uri);
  }
  return { deletable, blocked: false };
}

/** Показывать ли вместо сторис пометку о неудачном чтении. */
export function storyIsUnreadable(
  mediaUnreadable: boolean | undefined,
  textUnreadable: boolean | undefined
): boolean {
  return mediaUnreadable === true || textUnreadable === true;
}
