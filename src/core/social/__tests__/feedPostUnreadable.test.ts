/**
 * Непрочитанная запись ленты: пустая карточка и репост пустоты (v4.32.587).
 *
 * Текст записи, список вложений и список документов читались двумя
 * состояниями. Столбец, не открывшийся ключом этого устройства, приходил
 * пустой строкой — запись рисовалась карточкой с именем автора и ничем
 * внутри, а репост, репост с комментарием и «поделиться» отдавали эту пустоту
 * наружу от имени её автора.
 */
import fs from 'fs';
import path from 'path';

import {
  feedPostIsUnreadable,
  mayRepublishFeedPost,
  mayReuseFeedText,
  UNREADABLE_POST_ACTION_TEXT,
} from '../feedPostGuard';

const STORAGE = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'feedStorage.ts'), 'utf8');
const SCREEN = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('решение о непрочитанной записи', () => {
  it('любая из трёх непрочитанных половин делает запись непрочитанной', () => {
    expect(feedPostIsUnreadable(null)).toBe(false);
    expect(feedPostIsUnreadable(undefined)).toBe(false);
    expect(feedPostIsUnreadable({})).toBe(false);
    expect(feedPostIsUnreadable({ textUnreadable: true })).toBe(true);
    expect(feedPostIsUnreadable({ mediaUnreadable: true })).toBe(true);
    expect(feedPostIsUnreadable({ documentsUnreadable: true })).toBe(true);
  });

  it('наружу такая запись не уходит', () => {
    expect(mayRepublishFeedPost({})).toBe(true);
    expect(mayRepublishFeedPost({ textUnreadable: true })).toBe(false);
    expect(mayRepublishFeedPost({ mediaUnreadable: true })).toBe(false);
    expect(mayRepublishFeedPost({ documentsUnreadable: true })).toBe(false);
  });

  it('запрет на текст строже не бывает: он про непрочитанный текст', () => {
    expect(mayReuseFeedText({ textUnreadable: true })).toBe(false);
    expect(mayReuseFeedText({ mediaUnreadable: true })).toBe(true);
    expect(mayReuseFeedText({})).toBe(true);
    expect(mayReuseFeedText(null)).toBe(true);
  });

  it('строка отказа говорит и о причине, и о последствии', () => {
    expect(UNREADABLE_POST_ACTION_TEXT).toContain('не удалось прочитать');
    expect(UNREADABLE_POST_ACTION_TEXT).toContain('нельзя переслать');
  });

  it('модуль остаётся чистым: ни React, ни хранилища, ни сети', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'feedPostGuard.ts'), 'utf8');
    expect(src.match(/^import .*$/gm)).toBeNull();
  });
});

describe('лента читается тремя состояниями', () => {
  it('текст, вложения и документы приходят с признаком', () => {
    const body = slice(STORAGE(), 'function toPost(', '\nexport class FeedStorage');
    expect(body).toContain('const textCell = readAtRestCell(r.text ?? \'\', dek);');
    expect(body).toContain('const mediaCell = readAtRestCell(r.media_cids, dek);');
    expect(body).toContain('const docsCell = readAtRestCell(r.documents, dek);');
    expect(body).toContain('textUnreadable: unreadableFromCellState(textCell.state),');
    expect(body).toContain('mediaUnreadable: unreadableFromCellState(mediaCell.state),');
    expect(body).toContain('documentsUnreadable: unreadableFromCellState(docsCell.state),');
    expect(body).not.toContain("text: decryptAtRestString(r.text ?? '', dek),");
    expect(body).not.toContain('parseStringArrayColumn(decryptAtRestNullable(r.media_cids, dek))');
  });
});

describe('экран ленты не выдаёт пустоту за содержимое', () => {
  it('вместо пустой карточки показывается пометка', () => {
    const src = SCREEN();
    expect(src).toContain('{feedPostIsUnreadable(item) ? (');
    expect(src).toContain('{UNREADABLE_POST_TEXT}');
  });

  it('репост, репост с комментарием и «поделиться» отказывают', () => {
    const src = SCREEN();
    const repost = slice(src, 'const handleRepost = useCallback(', 'const handleReactionLongPress');
    expect(repost).toContain('if (!mayRepublishFeedPost(post)) {');
    const long = slice(src, 'const handleRepostLongPress = useCallback(', 'const bookmarkLocksRef');
    expect(long).toContain('if (!mayRepublishFeedPost(item)) {');
    const share = slice(src, 'const handleNativeShare = useCallback(', 'const handlersRef');
    expect(share).toContain('if (!mayRepublishFeedPost(item)) {');
    expect(src.match(/showError\(UNREADABLE_POST_ACTION_TEXT\)/g)).toHaveLength(3);
  });

  it('копирование, перевод и правка закрыты у непрочитанного текста', () => {
    expect(SCREEN()).toContain("const hasText = mayReuseFeedText(p) && !!p.text && !p.text.startsWith('\\x04');");
  });
});
