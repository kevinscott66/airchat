/**
 * Удаление публикации из ленты убирает всё за один раз (v4.32.623).
 *
 * `deletePost` ставила надгробие и следом сносила три таблицы четырьмя
 * отдельными записями. Порознь они рвались: надгробие уже стоит — публикация
 * не вернётся никогда, — а приложение закрыли между DELETE'ами, и комментарии
 * с просмотрами остались в базе навсегда, привязанные к посту, которого нет.
 *
 * Здесь проверяется форма исходника, а не поведение: настоящий SQLite для
 * этого пришлось бы ронять посреди транзакции. Положительный контроль ниже —
 * соседние места того же файла, которые так пишут с самого начала.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedStorage.ts'), 'utf8');

/** Тело deletePost без строк-комментариев. */
function deletePost(): string {
  const from = SRC.indexOf('  async deletePost(');
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('\n  }\n', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

it('надгробие и три удаления идут одной транзакцией', () => {
  const body = deletePost();
  const tx = body.indexOf('await d.withTransactionAsync(async () => {');
  expect(tx).toBeGreaterThan(0);
  for (const stmt of [
    'await this.savePostTombstone(postId, row.author_did, deletedAt);',
    "await d.runAsync('DELETE FROM feed WHERE id = ?', [postId]);",
    "await d.runAsync('DELETE FROM feed_comments WHERE post_id = ?', [postId]);",
    "await d.runAsync('DELETE FROM feed_post_views WHERE post_id = ?', [postId]);",
  ]) {
    const at = body.indexOf(stmt);
    expect(at).toBeGreaterThan(tx);
  }
});

it('ПРОВЕРКА НЕ ПУСТАЯ: вырезка та же, и в ней всё ещё читается автор строки', () => {
  const body = deletePost();
  expect(body).toContain("'SELECT author_did FROM feed WHERE id = ?'");
  expect(body).toContain('const d = await this.ensureDb();');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: файл и раньше знал withTransactionAsync', () => {
  // Создание таблиц и миграции — три места, они были тут до правки.
  const all = SRC.split('withTransactionAsync').length - 1;
  expect(all).toBeGreaterThanOrEqual(4);
});
