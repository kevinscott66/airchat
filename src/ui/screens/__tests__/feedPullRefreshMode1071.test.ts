/**
 * «Потянуть вниз» в «Архиве» и «Закладках» перестало быть пустым жестом
 * (v4.32.1071).
 *
 * ДЕФЕКТ. `onRefresh` звал один `loadFeed()`. Основная лента им и читается, а
 * два боковых режима того же экрана — «Архив» и «Закладки» — читают свои
 * списки своими вызовами. В этих режимах жест крутил бегунок и не перечитывал
 * ничего.
 *
 * ЦЕНА. Бегунок — знак «обновлено»: человек получал его над тем же самым.
 * Хуже всего это ложилось на отказ чтения (v4.32.1070): текст ленты учит
 * «потяните список вниз, чтобы повторить», и человек, увидев в архиве
 * «не прочитался», тянул вниз — повтора не происходило, а вывод напрашивался
 * ровно тот, от которого v4.32.1070 и защищает: «архив правда пуст».
 *
 * ПРАВКА. Обновляется тот список, который сейчас на экране. Обработчик
 * переехал ниже по файлу — к чтениям боковых списков, объявленным вместе с их
 * состоянием; замок от двойного жеста остался на прежнем месте и цел.
 *
 * ГРАНИЦЫ. Подгрузка следующих страниц не трогается: она про хвост списка, а
 * не про его голову.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const FEED = (): string =>
  codeOnly(readFileSync(join(__dirname, '..', 'FeedScreen.tsx'), 'utf8'));

describe('жест обновляет тот список, который виден', () => {
  it('в каждом из трёх режимов перечитывается свой список', () => {
    const f = FEED();
    const at = f.indexOf('const onRefresh = useCallback(async () => {');
    expect(at).toBeGreaterThan(0);
    const end = f.indexOf('\n  }, [', at);
    expect(end).toBeGreaterThan(at);
    const body = f.slice(at, end);
    expect(body).toContain('if (archiveFilter) await loadArchiveFirstPage();');
    expect(body).toContain('else if (bookmarkFilter) await loadBookmarks();');
    expect(body).toContain('else await loadFeed();');
  });

  it('оба боковых чтения объявлены ДО обработчика — иначе они бы не существовали', () => {
    const f = FEED();
    const book = f.indexOf('const loadBookmarks = useCallback(');
    const arch = f.indexOf('const loadArchiveFirstPage = useCallback(');
    const on = f.indexOf('const onRefresh = useCallback(');
    expect(book).toBeGreaterThan(0);
    expect(arch).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(arch);
    expect(on).toBeGreaterThan(book);
  });

  it('зависимости перечислены полностью — иначе жест застрянет в прежнем режиме', () => {
    const f = FEED();
    expect(f).toContain(
      '}, [loadFeed, archiveFilter, bookmarkFilter, loadArchiveFirstPage, loadBookmarks]);',
    );
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежнее поведение жеста цело', () => {
  it('замок от двойного жеста на месте и бегунок гасится всегда', () => {
    const f = FEED();
    const at = f.indexOf('const onRefresh = useCallback(async () => {');
    const end = f.indexOf('\n  }, [', at);
    const body = f.slice(at, end);
    expect(body).toContain('if (refreshLockRef.current) return;');
    expect(body).toContain('refreshLockRef.current = true;');
    expect(body).toContain('setRefreshing(true);');
    expect(body).toContain('} finally {');
    expect(body).toContain('setRefreshing(false);');
    expect(body).toContain('refreshLockRef.current = false;');
  });

  it('сам замок объявлен один раз и по-прежнему ref, а не состояние', () => {
    const f = FEED();
    expect(f).toContain('const refreshLockRef = useRef(false);');
    expect(f.split('const refreshLockRef').length - 1).toBe(1);
  });

  it('жест по-прежнему подан в список ровно одним RefreshControl', () => {
    const f = FEED();
    expect(f).toContain(
      '<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />',
    );
    expect(f.split('<RefreshControl').length - 1).toBe(1);
  });

  it('ГРАНИЦА: подгрузка следующих страниц не тронута', () => {
    const f = FEED();
    expect(f).toContain('const loadMoreArchive = useCallback(async () => {');
    expect(f).toContain('if (!archiveFilter || archiveLoadingMore.current || !archiveHasMore) return;');
    expect(f).toContain('const decision = decidePage(page, FEED_PAGE);');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('боковые списки и правда читаются мимо loadFeed', () => {
    const f = FEED();
    // Если бы их читал сам loadFeed, одного вызова хватало бы.
    expect(f).toContain('listBookmarkedFeedPosts()');
    expect(f).toContain('listArchivedFeedPosts(FEED_PAGE, 0)');
    const at = f.indexOf('const loadFeed = useCallback(');
    expect(at).toBeGreaterThan(0);
    const end = f.indexOf('\n  }, [', at);
    const body = f.slice(at, end);
    expect(body).not.toContain('listBookmarkedFeedPosts');
    expect(body).not.toContain('listArchivedFeedPosts');
  });

  it('текст сорванного чтения ленты по-прежнему учит тянуть вниз', () => {
    const f = FEED();
    expect(f).toContain('Потяните список вниз, чтобы повторить.');
  });
});
