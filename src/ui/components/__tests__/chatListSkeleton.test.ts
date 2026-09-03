/**
 * Пустой список чатов — это ещё не «нет переписок» (v4.32.561).
 *
 * Список читается из базы, и до первого ответа состояние пусто. FlatList на
 * пустом списке рисует ListEmptyComponent — то есть при КАЖДОМ открытии
 * приложения человеку на долю секунды сообщали, что переписок у него нет, и
 * советовали добавить собеседника по ID. У ленты заглушка была с самого начала
 * (FeedPostSkeleton), у списка чатов — нет.
 *
 * Заглушка обязана повторять размеры настоящей строки, иначе список дёргается,
 * когда данные доедут: аватар 48 и круглый, отступы 16/12 — те же, что в
 * ChatListScreen.
 */
import * as fs from 'fs';
import * as path from 'path';

const UI = path.join(__dirname, '..', '..');
const SKELETON = fs.readFileSync(path.join(UI, 'components', 'SkeletonLoader.tsx'), 'utf8');
const LIST = fs.readFileSync(path.join(UI, 'screens', 'ChatListScreen.tsx'), 'utf8');
const FEED = fs.readFileSync(path.join(UI, 'screens', 'FeedScreen.tsx'), 'utf8');

describe('заглушка строки списка', () => {
  it('аватар круглый и такой же, как настоящий', () => {
    const row = SKELETON.slice(SKELETON.indexOf('export function ChatRowSkeleton'));
    expect(row).toContain('<SkeletonBlock width={48} height={48} borderRadius={24} />');
  });

  it('отступы совпадают со строкой чата — иначе список дёрнется', () => {
    const row = SKELETON.slice(
      SKELETON.indexOf('export function ChatRowSkeleton'),
      SKELETON.indexOf('export function ChatListSkeleton')
    );
    expect(row).toContain('paddingHorizontal: 16');
    expect(row).toContain('paddingVertical: 12');
    expect(row).toContain('gap: 12');
    // Тот же отступ заложен в разделителе списка: 16 + 48 + 12 = 76.
    expect(LIST).toContain('marginLeft: 76');
  });

  it('строк несколько — одна не читается как список', () => {
    const many = SKELETON.slice(SKELETON.indexOf('export function ChatListSkeleton'));
    expect(many).toMatch(/count = \d/);
    expect(many).toContain('<ChatRowSkeleton key={i} />');
  });
});

describe('список чатов', () => {
  it('до первого ответа базы показывает заглушку, а не «Нет переписок»', () => {
    expect(LIST).toContain('firstLoad && !searchQuery ? (');
    expect(LIST).toContain('<ChatListSkeleton />');
    const empty = LIST.indexOf('ListEmptyComponent={');
    expect(LIST.indexOf('<ChatListSkeleton />', empty)).toBeGreaterThan(empty);
    expect(LIST.indexOf('<ChatListSkeleton />', empty)).toBeLessThan(LIST.indexOf('Нет переписок', empty));
  });

  it('поиск ничего не нашёл — это ответ, а не загрузка', () => {
    expect(LIST).toContain('Ничего не найдено');
  });

  it('сбой чтения не оставляет заглушку навсегда', () => {
    expect(LIST).toContain('void loadData().finally(() => setFirstLoad(false));');
  });
});

describe('лента', () => {
  it('свою заглушку с круглой аватаркой не потеряла', () => {
    expect(FEED).toContain('<FeedPostSkeleton key={i} />');
    const post = SKELETON.slice(
      SKELETON.indexOf('export function FeedPostSkeleton'),
      SKELETON.indexOf('export function ChatRowSkeleton')
    );
    expect(post).toContain('<SkeletonBlock width={40} height={40} borderRadius={20} />');
  });
});
