/**
 * «Архив пуст» и «Нет закладок» перестали говориться вместо «не прочиталось»
 * (v4.32.1070).
 *
 * ДЕФЕКТ. Лента с v4.32.528 отличает отказ базы от пустоты и пишет «Не удалось
 * открыть ленту». Два боковых списка того же экрана — архив и закладки —
 * читаются своими вызовами, тоже отдающими `DbRead`, но их отказ доходил
 * только до журнала: `applyIfRead` пустоту не применял, состояние оставалось
 * `[]`, и рисовалось пустое состояние. Обе ветки стоят в разборе выше
 * `feedReadFailed`, так что и его они перебивали.
 *
 * ЦЕНА. «Архив пуст» с советом, как что-нибудь туда положить, при полном
 * архиве. Спрятанных публикаций нет больше нигде: единственное место, где они
 * есть, сказало, что их нет. Отказ базы чаще всего в первую секунду после
 * запуска — тогда в архив и заходят.
 *
 * ПРАВКА. Исход чтения обоих списков доходит до экрана: заголовок называет
 * отказ своим именем, подпись говорит, что записи на месте, рядом стоит
 * «Повторить», а совет «как наполнить список» показывается только при честной
 * пустоте.
 *
 * ГРАНИЦЫ. Только пустой список. Непустой ничего о своей полноте не
 * утверждает, и второй надписи над ним не появляется.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  feedListEmptyHint,
  feedListEmptyIcon,
  feedListEmptyTitle,
  FEED_LIST_RETRY,
} from '../../utils/feedListUnread';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const FEED = (): string =>
  codeOnly(readFileSync(join(__dirname, '..', 'FeedScreen.tsx'), 'utf8'));

describe('слова пустого состояния', () => {
  it('прочитанный и правда пустой список говорит «пусто»', () => {
    expect(feedListEmptyTitle('archive', false)).toBe('Архив пуст');
    expect(feedListEmptyTitle('bookmarks', false)).toBe('Нет закладок');
  });

  it('непрочитанный список не называет себя пустым', () => {
    expect(feedListEmptyTitle('archive', true)).toBe('Архив не прочитался');
    expect(feedListEmptyTitle('bookmarks', true)).toBe('Закладки не прочитались');
    expect(feedListEmptyTitle('archive', true)).not.toContain('пуст');
    expect(feedListEmptyTitle('bookmarks', true)).not.toContain('Нет');
  });

  it('подпись отказа говорит, что записи на месте, и почему их не видно', () => {
    for (const kind of ['archive', 'bookmarks'] as const) {
      const t = feedListEmptyHint(kind, true);
      expect(t).toContain('на месте');
      expect(t).toContain('открыть их сейчас не вышло');
      expect(t).toContain('в первую секунду после запуска');
    }
  });

  it('совет «как наполнить» остаётся только у честной пустоты', () => {
    expect(feedListEmptyHint('archive', false)).toContain('Архивировать');
    expect(feedListEmptyHint('bookmarks', false)).toContain('иконку закладки');
    // Под отказом чтения этот совет и есть враньё: класть туда ничего не надо.
    expect(feedListEmptyHint('archive', true)).not.toContain('Архивировать');
    expect(feedListEmptyHint('bookmarks', true)).not.toContain('иконку закладки');
  });

  it('у отказа свой значок — тот же, что у сорванного чтения ленты', () => {
    expect(feedListEmptyIcon('archive', true)).toBe('⚠️');
    expect(feedListEmptyIcon('bookmarks', true)).toBe('⚠️');
    expect(feedListEmptyIcon('archive', false)).toBe('📥');
    expect(feedListEmptyIcon('bookmarks', false)).toBe('🔖');
  });

  it('ГРАНИЦА: правило чистое — одни и те же доводы дают один и тот же ответ', () => {
    expect(feedListEmptyTitle('archive', true)).toBe(feedListEmptyTitle('archive', true));
    expect(feedListEmptyHint('bookmarks', false)).toBe(feedListEmptyHint('bookmarks', false));
  });
});

describe('форма исходника экрана', () => {
  it('исход чтения обоих списков доходит до состояния', () => {
    const f = FEED();
    expect(f).toContain('const [bookmarksUnread, setBookmarksUnread] = useState(false);');
    expect(f).toContain('const [archiveUnread, setArchiveUnread] = useState(false);');
    expect(f).toContain("applyIfRead(setBookmarkedPosts, 'bookmarks_enter', setBookmarksUnread),");
    expect(f).toContain("applyIfRead(setBookmarkedPosts, 'bookmarks_toggle', setBookmarksUnread),");
    expect(f).toContain("applyIfRead(setArchivedPosts, 'archive_reload', setArchiveUnread),");
    expect(f).toContain('setArchiveUnread(true);');
    expect(f).toContain('setArchiveUnread(false);');
    // Чтение обоих списков вынесено в отдельные формы: их зовёт и вход в
    // режим, и «Повторить». Прежде вход читал архив прямо в useEffect.
    expect(f).toContain('if (archiveFilter) void loadArchiveFirstPage();');
    expect(f).toContain('if (bookmarkFilter) void loadBookmarks();');
  });

  it('общая обёртка сообщает исход, а не только пишет в журнал', () => {
    const f = FEED();
    const at = f.indexOf('function applyIfRead(');
    expect(at).toBeGreaterThan(0);
    const end = f.indexOf('\n}', at);
    const body = f.slice(at, end);
    expect(body).toContain('mark?: (unreadable: boolean) => void,');
    expect(body).toContain('mark?.(false);');
    expect(body).toContain('mark?.(true);');
    // Пустота от отказа по-прежнему не доезжает до списка.
    expect(body).toContain('if (shouldApplyRows(rows)) {');
  });

  it('оба пустых состояния спрашивают правило, а не пишут слова сами', () => {
    const f = FEED();
    expect(f).toContain("{feedListEmptyTitle('archive', archiveUnread)}");
    expect(f).toContain("{feedListEmptyHint('archive', archiveUnread)}");
    expect(f).toContain("{feedListEmptyTitle('bookmarks', bookmarksUnread)}");
    expect(f).toContain("{feedListEmptyHint('bookmarks', bookmarksUnread)}");
    // Прежних дословных строк на экране не осталось — иначе они разъедутся.
    expect(f).not.toContain('>Архив пуст<');
    expect(f).not.toContain('>Нет закладок<');
    expect(f).not.toContain('Нажмите иконку закладки в карточке публикации');
  });

  it('«Повторить» стоит у обоих списков и перечитывает свой', () => {
    const f = FEED();
    const a = f.indexOf('testID="feed_archive_unread_retry"');
    expect(a).toBeGreaterThan(0);
    expect(f.slice(a - 400, a)).toContain('void loadArchiveFirstPage();');
    const b = f.indexOf('testID="feed_bookmarks_unread_retry"');
    expect(b).toBeGreaterThan(0);
    expect(f.slice(b - 400, b)).toContain('void loadBookmarks();');
    // И только под отказом: при честной пустоте перечитывать нечего.
    expect(f).toContain('{archiveUnread ? (');
    expect(f).toContain('{bookmarksUnread ? (');
  });

  it('подпись отказа показана янтарём — вторым сигналом', () => {
    const f = FEED();
    expect(f).toContain('style={[styles.empty, archiveUnread && { color: colors.warning }]}');
    expect(f).toContain('style={[styles.empty, bookmarksUnread && { color: colors.warning }]}');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежнее поведение экрана цело', () => {
  it('сорванное чтение самой ленты по-прежнему названо своим именем', () => {
    const f = FEED();
    expect(f).toContain('const [feedReadFailed, setFeedReadFailed] = useState(false);');
    expect(f).toContain('setFeedReadFailed(true);');
    expect(f).toContain('Не удалось открыть ленту');
  });

  it('вход в архив по-прежнему сбрасывает страницу и знает про «есть ещё»', () => {
    const f = FEED();
    expect(f).toContain('setArchiveOffset(0);');
    expect(f).toContain('setArchiveHasMore(true);');
    expect(f).toContain('if (first.length < FEED_PAGE) setArchiveHasMore(false);');
    // Смысл, а не написание: вход в режим по-прежнему читает первую
    // страницу архива, а вход в закладки — закладки.
    expect(f).toContain('if (archiveFilter)');
    expect(f).toContain('if (bookmarkFilter)');
    expect(f).toContain('listArchivedFeedPosts(FEED_PAGE, 0)');
    expect(f).toContain('listBookmarkedFeedPosts()');
  });

  it('пустой архив, который правда опустел, применяется как прежде', () => {
    const f = FEED();
    expect(f).toContain('setArchivedPosts([...first]);');
    expect(f).toContain('setArchiveOffset(first.length);');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('оба чтения по-прежнему умеют ответить отказом', () => {
    const svc = codeOnly(
      readFileSync(join(__dirname, '..', '..', '..', 'core', 'social', 'feedService.ts'), 'utf8'),
    );
    expect(svc).toContain('export async function listBookmarkedFeedPosts(): Promise<DbRead<FeedPostRow>> {');
    expect(svc).toContain('export async function listArchivedFeedPosts(');
    expect(svc).toContain("log.warn('feed_bookmarked_read_failed'");
    expect(svc).toContain("log.warn('feed_archived_read_failed'");
  });

  it('обе ветки по-прежнему стоят выше ветки «лента не открылась»', () => {
    // Ради этого исход и понадобился: сорванное чтение ленты их не перебьёт.
    const f = FEED();
    const arch = f.indexOf(') : archiveFilter ? (');
    const book = f.indexOf(') : bookmarkFilter ? (');
    const fail = f.indexOf(') : feedReadFailed ? (');
    expect(arch).toBeGreaterThan(0);
    expect(book).toBeGreaterThan(arch);
    expect(fail).toBeGreaterThan(book);
  });
});

describe('ЗАКРЕПКА', () => {
  it('правило лежит отдельно от экрана и без импортов', () => {
    const rule = readFileSync(join(__dirname, '..', '..', 'utils', 'feedListUnread.ts'), 'utf8');
    expect(codeOnly(rule)).not.toContain('import ');
  });

  it('слово кнопки одно на оба списка', () => {
    expect(FEED_LIST_RETRY).toBe('Повторить');
  });
});
