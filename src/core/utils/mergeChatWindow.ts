import { insertSortedDesc } from './insertSortedDesc';

/**
 * Свести окно последних сообщений с тем, что уже на экране.
 *
 * v4.32.607. Прежняя склейка умела ровно две вещи: добавить новые строки и
 * подтянуть `status`. Всё остальное, что может измениться у уже показанной
 * строки, на экран не попадало вовсе:
 *
 *  - правка текста. Человек редактировал своё сообщение, база менялась, пузырь
 *    оставался прежним — правка выглядела неприменившейся;
 *  - удаление. Строки, исчезнувшей из базы, никто не убирал из `lines`;
 *  - реакции, «избранное», отметка о правке, вложения.
 *
 * Здесь сведение идёт по окну: `latest` — это последние N строк из базы,
 * упорядоченные по времени вниз. Всё, что строго новее самой старой строки
 * окна, обязано в это окно попасть — значит его отсутствие означает удаление.
 * Строго новее, а не «новее или одновременно»: порядок в базе `created_at
 * DESC, id DESC`, и при совпадении времени граница окна может пройти между
 * двумя строками одной миллисекунды — по нестрогому сравнению уцелевшая
 * половина такой пары была бы стёрта с экрана.
 *
 * Всё, что старше границы (подгруженное листанием), не трогается: про него это
 * окно ничего не знает.
 */

/** Поля строки, от которых зависит нарисованный пузырь. */
function sameRendered(a: object, b: object): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

export function mergeChatWindow<T extends { id: string; createdAt: number }>(
  prev: readonly T[],
  visible: readonly T[],
  /**
   * Всё окно целиком, включая строки, которые на экран не идут (надгробия).
   * Границу окна задаёт именно оно: невидимая строка тоже занимает место в
   * выборке, и без неё граница уехала бы вверх, стирая живые сообщения.
   */
  windowRows: readonly T[] = visible,
): T[] {
  if (windowRows.length === 0) return prev.length === 0 ? (prev as T[]) : [];
  const fresh = new Map(visible.map((m) => [m.id, m]));
  // Граница окна: самая старая строка выборки. Ниже неё окно не свидетель.
  const windowFloor = windowRows.reduce(
    (min, m) => (m.createdAt < min ? m.createdAt : min),
    windowRows[0].createdAt,
  );

  let changed = false;
  const kept: T[] = [];
  for (const row of prev) {
    const hit = fresh.get(row.id);
    if (hit) {
      if (sameRendered(row, hit)) {
        kept.push(row);
      } else {
        changed = true;
        kept.push(hit);
      }
      continue;
    }
    if (row.createdAt > windowFloor) {
      changed = true; // строка исчезла из базы — значит удалена
      continue;
    }
    kept.push(row);
  }

  const seen = new Set(prev.map((m) => m.id));
  const newOnes = visible.filter((m) => !seen.has(m.id));
  if (newOnes.length > 0) return insertSortedDesc(kept, newOnes);
  return changed ? kept : (prev as T[]);
}
