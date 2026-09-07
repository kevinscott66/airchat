/**
 * Локальное удаление публикации уносит и её вложения (v4.32.623).
 *
 * `deleteFeedPostLocal` сносила строку поста, но не байты — фотографии и
 * документы оставались в kv под ключами `feed_inline_media:<postId>:` и
 * `feed_inline_doc:<postId>:`. «Спрятать из Архива» не означало «удалить»:
 * содержимое удалённой публикации лежало на диске до следующего запуска
 * приложения, когда его подбирал reconcileOrphanInlineMedia.
 *
 * Проверяется форма исходника: две соседние точки удаления (входящий
 * `feed_delete` и своё удаление «у всех») зовут cleanupInlinePayloads с
 * v4.32.305 и служат здесь положительным контролем.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Тело deleteFeedPostLocal без строк-комментариев. */
function localDelete(): string {
  const from = SRC.indexOf('export async function deleteFeedPostLocal(');
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

it('локальное удаление зовёт уборку вложений до сноса строки', () => {
  const body = localDelete();
  const clean = body.indexOf('await cleanupInlinePayloads(postId);');
  const drop = body.indexOf('await s.deletePost(postId);');
  expect(clean).toBeGreaterThan(0);
  expect(drop).toBeGreaterThan(clean);
});

it('ПРОВЕРКА НЕ ПУСТАЯ: вырезка та же, и в ней всё ещё дёргается обновление ленты', () => {
  expect(localDelete()).toContain('emitFeedUpdate();');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: уборка вложений вызывается ровно из трёх мест', () => {
  const calls = SRC.split('await cleanupInlinePayloads(').length - 1;
  expect(calls).toBe(3);
});
