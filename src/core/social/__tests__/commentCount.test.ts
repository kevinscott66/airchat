/**
 * Число комментариев под записью расходилось с самим тредом (v4.32.538).
 *
 * Дефект. Экран ленты держал счётчик отдельно от списка и правил его
 * прибавлением единицы. Отправка своего комментария дописывала строку в список
 * ТОЛЬКО если её там ещё не было — перезагрузка треда по тику ленты успевает
 * положить её раньше, и это штатный случай, ради него и сверяются id, — а к
 * числу единица прибавлялась всегда. При удалении зеркально: строка убиралась
 * по совпадению id (то есть иногда не убиралась ничего), а единица вычиталась
 * в любом случае. Под записью «3 комментария», в открытом треде два.
 *
 * Заодно сбой чтения треда подменялся пустым списком: человек видел
 * «комментариев нет» там, где их не смогли прочитать, — и ни слова о сбое.
 *
 * И третье, из того же обхода: подгрузка следующей страницы ленты сверяла
 * версию загрузки один раз, а дальше шла ещё через три ожидания. Обновление,
 * начавшееся в это время, успевало заменить список и подрезать карты по
 * видимым записям, после чего подгрузка возвращала в них сведения о записях,
 * которых на экране уже нет.
 */
import fs from 'fs';
import path from 'path';
import { commentCountFromThread } from '../commentCount';

const SCREEN = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'),
  'utf8',
);
const RU = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'i18n', 'ru.json'),
  'utf8',
);

describe('счётчик равен длине треда', () => {
  it('ставит длину, когда она отличается', () => {
    expect(commentCountFromThread({ a: 1 }, 'a', 3)).toEqual({ a: 3 });
  });

  it('не трогает соседние записи', () => {
    expect(commentCountFromThread({ a: 1, b: 7 }, 'a', 2)).toEqual({ a: 2, b: 7 });
  });

  it('заводит запись, которой ещё не было', () => {
    expect(commentCountFromThread({}, 'a', 5)).toEqual({ a: 5 });
  });

  it('доводит до нуля, когда удалили последний', () => {
    expect(commentCountFromThread({ a: 1 }, 'a', 0)).toEqual({ a: 0 });
  });

  it('совпадение возвращает тот же объект — лента не перерисовывается', () => {
    const prev = { a: 3 };
    expect(commentCountFromThread(prev, 'a', 3)).toBe(prev);
  });

  it('закрытый тред ничего не меняет', () => {
    const prev = { a: 3 };
    expect(commentCountFromThread(prev, null, 0)).toBe(prev);
    expect(commentCountFromThread(prev, '', 0)).toBe(prev);
  });

  it('бессмысленная длина ничего не меняет', () => {
    const prev = { a: 3 };
    expect(commentCountFromThread(prev, 'a', -1)).toBe(prev);
    expect(commentCountFromThread(prev, 'a', 1.5)).toBe(prev);
    expect(commentCountFromThread(prev, 'a', Number.NaN)).toBe(prev);
    expect(commentCountFromThread(prev, 'a', Number.POSITIVE_INFINITY)).toBe(prev);
  });

  it('прежний объект не портится', () => {
    const prev = { a: 1 };
    const next = commentCountFromThread(prev, 'a', 4);
    expect(prev).toEqual({ a: 1 });
    expect(next).not.toBe(prev);
  });

  it('повтор с той же длиной устойчив', () => {
    const once = commentCountFromThread({ a: 0 }, 'a', 2);
    expect(commentCountFromThread(once, 'a', 2)).toBe(once);
  });

  it('тред, дважды выросший на одну строку, даёт ровно эти числа', () => {
    let counts: Record<string, number> = {};
    counts = commentCountFromThread(counts, 'p', 1);
    counts = commentCountFromThread(counts, 'p', 2);
    expect(counts).toEqual({ p: 2 });
  });
});

describe('экран ленты: догадок про счётчик не осталось', () => {
  it('прежние «плюс один» и «минус один» убраны', () => {
    expect(SCREEN).not.toContain('(prev[commentPostId] ?? 0) + 1');
    expect(SCREEN).not.toContain('Math.max(0, (prev[postId] ?? 1) - 1)');
  });

  it('счётчик открытой записи сводится с длиной списка', () => {
    expect(SCREEN).toContain(
      'setCommentCounts((prev) => commentCountFromThread(prev, commentPostId, comments.length));',
    );
  });

  it('сводится только по прочитанному треду', () => {
    expect(SCREEN).toContain("if (!commentPostId || commentsLoadedFor !== commentPostId) return;");
    expect(SCREEN).toContain('const [commentsLoadedFor, setCommentsLoadedFor] = useState<string | null>(null);');
  });

  it('«прочитан» ставится и при открытии, и при перезагрузке треда', () => {
    expect(SCREEN).toContain('if (commentPostIdRef.current === postId) setCommentsLoadedFor(postId);');
    expect(SCREEN).toContain('if (commentPostIdRef.current === forPostId) setCommentsLoadedFor(forPostId);');
  });

  it('открытие и закрытие треда снимают отметку «прочитан»', () => {
    // Иначе ноль от прошлой записи попал бы в счётчик следующей.
    const decl = SCREEN.indexOf('const [commentsLoadedFor');
    const resets = SCREEN.split('setCommentsLoadedFor(null)').length - 1;
    expect(decl).toBeGreaterThan(0);
    expect(resets).toBe(2);
  });

  it('сбой чтения треда не выдаёт себя за пустой тред', () => {
    expect(SCREEN).not.toContain('acceptCommentList(commentPostIdRef.current, postId, [], prev)');
    expect(SCREEN).toContain("showError(t('feed.commentsLoadFailed'))");
    expect(RU).toContain('"commentsLoadFailed"');
  });

  it('удаление комментария больше не берёт номер записи ради счётчика', () => {
    expect(SCREEN).toContain('const deleteComment = useCallback(async (commentId: string) => {');
    expect(SCREEN).toContain('void deleteComment(c.id) }');
  });
});

describe('экран ленты: подгрузка страницы сверяет версию до каждой записи', () => {
  const START = SCREEN.indexOf('const loadMoreFeed = useCallback');
  const END = SCREEN.indexOf('}, [feedOffset, feedHasMore', START);
  const BODY = SCREEN.slice(START, END);

  it('тело подгрузки найдено', () => {
    expect(START).toBeGreaterThan(0);
    expect(END).toBeGreaterThan(START);
  });

  it('проверка версии живёт в одном месте и зовётся после каждого ожидания', () => {
    expect(BODY).toContain('const stillOurs = (): boolean => isMountedRef.current && loadVersionRef.current === startVersion;');
    expect(BODY.split('if (!stillOurs()) return;').length - 1).toBe(3);
  });

  it('каждая правка карт стоит после проверки', () => {
    for (const setter of ['setMediaUrlsMap((prev)', 'setCommentCounts((prev) => ({ ...prev, ...counts }))', 'setViewCounts((prev)']) {
      const at = BODY.indexOf(setter);
      expect(at).toBeGreaterThan(0);
      expect(BODY.lastIndexOf('if (!stillOurs()) return;', at)).toBeGreaterThan(0);
    }
  });

  it('уход с экрана обрывает подгрузку сразу после чтения страницы', () => {
    const read = BODY.indexOf('const page = await loadFeedPosts(FEED_PAGE, feedOffset);');
    expect(read).toBeGreaterThan(0);
    expect(BODY.slice(read, read + 200)).toContain('if (!isMountedRef.current) return;');
  });
});
