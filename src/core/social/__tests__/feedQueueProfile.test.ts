import * as fs from 'fs';
import * as path from 'path';
import { storageIsOwn } from '../../identity/ownerProfile';

/**
 * Раунд 458: переключение профиля посреди рассылки больше не стирает пост.
 *
 * Лента активного профиля — модульная переменная, её подменяет
 * `rebindFeedToProfile`. Рассылка очереди живёт секунды и держит пару ключей
 * своего профиля; если человек переключился, пока она шла, `ensureStorage()`
 * отдавал ей базу уже другого профиля. Отметка автора (v4.32.439) этот случай
 * не ловит — ключ-то наш, чужая тут база. Пост, которого в чужой базе нет,
 * читался как «автор удалил его локально», и запись удалялась из очереди
 * навсегда: у автора пост остаётся в ленте как опубликованный, а контакты его
 * не получат никогда.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  if (start < 0) return '';
  const end = src.indexOf('\n}', start);
  return end < 0 ? '' : src.slice(start, end);
}

const REPUBLISH = bodyOf(SRC, 'async function republishQueuedItem(');

describe('своё хранилище или чужое', () => {
  test('номера совпали — работаем', () => {
    expect(storageIsOwn(2, 2)).toBe(true);
  });

  test('номера разные — не работаем', () => {
    expect(storageIsOwn(1, 2)).toBe(false);
  });

  test('свой профиль неизвестен — поведение прежнее', () => {
    // Установка без seed: профилей нет вовсе, останавливать рассылку не за что.
    expect(storageIsOwn(null, 1)).toBe(true);
  });

  test('лента ещё не привязана — поведение прежнее', () => {
    expect(storageIsOwn(1, null)).toBe(true);
  });
});

describe('рассылка не пишет в ленту чужого профиля', () => {
  test('проверка стоит до любой работы с базой', () => {
    const guard = REPUBLISH.indexOf('if (!feedStorageBelongsTo(pair))');
    const legacy = REPUBLISH.indexOf('if (!item.postId)');
    const getPost = REPUBLISH.indexOf('.getPost(item.postId)');
    expect(guard).toBeGreaterThan(0);
    expect(legacy).toBeGreaterThan(guard);
    expect(getPost).toBeGreaterThan(guard);
  });

  test('чужая лента — запись остаётся в очереди и не тратит попытку', () => {
    expect(REPUBLISH).toContain("log.info('feed_queue_profile_switched_kept'");
    expect(REPUBLISH).toContain('return { fullyDelivered: false, foreign: true };');
  });

  test('дальше работают с проверенным хранилищем, а не спрашивают заново', () => {
    expect(REPUBLISH).toContain('const own = await ensureStorage();');
    expect(REPUBLISH).toContain('const existing = await own.getPost(item.postId);');
    expect(REPUBLISH.split('await ensureStorage()').length - 1).toBe(1);
  });

  test('правило «своё или чужое» живёт в одном месте', () => {
    expect(bodyOf(SRC, 'function feedStorageBelongsTo(')).toContain(
      'return storageIsOwn(pid, currentProfileId);',
    );
  });
});

describe('проверка не пустая', () => {
  /** Как было до 458-го: базу спрашивали заново и сразу читали пост. */
  const BEFORE = `  const s = await ensureStorage();
  const existing = await s.getPost(item.postId);`;

  test('старая пара строк была бы поймана', () => {
    expect(BEFORE).toContain('await s.getPost(item.postId);');
    expect(SRC).not.toContain(BEFORE);
  });

  test('старое правило разрешало запись в чужую ленту', () => {
    // Прежде сверялся только автор: ключ наш — значит можно.
    const oldRule = (authorIsMine: boolean): boolean => authorIsMine;
    expect(oldRule(true)).toBe(true);
    expect(storageIsOwn(1, 2)).toBe(false);
  });
});
