/**
 * Удаление альбома историй — одной транзакцией (v4.32.623).
 *
 * `deleteStoryAlbum` сносила снимки и саму полку двумя отдельными записями.
 * Разрыв между ними оставлял в профиле пустой альбом: содержимого нет, строка
 * есть, и убрать её можно было только повторным удалением.
 *
 * Проверяется форма исходника: `local.ts` требует живого SQLite, а разница
 * между «две записи подряд» и «eraseAtomically» видна прямо в теле. Соседний
 * `deleteStoryAlbumItem` — положительный контроль: он удаляет ровно одну
 * строку и транзакции не требует.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

function body(name: string): string {
  const from = SRC.indexOf(`export async function ${name}(`);
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to);
}

it('снимки и полка уходят внутри eraseAtomically', () => {
  const b = body('deleteStoryAlbum');
  const tx = b.indexOf("'delete_story_album',");
  expect(b).toContain('await eraseAtomically(');
  expect(tx).toBeGreaterThan(0);
  expect(b.indexOf("'DELETE FROM story_album_items WHERE album_id = ?")).toBeGreaterThan(tx);
  expect(b.indexOf("'DELETE FROM story_albums WHERE id = ?")).toBeGreaterThan(tx);
});

it('ПРОВЕРКА НЕ ПУСТАЯ: удаление одного снимка так и осталось одной записью', () => {
  const b = body('deleteStoryAlbumItem');
  expect(b).toContain("'DELETE FROM story_album_items WHERE id = ?");
  expect(b).not.toContain('eraseAtomically');
});
