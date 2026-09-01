/**
 * v4.32.528: сбой чтения ленты не должен выглядеть как пустая лента.
 *
 * Поведенческая часть проверяет три исхода чтения, «исходники» — что цепочка
 * от `loadFeedPosts` до экрана действительно их различает, а не сводит обратно
 * к пустому списку.
 */
import fs from 'fs';
import path from 'path';

import { decidePage, isReadFailure, shouldApplyRows } from '../readResult';

const SRC = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

const MODULE = fs.readFileSync(path.join(__dirname, '..', 'readResult.ts'), 'utf8');
const SERVICE = SRC('core/social/feedService.ts');
const FEED_SCREEN = SRC('ui/screens/FeedScreen.tsx');
const PROFILE_SCREEN = SRC('ui/screens/ProfileScreen.tsx');

/** Тело одной экспортируемой функции: файл огромен, точечная проверка нужна по месту. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + 10);
  const end = rest.indexOf('\nexport ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('isReadFailure', () => {
  it('null — это сбой', () => {
    expect(isReadFailure(null)).toBe(true);
  });

  it('пустой массив — не сбой, это честно пустая лента', () => {
    expect(isReadFailure([])).toBe(false);
  });

  it('страница со строками — не сбой', () => {
    expect(isReadFailure([{ id: 'a' }])).toBe(false);
  });
});

describe('shouldApplyRows', () => {
  it('свежую голову применяем', () => {
    expect(shouldApplyRows([{ id: 'a' }])).toBe(true);
  });

  it('пустую голову тоже применяем: лента могла опустеть по-настоящему', () => {
    expect(shouldApplyRows([])).toBe(true);
  });

  it('сбой чтения не даёт права трогать список', () => {
    expect(shouldApplyRows(null)).toBe(false);
  });
});

describe('decidePage', () => {
  const page = (n: number): { id: string }[] =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));

  it('сбой: ничего не дописываем и про конец ленты не знаем', () => {
    expect(decidePage(null, 40)).toEqual({ apply: false, endOfList: false });
  });

  it('пустая страница: дописывать нечего, это конец', () => {
    expect(decidePage([], 40)).toEqual({ apply: false, endOfList: true });
  });

  it('неполная страница: дописываем и это конец', () => {
    expect(decidePage(page(7), 40)).toEqual({ apply: true, endOfList: true });
  });

  it('полная страница: дописываем и продолжаем', () => {
    expect(decidePage(page(40), 40)).toEqual({ apply: true, endOfList: false });
  });

  it('страница длиннее запрошенной всё равно не конец... точнее конец, лишнего не выдумываем', () => {
    expect(decidePage(page(41), 40)).toEqual({ apply: true, endOfList: false });
  });

  it('некорректный размер страницы: строки применяем, подгрузку останавливаем', () => {
    expect(decidePage(page(3), 0)).toEqual({ apply: true, endOfList: true });
    expect(decidePage(page(3), Number.NaN)).toEqual({ apply: true, endOfList: true });
    expect(decidePage(page(3), -5)).toEqual({ apply: true, endOfList: true });
  });
});

describe('исходники: сбой чтения отличим от пустоты по всей цепочке', () => {
  it('модуль без зависимостей', () => {
    expect(MODULE).not.toMatch(/^import /m);
  });

  it('loadFeedPosts возвращает null вместо пустого списка', () => {
    const body = fnBody(SERVICE, 'loadFeedPosts');
    expect(body).toContain('Promise<DbRead<FeedPostRow>>');
    expect(body).toContain('return null;');
    expect(body).toContain('feed_load_posts_failed');
    expect(body).not.toContain('return [];');
  });

  it('FeedScreen проверяет исход чтения до того, как трогает список', () => {
    expect(FEED_SCREEN).toContain("from '../../core/storage/readResult'");
    const guard = FEED_SCREEN.indexOf('if (!shouldApplyRows(read))');
    const merge = FEED_SCREEN.indexOf('mergeListHead(postsRef.current');
    expect(guard).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(guard);
    expect(FEED_SCREEN).toContain('setFeedReadFailed(true)');
    expect(FEED_SCREEN).toContain('setFeedReadFailed(false)');
  });

  it('подгрузка страницы больше не гасит «есть ещё» по пустому результату', () => {
    expect(FEED_SCREEN).toContain('decidePage(page, FEED_PAGE)');
    expect(FEED_SCREEN).toContain('if (decision.endOfList) setFeedHasMore(false);');
    expect(FEED_SCREEN).not.toContain('if (more.length === 0)');
    expect(FEED_SCREEN).not.toContain('if (more.length < FEED_PAGE) setFeedHasMore(false);');
  });

  it('пустое состояние отличает сбой от пустой ленты', () => {
    expect(FEED_SCREEN).toContain('feedReadFailed ?');
    expect(FEED_SCREEN).toContain('Не удалось открыть ленту');
    expect(FEED_SCREEN).toContain('Лента пуста');
  });

  it('архив и закладки читаются по тому же правилу', () => {
    for (const name of ['listBookmarkedFeedPosts', 'listArchivedFeedPosts']) {
      const body = fnBody(SERVICE, name);
      expect(body).toContain('Promise<DbRead<FeedPostRow>>');
      expect(body).toContain('return null;');
      expect(body).not.toContain('return [];');
    }
    expect(FEED_SCREEN).not.toContain('.then(setArchivedPosts)');
    expect(FEED_SCREEN).not.toContain('.then(setBookmarkedPosts)');
    expect(FEED_SCREEN).toContain('applyIfRead(setArchivedPosts');
    expect(FEED_SCREEN).toContain('applyIfRead(setBookmarkedPosts');
    expect(FEED_SCREEN).toContain('decidePage(page, FEED_PAGE)');
    expect(FEED_SCREEN).not.toContain('if (more.length < FEED_PAGE) setArchiveHasMore(false);');
  });

  it('ProfileScreen не показывает ноль публикаций из-за сбоя чтения', () => {
    expect(PROFILE_SCREEN).toContain('if (posts !== null) setPostCount(');
  });
});
