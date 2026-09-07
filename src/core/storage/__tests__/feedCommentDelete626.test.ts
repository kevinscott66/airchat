/**
 * Удаление комментария ленты ставит надгробие в той же транзакции (v4.32.626).
 *
 * `deleteComment` сносила строку одной записью и ставила надгробие второй.
 * Порознь они рвались в худшую сторону: строка комментария уже стёрта, а
 * приложение закрыли до надгробия — и следующий же конверт с тем же
 * комментарием (`addComment` / `upsertSyncComment`, оба смотрят в
 * `feed_comment_tombstones`) возвращал удалённое навсегда, потому что запрета
 * на возврат больше нет. `deleteSyncComment` — тот же разрыв на пути со
 * второго устройства аккаунта, и там он вероятнее: зовут его пачкой.
 *
 * Проверяется форма исходника, а не поведение: чтобы поймать это поведением,
 * настоящий SQLite пришлось бы ронять посреди транзакции. Положительный
 * контроль ниже — соседние места того же файла.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedStorage.ts'), 'utf8');

/** Тело названного метода без строк-комментариев. */
function body(header: string): string {
  const from = SRC.indexOf(header);
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('\n  }\n', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

it('deleteComment: DELETE и надгробие — внутри одной транзакции', () => {
  const b = body('  async deleteComment(');
  const tx = b.indexOf('await d.withTransactionAsync(async () => {');
  expect(tx).toBeGreaterThan(0);
  for (const stmt of [
    "await d.runAsync('DELETE FROM feed_comments WHERE id = ?', [commentId]);",
    'INSERT OR IGNORE INTO feed_comment_tombstones',
  ]) {
    expect(b.indexOf(stmt)).toBeGreaterThan(tx);
  }
});

it('deleteSyncComment: DELETE и надгробие — внутри одной транзакции', () => {
  const b = body('  async deleteSyncComment(');
  const tx = b.indexOf('await d.withTransactionAsync(async () => {');
  expect(tx).toBeGreaterThan(0);
  for (const stmt of [
    "await d.runAsync('DELETE FROM feed_comments WHERE id = ?', [commentId]);",
    'INSERT INTO feed_comment_tombstones',
  ]) {
    expect(b.indexOf(stmt)).toBeGreaterThan(tx);
  }
});

it('ПРОВЕРКА НЕ ПУСТАЯ: вырезки те же и в них всё ещё видна прежняя работа', () => {
  // Чтение post_id перед удалением — оно было тут до правки.
  expect(body('  async deleteComment(')).toContain(
    "'SELECT post_id FROM feed_comments WHERE id = ?'"
  );
  // Разрешение конфликта по comment_id — тоже прежнее.
  expect(body('  async deleteSyncComment(')).toContain('ON CONFLICT (comment_id) DO UPDATE SET');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: возврат комментария и правда упирается в надгробия', () => {
  // Ради чего всё: обе точки приёма спрашивают надгробие перед вставкой.
  expect(SRC.split('feed_comment_tombstones').length - 1).toBeGreaterThanOrEqual(4);
});
