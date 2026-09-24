/**
 * v4.32.881 — «Пока никто не просмотрел» вместо «не удалось прочитать».
 *
 * Дефект: openViewers в FeedScreen ловил отказ чтения пустым catch и оставлял
 * список пустым. Модалка «Просмотры» показывала ровно тот же экран, что и для
 * поста, который правда никто не открывал: «Пока никто не просмотрел».
 *
 * Цена: человек делает вывод о чужом поведении там, где база просто не
 * ответила. Повторить нечем — модалку надо закрыть и открыть заново, о чём
 * ничто не сообщает. В журнал не попадало ничего: отказ исчезал целиком.
 *
 * Правка: отдельное состояние viewersFailed; catch пишет в журнал через
 * rawErrorText и поднимает флаг; модалка показывает «Не удалось прочитать
 * список» с повтором по нажатию. Так же, как комментариям в v4.32.538.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SCREEN = readFileSync(join(__dirname, '..', 'FeedScreen.tsx'), 'utf8');
const RU = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'i18n', 'ru.json'), 'utf8')) as {
  feed: Record<string, string>;
};

/** Только код: комментарии умеют упоминать что угодно, они не доказательство. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CODE = codeOnly(SCREEN);

/** Тело openViewers — от объявления до следующего useCallback. */
function openViewersBody(): string {
  const start = CODE.indexOf('const openViewers = useCallback');
  expect(start).toBeGreaterThan(0);
  const end = CODE.indexOf('const closeViewers', start);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

describe('v4.32.881 — просмотры не врут о пустоте', () => {
  describe('ПРОВЕРКА НЕ ПУСТАЯ (проходит и на старом коде)', () => {
    it('экран и модалка просмотров на месте', () => {
      expect(CODE).toContain('const openViewers = useCallback');
      expect(CODE).toContain('listFeedPostViewers(postId)');
      expect(CODE).toContain("t('feed.viewersEmptyTitle')");
    });

    it('срез openViewers вычленяется и содержит чтение', () => {
      const body = openViewersBody();
      expect(body).toContain('listFeedPostViewers');
      expect(body.length).toBeGreaterThan(120);
    });

    it('ключи просмотров лежат в ru.json', () => {
      expect(RU.feed.viewersEmptyTitle).toBe('Пока никто не просмотрел');
      expect(typeof RU.feed.viewersEmptyHint).toBe('string');
    });
  });

  describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
    it('пустой список по-прежнему говорит «никто не просмотрел»', () => {
      // Честный случай никуда не делся — правка не должна была его съесть.
      expect(CODE).toContain("{t('feed.viewersEmptyTitle')}");
      expect(CODE).toContain("{t('feed.viewersEmptyHint')}");
    });

    it('в файле есть образец из v4.32.538 — комментарии сообщают об отказе', () => {
      expect(CODE).toContain("log.warn('feed_comments_load_failed'");
      expect(CODE).toContain("t('feed.commentsLoadFailed')");
    });
  });

  describe('отказ чтения виден', () => {
    it('catch в openViewers получил ошибку, а не проглотил её', () => {
      const body = openViewersBody();
      expect(body).toContain('} catch (e) {');
      expect(body).not.toMatch(/\}\s*catch\s*\{/);
    });

    it('отказ уходит в журнал через rawErrorText', () => {
      const body = openViewersBody();
      expect(body).toContain("log.warn('feed_viewers_load_failed'");
      expect(body).toContain('rawErrorText(e)');
    });

    it('отказ поднимает отдельный флаг, а не просто чистит список', () => {
      const body = openViewersBody();
      expect(body).toContain('setViewersFailed(true)');
      expect(CODE).toContain('const [viewersFailed, setViewersFailed] = useState(false)');
    });

    it('новая попытка начинается с чистого флага', () => {
      const body = openViewersBody();
      const reset = body.indexOf('setViewersFailed(false)');
      const read = body.indexOf('listFeedPostViewers');
      expect(reset).toBeGreaterThan(0);
      expect(reset).toBeLessThan(read);
    });

    it('закрытие модалки сбрасывает флаг', () => {
      const start = CODE.indexOf('const closeViewers = useCallback');
      const body = CODE.slice(start, start + 320);
      expect(body).toContain('setViewersFailed(false)');
    });
  });

  describe('модалка говорит правду', () => {
    it('ветка отказа стоит раньше ветки «никто не просмотрел»', () => {
      const failed = CODE.indexOf('viewersFailed ? (');
      const empty = CODE.indexOf('viewersList.length === 0 ? (');
      expect(failed).toBeGreaterThan(0);
      expect(empty).toBeGreaterThan(failed);
    });

    it('у отказа свой текст и подсказка про повтор', () => {
      expect(CODE).toContain("t('feed.viewersFailedTitle')");
      expect(CODE).toContain("t('feed.viewersFailedHint')");
      expect(RU.feed.viewersFailedTitle).toBe('Не удалось прочитать список');
      expect(RU.feed.viewersFailedHint).toContain('повтор');
    });

    it('по нажатию читает заново тот же пост', () => {
      const at = CODE.indexOf('viewersFailed ? (');
      const branch = CODE.slice(at, at + 700);
      expect(branch).toContain('<AppPressable');
      expect(branch).toContain('openViewers(viewersPostId)');
    });
  });
});
