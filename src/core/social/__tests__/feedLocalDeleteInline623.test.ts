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

/** Имена функций, из тел которых зовётся cleanupInlinePayloads, по порядку в файле. */
function cleanupCallSites(): string[] {
  const decl = /\n(?:export )?async function (\w+)\(/g;
  const out: string[] = [];
  let at = SRC.indexOf('await cleanupInlinePayloads(');
  while (at > 0) {
    let name = '';
    decl.lastIndex = 0;
    let m = decl.exec(SRC);
    while (m && m.index < at) {
      name = m[1];
      m = decl.exec(SRC);
    }
    out.push(name);
    at = SRC.indexOf('await cleanupInlinePayloads(', at + 1);
  }
  return out;
}

/**
 * v4.32.703: раньше здесь стоял слепой счётчик — «вызовов ровно три». Считающая
 * проверка молчит о том, ЧТО она считает: репост оброс двумя своими уборками, и
 * счётчик просто показал другое число, ничего не сказав про смысл. Теперь
 * закреплены сами места вызова: добавится новое — тест назовёт его вслух.
 */
it('ПРОВЕРКА НЕ ПУСТАЯ: уборка вложений вызывается из пяти названных мест', () => {
  expect(cleanupCallSites()).toEqual([
    // v4.32.703: два обрыва репоста — отказ чтения байтов оригинала и отказ записи копии.
    'publishRepost',
    'publishRepost',
    // локальное сокрытие чужого поста
    'deleteFeedPostLocal',
    // входящий feed_delete от автора
    'applyFeedEnvelope',
    // своё удаление «у всех»
    'deleteFeedPost',
  ]);
});

it('ПРОВЕРКА НЕ ПУСТАЯ: в трёх местах удаления уборка идёт прямо перед сносом строки', () => {
  const pairs = SRC.split('await cleanupInlinePayloads(')
    .slice(1)
    .map((tail) => tail.slice(0, 200));
  const dropsRow = pairs.filter((t) => /^[^;]*;\s*\n\s*await s\.deletePost\(/.test(t));
  expect(dropsRow).toHaveLength(3);
});

it('ПРОВЕРКА НЕ ПУСТАЯ: обе уборки репоста заканчиваются отказом публикации', () => {
  const aborts = SRC.split('await cleanupInlinePayloads(newPostId);')
    .slice(1)
    .filter((tail) => tail.trimStart().startsWith('return { ok: false };'));
  expect(aborts).toHaveLength(2);
});
