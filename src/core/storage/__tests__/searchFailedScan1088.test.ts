/**
 * ДЕФЕКТ. Все четыре поиска по сообщениям обёрнуты в try/catch, и из catch
 * выходило `{ items: [], scan: emptySearchScan() }`. Форму со счётом завели в
 * v4.32.581 ровно затем, чтобы «не найдено» никогда не говорилось наугад, —
 * но пустой счёт означает «обошли ноль строк, непрочитанных ноль», а это
 * буква в букву та же картина, что у честно не нашедшего запроса в пустой
 * переписке. Отличить их вызывающему было нечем.
 *
 * ЦЕНА. База не открылась (ключ данных не достался, файл заблокирован другим
 * процессом, запрос упал) — и человек видит «Ничего не найдено» без единой
 * оговорки. Вывод, которого никто не делал, подан как факт о его переписке.
 * Хуже всего это в глобальном поиске: туда идут искать то, о чём точно
 * помнят, что оно было.
 *
 * ПРАВКА. У счёта появился третий, названный исход — `failed`. Из catch
 * выходит `failedSearchScan()`, и обе человеческие строки (полная и короткая)
 * говорят о срыве раньше, чем считают непрочитанное. Экраны, где вместо
 * выдачи стоит подпись, спрашивают `searchDidFail` и не произносят «Ничего не
 * найдено».
 *
 * ГРАНИЦЫ. Ранний выход по пустому запросу остаётся `emptySearchScan()`: он
 * ничего не искал по своей воле, жаловаться не на что. Счёт непрочитанных
 * строк (v4.32.581) работает как прежде — срыв только встаёт перед ним.
 */
import fs from 'fs';
import path from 'path';
import {
  emptySearchScan,
  failedSearchScan,
  noteSearchedRow,
  searchDidFail,
  searchSkippedBadge,
  searchSkippedNotice,
  SEARCH_FAILED_NOTICE,
  SEARCH_FAILED_TEXT,
} from '../searchScan';

