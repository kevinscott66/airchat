/**
 * v4.32.581 — поиск больше не выдаёт непрочитанное за отсутствующее.
 *
 * Все четыре поиска расшифровывали текст через `decryptAtRestString`, который
 * на неудаче отдаёт пустую строку. Непрочитанная строка не совпадала ни с
 * каким запросом и молча пропадала из выдачи: человеку показывали «0», «0/0»
 * или пустой список ровно так же, как если бы искомого никогда не было.
 * Проверки ниже держат и счёт, и человеческую строку, и то, что пометка на
 * всех четырёх экранах стоит ВЫШЕ (или РАНЬШЕ) обманчивого нуля.
 */
import fs from 'fs';
import path from 'path';
import {
  emptySearchScan,
  messageWordForCount,
  noteSearchedRow,
  searchSkippedBadge,
  searchSkippedNotice,
} from '../searchScan';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
const GROUPS = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
const CHAT = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'), 'utf8');
const CHAT_LIST = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatListScreen.tsx'), 'utf8');

/** Кусок исходника между двумя якорями — чтобы проверка не ловила чужую функцию. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('счёт непрочитанных строк в поиске', () => {
  it('пустой счёт ни на что не жалуется', () => {
    const scan = emptySearchScan();
    expect(scan).toEqual({ scanned: 0, unreadable: 0 });
    expect(searchSkippedNotice(scan)).toBeNull();
    expect(searchSkippedBadge(scan)).toBeNull();
  });

  it('считает и обойдённые строки, и непрочитанные', () => {
    const scan = emptySearchScan();
    noteSearchedRow(scan, true);
    noteSearchedRow(scan, false);
    noteSearchedRow(scan, true);
    expect(scan).toEqual({ scanned: 3, unreadable: 1 });
  });

  it('строка появляется ровно тогда, когда есть непрочитанное', () => {
    const scan = emptySearchScan();
    noteSearchedRow(scan, true);
    expect(searchSkippedNotice(scan)).toBeNull();
    noteSearchedRow(scan, false);
    expect(searchSkippedNotice(scan)).toBe('1 сообщение не удалось прочитать — оно не участвовало в поиске');
  });

  it('единственное непрочитанное говорит о себе в единственном числе', () => {
    expect(searchSkippedNotice({ scanned: 10, unreadable: 1 })).toContain('оно не участвовало');
    expect(searchSkippedNotice({ scanned: 10, unreadable: 2 })).toContain('они не участвовали');
  });

  it('склонение слова «сообщение» по русским правилам', () => {
    expect(messageWordForCount(1)).toBe('сообщение');
    expect(messageWordForCount(2)).toBe('сообщения');
    expect(messageWordForCount(4)).toBe('сообщения');
    expect(messageWordForCount(5)).toBe('сообщений');
    // 11–14 — исключение: «одиннадцать сообщений», а не «сообщение».
    expect(messageWordForCount(11)).toBe('сообщений');
    expect(messageWordForCount(12)).toBe('сообщений');
    expect(messageWordForCount(14)).toBe('сообщений');
    expect(messageWordForCount(21)).toBe('сообщение');
    expect(messageWordForCount(22)).toBe('сообщения');
    expect(messageWordForCount(111)).toBe('сообщений');
  });

  it('короткая пометка несёт то же число', () => {
    expect(searchSkippedBadge({ scanned: 40, unreadable: 7 })).toBe('⚠ 7');
    expect(searchSkippedBadge({ scanned: 40, unreadable: 0 })).toBeNull();
  });

  it('мусорное число не превращается в строку', () => {
    expect(searchSkippedNotice({ scanned: 0, unreadable: Number.NaN })).toBeNull();
    expect(searchSkippedNotice({ scanned: 0, unreadable: -3 })).toBeNull();
    expect(searchSkippedBadge({ scanned: 0, unreadable: Number.NaN })).toBeNull();
  });

  it('модуль ни от чего не зависит — счёт проверяется без базы и ключей', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'searchScan.ts'), 'utf8');
    // v4.32.584: единственная допустимая зависимость — такой же чистый модуль
    // с окончаниями. Ни базы, ни ключей, ни отрисовки здесь быть не должно.
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import { pluralRu } from './ruPlural';"]);
  });
});

describe('четыре поиска в local.ts читают текст трёхзначно', () => {
  const BOUNDS: Array<[string, string, string]> = [
    ['searchGroupMessages', 'export async function searchGroupMessages(', '// ─── Cross-Group Message Search'],
    ['searchAllGroupMessages', 'export async function searchAllGroupMessages(', '// v4.32.301: updateGroupMessageReactions'],
    ['searchMessages', 'export async function searchMessages(', ' * Поиск внутри одной личной переписки.'],
    ['searchChatMessages', 'export async function searchChatMessages(', '/** Returns all messages that have at least one media CID'],
  ];

  it.each(BOUNDS)('%s не глотает непрочитанную строку молча', (_name, from, to) => {
    const body = slice(LOCAL(), from, to);
    // Пустая строка от decryptAtRestString не совпадала ни с чем — это и была дыра.
    expect(body).not.toContain('decryptAtRestString(r.text, dek)');
    expect(body).toContain('const cell = readAtRestCell(r.text, dek);');
    expect(body).toContain("noteSearchedRow(scan, cell.state !== 'unreadable');");
    expect(body).toContain("if (cell.state === 'unreadable') continue;");
    expect(body).toContain("const plain = cellTextOrNull(cell) ?? '';");
  });

  it.each(BOUNDS)('%s отдаёт счёт вместе с выдачей — и на пустом запросе, и на отказе', (_name, from, to) => {
    const body = slice(LOCAL(), from, to);
    expect(body).toContain('const scan = emptySearchScan();');
    expect(body).toContain('return { items: out, scan };');
    // Ранний выход и catch тоже обязаны вернуть форму со счётом, иначе
    // вызывающий получит undefined вместо нуля.
    expect((body.match(/return \{ items: \[\], scan: emptySearchScan\(\) \};/g) ?? []).length).toBe(2);
  });

  it('счёт заводится один раз на каждый поиск, не больше', () => {
    expect((LOCAL().match(/const scan = emptySearchScan\(\);/g) ?? []).length).toBe(4);
  });
});

describe('экраны показывают пометку раньше обманчивого нуля', () => {
  it('поиск внутри группы: пометка стоит до счётчика совпадений', () => {
    const src = GROUPS();
    const effect = slice(src, 'void searchGroupMessages(', '}, [searchQuery, searchVisible, group.id, pid]);');
    expect(effect).toContain('setSearchResults(res.items);');
    expect(effect).toContain('setSearchScan(res.scan);');
    const badge = src.indexOf('searchSkippedBadge(searchScan)');
    const counter = src.indexOf('hitLabel(searchIdx');
    expect(badge).toBeGreaterThan(-1);
    expect(counter).toBeGreaterThan(badge);
  });

  it('поиск по всем группам: строка стоит выше списка и вне его условия', () => {
    const src = GROUPS();
    const effect = slice(src, 'void searchAllGroupMessages(', '}, [grpSearch, pid]);');
    expect(effect).toContain('setGrpMsgSearchResults(res.items);');
    expect(effect).toContain('setGrpMsgSearchScan(res.scan);');
    const notice = src.indexOf('searchSkippedNotice(grpMsgSearchScan)');
    const list = src.indexOf('grpMsgSearchResults.map(');
    expect(notice).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(notice);
    // Условие пометки не должно упоминать длину выдачи: она нужна как раз при нуле.
    const block = slice(src, 'grpMsgSearchScan && searchSkippedNotice(grpMsgSearchScan) ? (', ') : null}');
    expect(block).not.toContain('grpMsgSearchResults.length');
  });

  it('поиск по переписке: пометка стоит до «0/0»', () => {
    const src = CHAT();
    const effect = slice(src, 'void searchChatMessages(', '}, [searchVisible, searchQuery, peerB64, activeProfileId]);');
    expect(effect).toContain('setSearchResults(res.items);');
    expect(effect).toContain('setSearchScan(res.scan);');
    const badge = src.indexOf('searchSkippedBadge(searchScan)');
    const counter = src.indexOf('hitLabel(searchHitIdx');
    expect(badge).toBeGreaterThan(-1);
    expect(counter).toBeGreaterThan(badge);
    // Короткая пометка без пояснения бесполезна для голосового доступа.
    expect(src).toContain('accessibilityLabel={searchSkippedNotice(searchScan) ?? undefined}');
  });

  it('глобальный поиск в списке чатов: строка выше выдачи и вне её условия', () => {
    const src = CHAT_LIST();
    const effect = slice(src, 'void searchMessages(', '}, [searchQuery, activeProfileId]);');
    expect(effect).toContain('setGlobalSearchResults(r.items);');
    expect(effect).toContain('setGlobalSearchScan(r.scan);');
    const notice = src.indexOf('searchSkippedNotice(globalSearchScan)');
    const list = src.indexOf('globalSearchResults.map(');
    expect(notice).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(notice);
    const block = slice(src, 'globalSearchScan && searchSkippedNotice(globalSearchScan) ? (', ') : null}');
    expect(block).not.toContain('globalSearchResults.length');
  });

  it('закрытие и очистка поиска сбрасывают счёт вместе с выдачей', () => {
    const groups = GROUPS();
    expect((groups.match(/setSearchScan\(null\);/g) ?? []).length).toBe(3);
    expect(groups).toContain('setGrpMsgSearchScan(null);');
    expect(CHAT()).toContain('setSearchScan(null);');
    expect(CHAT_LIST()).toContain('setGlobalSearchScan(null);');
  });
});
