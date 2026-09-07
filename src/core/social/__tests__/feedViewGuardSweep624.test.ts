/**
 * Отметки «просмотр отправлен» переживали свои публикации (v4.32.624).
 *
 * `feedViewSentKey` ставит по одной записи на каждую чужую публикацию, которую
 * человек досмотрел, — чтобы не слать автору просмотр дважды. Снимали её
 * нигде: ни удаление публикации, ни уборка ленты профиля этих ключей не
 * знали, а лента по возрасту не чистится вовсе. Ряд оставался навсегда,
 * привязанный к id, которого в базе уже нет.
 *
 * Проверяется форма исходника: сама сверка требует живой SQLite и открытой
 * ленты профиля, а правило («пропала публикация — пропала и отметка») видно
 * прямо в теле `reconcileOrphanInlineMedia`.
 */
import fs from 'fs';
import path from 'path';

const FEED_SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
const KV_KEYS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'storage', 'kvKeys.ts'),
  'utf8'
);
const FEED_STORAGE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'storage', 'feedStorage.ts'),
  'utf8'
);

function reconcileBody(): string {
  const from = FEED_SERVICE.indexOf('export async function reconcileOrphanInlineMedia(');
  expect(from).toBeGreaterThan(0);
  const to = FEED_SERVICE.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return FEED_SERVICE.slice(from, to);
}

it('имя отметки собрано из общего префикса, а не набрано на месте', () => {
  expect(KV_KEYS).toContain("export const FEED_VIEW_SENT_PREFIX = 'feed_view_sent:';");
  expect(KV_KEYS).toContain('return `${FEED_VIEW_SENT_PREFIX}${postId}`;');
  // Ровно одно место, где строка набрана буквами, — само определение префикса.
  expect(KV_KEYS.split("'feed_view_sent:'").length - 1).toBe(1);
});

it('сирота-отметка снимается, а отметка живой публикации — нет', () => {
  const b = reconcileBody();
  expect(b).toContain('for (const key of await scopedKvListKeysByPrefix(FEED_VIEW_SENT_PREFIX)) {');
  expect(b).toContain('const postId = key.slice(FEED_VIEW_SENT_PREFIX.length);');
  const keep = b.indexOf('if (!postId || known.has(postId)) continue;');
  const drop = b.indexOf('await scopedKvDelete(key);');
  expect(keep).toBeGreaterThan(-1);
  expect(drop).toBeGreaterThan(keep);
  expect(b).toContain("log.info('feed_view_guard_purged', { profileId, count: viewGuardsPurged });");
});

it('список публикаций не прочитался — не снимается ничего', () => {
  const b = reconcileBody();
  const gate = b.indexOf('if (knownPostIdsEverywhere !== null) {');
  const known = b.indexOf('const known = new Set(knownPostIdsEverywhere);');
  const drop = b.indexOf('await scopedKvDelete(key);');
  expect(gate).toBeGreaterThan(-1);
  expect(known).toBeGreaterThan(gate);
  expect(drop).toBeGreaterThan(gate);
  expect(b).toContain("log.warn('feed_view_guard_purge_failed', {");
});

it('ПРОВЕРКА НЕ ПУСТАЯ: уборка байтов вложений осталась на месте и идёт раньше', () => {
  const b = reconcileBody();
  const bytes = b.indexOf("log.info('feed_orphan_kv_purged', { profileId, count: orphanKeysPurged });");
  const guards = b.indexOf('for (const key of await scopedKvListKeysByPrefix(FEED_VIEW_SENT_PREFIX)) {');
  expect(bytes).toBeGreaterThan(-1);
  expect(guards).toBeGreaterThan(bytes);
  expect(b).toContain('const mediaKeys = await kvTryListKeysByPrefix(INLINE_MEDIA_PREFIX);');
  expect(b).toContain("log.warn('feed_reconcile_skipped_kv_unreadable', { profileId });");
});

it('мёртвого FeedStorage.clear() больше нет', () => {
  // Метод сносил `DELETE FROM feed` целиком и не вызывался ниоткуда — ни из
  // src, ни из тестов. Ленту удалённого профиля уносят файлом.
  expect(FEED_STORAGE).not.toContain('async clear(');
  // ПРОВЕРКА НЕ ПУСТАЯ: точечное удаление публикации на месте.
  expect(FEED_STORAGE).toContain("await d.runAsync('DELETE FROM feed WHERE id = ?', [postId]);");
});