const root = path.resolve(__dirname, '../../../..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

const LOCAL = (): string => read('src/core/storage/local.ts');
const SCAN = (): string => read('src/core/storage/searchScan.ts');
const CHAT_LIST = (): string => read('src/ui/screens/ChatListScreen.tsx');
const GROUPS = (): string => read('src/ui/screens/GroupsScreen.tsx');

const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники прочитаны', () => {
    expect(LOCAL().length).toBeGreaterThan(100000);
    expect(SCAN().length).toBeGreaterThan(1000);
    expect(CHAT_LIST().length).toBeGreaterThan(20000);
    expect(GROUPS().length).toBeGreaterThan(20000);
  });

  it('модуль счёта по-прежнему ни от чего не зависит', () => {
    const imports = SCAN().match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import { pluralRu } from './ruPlural';"]);
  });

  it('все четыре поиска на месте и каждый обёрнут в catch', () => {
    const src = LOCAL();
    for (const name of [
      'searchGroupMessages',
      'searchAllGroupMessages',
      'searchMessages',
      'searchChatMessages',
    ]) {
      expect(src).toContain(`export async function ${name}(`);
    }
    expect((src.match(/log\.warn\('search_\w+_failed'/g) ?? []).length).toBe(4);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('поиски по-прежнему глушат ошибку и отдают пустую выдачу', () => {
    const src = codeOnly(LOCAL());
    expect((src.match(/return \{ items: \[\], scan: \w+SearchScan\(\) \};/g) ?? []).length).toBe(8);
  });

  it('счёт непрочитанных строк работает как прежде', () => {
    const scan = emptySearchScan();
    noteSearchedRow(scan, true);
    noteSearchedRow(scan, false);
    expect(scan.scanned).toBe(2);
    expect(scan.unreadable).toBe(1);
    expect(searchSkippedNotice(scan)).toContain('оно не участвовало в поиске');
    expect(searchSkippedBadge(scan)).toBe('⚠ 1');
  });

  it('экраны по-прежнему держат подпись вместо выдачи', () => {
    expect(CHAT_LIST()).toContain('Ничего не найдено');
    expect(GROUPS()).toContain('Введите запрос для поиска');
  });

  it('пометка о непрочитанном по-прежнему стоит выше выдачи', () => {
    const src = CHAT_LIST();
    expect(src.indexOf('searchSkippedNotice(globalSearchScan)')).toBeGreaterThan(-1);
    expect(src.indexOf('globalSearchResults.map(')).toBeGreaterThan(
      src.indexOf('searchSkippedNotice(globalSearchScan)')
    );
  });
});

describe('срыв поиска — отдельный, названный исход', () => {
  it('пустой счёт и сорвавшийся различимы', () => {
    expect(searchDidFail(emptySearchScan())).toBe(false);
    expect(searchDidFail(failedSearchScan())).toBe(true);
    expect(emptySearchScan()).not.toEqual(failedSearchScan());
  });

  it('у сорвавшегося поиска строк не обойдено ни одной', () => {
    const scan = failedSearchScan();
    expect(scan.scanned).toBe(0);
    expect(scan.unreadable).toBe(0);
  });

  it('полная строка говорит о срыве и прямо отрицает ложный вывод', () => {
    const notice = searchSkippedNotice(failedSearchScan());
    expect(notice).toBe(SEARCH_FAILED_NOTICE);
    expect(notice).toContain('не значит, что ничего нет');
    expect(notice).not.toContain('не удалось прочитать');
  });

  it('короткая пометка есть, но числа в ней нет — считать было нечего', () => {
    expect(searchSkippedBadge(failedSearchScan())).toBe('⚠');
    expect(searchSkippedBadge(failedSearchScan())).not.toContain('0');
  });

  it('срыв говорит о себе раньше счёта непрочитанных', () => {
    const scan = failedSearchScan();
    scan.unreadable = 5;
    scan.scanned = 40;
    expect(searchSkippedNotice(scan)).toBe(SEARCH_FAILED_NOTICE);
    expect(searchSkippedBadge(scan)).toBe('⚠');
  });

  it('searchDidFail не спотыкается об отсутствующий счёт', () => {
    expect(searchDidFail(null)).toBe(false);
    expect(searchDidFail(undefined)).toBe(false);
  });
});

describe('все четыре поиска отличают отказ от пустой выдачи', () => {
  const BOUNDS: Array<[string, string, string]> = [
    ['searchGroupMessages', 'export async function searchGroupMessages(', '// ─── Cross-Group Message Search'],
    ['searchAllGroupMessages', 'export async function searchAllGroupMessages(', '// v4.32.301: updateGroupMessageReactions'],
    ['searchMessages', 'export async function searchMessages(', ' * Поиск внутри одной личной переписки.'],
    ['searchChatMessages', 'export async function searchChatMessages(', 'export async function listConversationMedia('],
  ];

  it.each(BOUNDS)('%s: из catch выходит именно сорвавшийся счёт', (_n, from, to) => {
    const body = codeOnly(slice(LOCAL(), from, to));
    const catchIdx = body.indexOf('} catch (e) {');
    expect(catchIdx).toBeGreaterThan(-1);
    const tail = body.slice(catchIdx);
    expect(tail).toContain('return { items: [], scan: failedSearchScan() };');
    expect(tail).not.toContain('emptySearchScan()');
  });

  it.each(BOUNDS)('%s: ранний выход по пустому запросу срывом не считается', (_n, from, to) => {
    const body = codeOnly(slice(LOCAL(), from, to));
    const head = body.slice(0, body.indexOf('} catch (e) {'));
    expect(head).toContain("if (!query.trim()) return { items: [], scan: emptySearchScan() };");
    expect(head).not.toContain('failedSearchScan()');
  });

  it('сорвавшийся счёт заводится ровно по разу на каждый поиск', () => {
    const src = codeOnly(LOCAL());
    expect((src.match(/failedSearchScan\(\)/g) ?? []).length).toBe(4);
  });
});

describe('экраны не произносят «Ничего не найдено» над сорвавшимся поиском', () => {
  it('список чатов: подпись выбирается по исходу поиска', () => {
    const src = codeOnly(CHAT_LIST());
    const empty = slice(src, ') : searchQuery ? (', ') : convReadFailed ? (');
    expect(empty).toContain('searchDidFail(globalSearchScan)');
    expect(empty).toContain('SEARCH_FAILED_TEXT');
    expect(empty).toContain("'Ничего не найдено'");
    // Подпись о срыве стоит перед подписью о пустоте: иначе ветка не та.
    expect(empty.indexOf('SEARCH_FAILED_TEXT')).toBeLessThan(empty.indexOf("'Ничего не найдено'"));
  });

  it('список чатов: слово о срыве берётся из общего места, а не пишется заново', () => {
    const src = CHAT_LIST();
    expect(src).toContain("SEARCH_FAILED_TEXT, searchDidFail, searchSkippedNotice");
    expect(src).not.toContain("'Поиск не выполнился'");
  });

  it('группы: подпись поиска тоже выбирается по исходу', () => {
    const src = codeOnly(GROUPS());
    const empty = slice(src, '{searchVisible\n', "'Введите запрос для поиска'");
    expect(empty).toContain('searchDidFail(searchScan)');
    expect(empty).toContain('SEARCH_FAILED_TEXT');
    expect(empty).toContain("'Ничего не найдено'");
  });

  it('группы: слово о срыве тоже общее', () => {
    const src = GROUPS();
    expect(src).toContain('SEARCH_FAILED_TEXT, searchDidFail, searchSkippedBadge');
    expect(src).not.toContain("'Поиск не выполнился'");
  });

  it('подпись и развёрнутая строка — не одно и то же, но об одном', () => {
    expect(SEARCH_FAILED_TEXT).toBe('Поиск не выполнился');
    expect(SEARCH_FAILED_NOTICE.startsWith(SEARCH_FAILED_TEXT)).toBe(true);
    expect(SEARCH_FAILED_NOTICE.length).toBeGreaterThan(SEARCH_FAILED_TEXT.length);
  });
});

describe('ГРАНИЦА', () => {
  it('удачный поиск о срыве не заикается', () => {
    const scan = emptySearchScan();
    noteSearchedRow(scan, true);
    noteSearchedRow(scan, true);
    expect(searchDidFail(scan)).toBe(false);
    expect(searchSkippedNotice(scan)).toBeNull();
    expect(searchSkippedBadge(scan)).toBeNull();
  });

  it('мусорное число по-прежнему не превращается в строку', () => {
    expect(searchSkippedNotice({ scanned: 0, unreadable: Number.NaN, failed: false })).toBeNull();
    expect(searchSkippedNotice({ scanned: 0, unreadable: -3, failed: false })).toBeNull();
    expect(searchSkippedBadge({ scanned: 0, unreadable: Number.NaN, failed: false })).toBeNull();
  });

  it('счётчики срыва не подмешиваются в человеческое число', () => {
    const scan = emptySearchScan();
    noteSearchedRow(scan, false);
    noteSearchedRow(scan, false);
    expect(searchSkippedNotice(scan)).toContain('2 сообщения');
    expect(searchSkippedBadge(scan)).toBe('⚠ 2');
  });
});
