/**
 * Рэтчет к v4.32.539 — страница старых сообщений отсчитывается от строки.
 *
 * Ниже два слоя. Первый — поведение чистого модуля: он обязан резать выборку
 * ровно так же, как `ORDER BY created_at DESC, id DESC` в SQLite, и не терять
 * позицию прокрутки, когда добавлять нечего. Второй — форма вызывающих мест:
 * стоит вернуть `OFFSET`, замок из состояния или слияние без сверки по id —
 * и дефект возвращается целиком, тихо и без падений.
 */
import fs from 'fs';
import path from 'path';

import {
  isOlderThan,
  isValidCursor,
  mergeOlderPage,
  oldestCursor,
  type ChatPageCursor,
} from '../chatPageCursor';

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8');

const LOCAL = read('../local.ts');
const MESSAGING = read('../../social/messaging.ts');
const CHAT = read('../../../ui/screens/ChatScreen.tsx');

/** Тело функции: от строки-заголовка до первой закрывающей скобки в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

/** Тело useCallback: от заголовка до строки `  }, [` — закрытия на нулевой колонке у него нет. */
function callbackBody(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n  }, [');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

const row = (createdAt: number, id: string) => ({ createdAt, id });

describe('chatPageCursor: пригодность курсора', () => {
  it('строка переписки годится в курсор', () => {
    expect(isValidCursor(row(5, 'a'))).toBe(true);
  });

  it('пустой id не курсор — он не отрезал бы ничего', () => {
    expect(isValidCursor(row(5, ''))).toBe(false);
  });

  it('NaN во времени не курсор — сравнение с ним всегда ложно', () => {
    expect(isValidCursor(row(NaN, 'a'))).toBe(false);
  });

  it('null и строка курсором не считаются', () => {
    expect(isValidCursor(null)).toBe(false);
    expect(isValidCursor('a')).toBe(false);
  });
});

describe('chatPageCursor: что старше', () => {
  const cur: ChatPageCursor = { createdAt: 100, id: 'm5' };

  it('раньше по времени — старше', () => {
    expect(isOlderThan(row(99, 'zzz'), cur)).toBe(true);
  });

  it('позже по времени — не старше, даже с меньшим id', () => {
    expect(isOlderThan(row(101, 'a'), cur)).toBe(false);
  });

  it('то же время решается по id', () => {
    expect(isOlderThan(row(100, 'm4'), cur)).toBe(true);
    expect(isOlderThan(row(100, 'm6'), cur)).toBe(false);
  });

  it('сама строка курсора не старше себя — иначе она пришла бы дважды', () => {
    expect(isOlderThan(row(100, 'm5'), cur)).toBe(false);
  });

  it('id сравнивается побайтно, как BINARY в SQLite, а не по алфавиту языка', () => {
    // 'Z' (0x5A) меньше 'a' (0x61) побайтно, но localeCompare даёт обратное.
    expect(isOlderThan(row(100, 'Z'), { createdAt: 100, id: 'a' })).toBe(true);
    expect('Z'.localeCompare('a')).toBeGreaterThan(0);
  });
});

describe('chatPageCursor: самая старая строка страницы', () => {
  it('находит минимум независимо от порядка входа', () => {
    expect(oldestCursor([row(5, 'b'), row(3, 'z'), row(9, 'a')])).toEqual({ createdAt: 3, id: 'z' });
  });

  it('при равном времени берёт меньший id', () => {
    expect(oldestCursor([row(3, 'b'), row(3, 'a')])).toEqual({ createdAt: 3, id: 'a' });
  });

  it('пустая страница курсора не даёт', () => {
    expect(oldestCursor([])).toBeNull();
  });

  it('строки без пригодных полей пропускаются', () => {
    expect(oldestCursor([row(NaN, 'x'), row(7, 'q')])).toEqual({ createdAt: 7, id: 'q' });
  });

  it('страница из одних служебных строк всё равно двигает отсчёт', () => {
    // Заглушки на экран не попадают, но курсор обязаны сдвинуть — иначе
    // следующий запрос вернёт ту же самую страницу и подгрузка встанет.
    const stubs = [row(20, 's2'), row(19, 's1')];
    expect(oldestCursor(stubs)).toEqual({ createdAt: 19, id: 's1' });
  });
});

describe('chatPageCursor: слияние страницы', () => {
  const prev = [{ id: 'a' }, { id: 'b' }];

  it('дописывает новое в конец', () => {
    expect(mergeOlderPage(prev, [{ id: 'c' }])).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('второй экземпляр строки не проходит', () => {
    expect(mergeOlderPage(prev, [{ id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a' }, { id: 'b' }, { id: 'c' },
    ]);
  });

  it('дубли внутри самой страницы тоже режутся', () => {
    expect(mergeOlderPage(prev, [{ id: 'c' }, { id: 'c' }])).toHaveLength(3);
  });

  it('пустая страница возвращает ТОТ ЖЕ список — прокрутка не прыгает', () => {
    expect(mergeOlderPage(prev, [])).toBe(prev);
  });

  it('страница целиком из уже показанного тоже возвращает тот же список', () => {
    expect(mergeOlderPage(prev, [{ id: 'a' }, { id: 'b' }])).toBe(prev);
  });

  it('прежний список не меняется на месте', () => {
    const before = [...prev];
    mergeOlderPage(prev, [{ id: 'c' }]);
    expect(prev).toEqual(before);
  });
});

describe('слой базы: выборка режется курсором, а не числом', () => {
  // v4.32.604: сам запрос переехал в приватный listChatMessagesPage — публичная
  // listChatMessages стала обёрткой над ним. Проверяем там, где живёт SQL.
  const LIST = (): string => bodyOf(LOCAL, 'async function listChatMessagesPage(');

  it('ключевой запрос сравнивает время и id парой', () => {
    expect(LIST()).toContain('(created_at < ? OR (created_at = ? AND id < ?))');
  });

  it('порядок сортировки совпадает с порядком курсора', () => {
    expect(LIST()).toContain('ORDER BY created_at DESC, id DESC LIMIT ?');
  });

  it('курсорная ветка не тащит с собой OFFSET', () => {
    const sql = LIST();
    const from = sql.indexOf('AND (created_at < ?');
    const to = sql.indexOf("        : 'SELECT", from);
    expect(to).toBeGreaterThan(from);
    expect(sql.slice(from, to)).not.toContain('OFFSET');
  });

  it('в курсорную ветку не передаётся offset', () => {
    expect(LIST()).toContain(
      '[contactPubB64, ownerProfileId, before.createdAt, before.createdAt, before.id, limit]',
    );
  });

  it('поле объявлено в типе страницы', () => {
    expect(LOCAL).toContain('before?: ChatPageCursor;');
    expect(LOCAL).toContain("import type { ChatPageCursor } from './chatPageCursor';");
  });
});

describe('слой сервиса: три величины считаются по неотфильтрованным строкам', () => {
  const OLDER = (): string => bodyOf(MESSAGING, '  async getOlderMessages(');

  it('признак «есть ещё» берётся от сырых строк', () => {
    expect(OLDER()).toContain('hasMore: rows.length >= limit');
    expect(OLDER()).not.toContain('messages.length >= limit');
  });

  it('курсор берётся от сырых строк', () => {
    expect(OLDER()).toContain('cursor: oldestCursor(rows)');
  });

  it('фильтр служебных строк применяется только к выдаче', () => {
    expect(OLDER()).toContain(".filter((r) => r.text !== '\\u200b')");
  });

  it('запрос уходит с нулевым смещением — окно задаёт курсор', () => {
    expect(OLDER()).toContain('offset: 0');
  });
});

describe('экран переписки: подгрузка старых', () => {
  const LOAD = (): string => callbackBody(CHAT, '  const loadOlder = useCallback(async () => {');

  it('смещение по длине списка не вернулось', () => {
    expect(LOAD()).not.toContain('lines.length');
    expect(CHAT).not.toContain('svc.getMessages(peerB64, PAGE, lines.length)');
  });

  it('страница берётся курсором', () => {
    expect(LOAD()).toContain('svc.getOlderMessages(peerB64, PAGE, cursor)');
  });

  it('без курсора запрос не уходит — иначе вернётся первая же страница', () => {
    expect(LOAD()).toContain('if (!cursor) return;');
  });

  it('замок держится в ref: состояние не успевает дойти до второго касания', () => {
    expect(LOAD()).toContain('loadingMoreRef.current');
    expect(LOAD()).not.toContain('if (!hasMore || loadingMore ');
    expect(CHAT).toContain('const loadingMoreRef = useRef(false);');
  });

  it('замок снимается в finally', () => {
    expect(LOAD()).toContain('loadingMoreRef.current = false;');
  });

  it('чужой курсор не затирается: перезагрузка во время запроса переживается', () => {
    expect(LOAD()).toContain('if (olderCursorRef.current === cursor)');
  });

  it('пустая страница не сбрасывает курсор в null', () => {
    expect(LOAD()).toContain('page.cursor ?? cursor');
  });

  it('слияние идёт через сверку по id', () => {
    expect(LOAD()).toContain('mergeOlderPage(prev, page.messages)');
    expect(LOAD()).not.toContain('[...prev, ...batch');
  });

  it('после размонтирования экран не трогается', () => {
    expect(LOAD()).toContain('if (!isMountedRef.current) return;');
  });

  it('сбой подгрузки виден человеку, а не только в журнале', () => {
    expect(LOAD()).toContain('chat_load_older_failed');
    expect(LOAD()).toContain('Не удалось загрузить старые сообщения');
  });

  it('первая страница задаёт курсор, а сброс переписки его очищает', () => {
    const RELOAD = callbackBody(CHAT, '  const reloadThread = useCallback(async () => {');
    expect(RELOAD).toContain('svc.getOlderMessages(peerB64, PAGE, null)');
    expect(RELOAD).toContain('olderCursorRef.current = page.cursor;');
    expect(RELOAD).toContain('olderCursorRef.current = null;');
    expect(RELOAD).toContain('setHasMore(page.hasMore);');
  });

  it('признак загрузки наконец показывается, а не только считается', () => {
    expect(CHAT).toContain('ListFooterComponent={');
    expect(CHAT).toContain('loadingMore ? (');
  });
});
