import fs from 'fs';
import path from 'path';

import {
  FEED_AUTHOR_NAME_MAX_CHARS,
  FEED_COMMENT_MAX_CHARS,
  FEED_POST_MAX_CHARS,
  clampFeedAuthorName,
  clampFeedCommentText,
  clampFeedPostText,
  isEditableFeedText,
} from '../feedTextLimit';

const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

describe('потолки текста ленты', () => {
  it('пост и форма публикации сходятся на одном числе', () => {
    // Публиковать разрешалось 10 000, а принималось 8 000 — законный длинный
    // пост терял хвост у каждого получателя, и автор об этом не узнавал.
    expect(FEED_POST_MAX_CHARS).toBe(10_000);
    expect(clampFeedPostText('a'.repeat(10_000))).toHaveLength(10_000);
    expect(clampFeedPostText('a'.repeat(12_345))).toHaveLength(10_000);
  });

  it('комментарий принимается ровно настолько, насколько его можно написать', () => {
    // Принималось 8 000 при разрешённых 2 000 — вчетверо больше того, что
    // вообще может отправить честный клиент.
    expect(FEED_COMMENT_MAX_CHARS).toBe(2_000);
    expect(clampFeedCommentText('a'.repeat(9_000))).toHaveLength(2_000);
  });

  it('имя автора — подпись, а не текст', () => {
    expect(FEED_AUTHOR_NAME_MAX_CHARS).toBe(128);
    expect(clampFeedAuthorName('и'.repeat(500))).toHaveLength(128);
  });

  it('текст короче потолка не трогается', () => {
    expect(clampFeedPostText('привет')).toBe('привет');
    expect(clampFeedCommentText('да')).toBe('да');
    expect(clampFeedAuthorName('Аня')).toBe('Аня');
    expect(clampFeedPostText('')).toBe('');
  });

  it('не строка — null, а не подстановка и не исключение', () => {
    for (const v of [undefined, null, 42, {}, [], true]) {
      expect(clampFeedPostText(v)).toBeNull();
      expect(clampFeedCommentText(v)).toBeNull();
      expect(clampFeedAuthorName(v)).toBeNull();
    }
  });
});

describe('isEditableFeedText', () => {
  it('обычная правка проходит', () => {
    expect(isEditableFeedText('новый текст')).toBe(true);
    expect(isEditableFeedText('a'.repeat(FEED_POST_MAX_CHARS))).toBe(true);
  });

  it('правка длиннее поста отклоняется целиком, а не обрезается', () => {
    // Обрезать здесь нельзя: у каждой правки свой ts, то есть свой ключ
    // дедупликации, и раздувать строку можно было бы повторно.
    expect(isEditableFeedText('a'.repeat(FEED_POST_MAX_CHARS + 1))).toBe(false);
  });

  it('пустая правка — не правка', () => {
    // Пустой пост опубликовать нельзя, значит и опустошать его правкой нельзя:
    // иначе стирание чужого текста выглядело бы как обычное редактирование.
    expect(isEditableFeedText('')).toBe(false);
  });

  it('не строка не доходит до записи', () => {
    // Раньше такое значение доезжало до шифрования, там бросало, и внешний
    // catch это глотал — правка молча не применялась.
    for (const v of [undefined, null, 0, {}, ['a'], true]) {
      expect(isEditableFeedText(v)).toBe(false);
    }
  });
});

describe('исходники: приём конверта пользуется общими потолками', () => {
  it('feedService берёт числа из модуля, а не выписывает свои', () => {
    expect(SERVICE).toContain("from './feedTextLimit'");
    expect(SERVICE).not.toMatch(/const FEED_POST_MAX_CHARS =/);
    expect(SERVICE).not.toMatch(/const FEED_COMMENT_MAX_CHARS =/);
  });

  it('прежнего числа 8000 в разборе конверта не осталось', () => {
    expect(SERVICE).not.toContain('slice(0, 8000)');
    expect(SERVICE).not.toContain('> 8000');
  });

  it('правка поста проверяется до записи в базу', () => {
    const guard = SERVICE.indexOf('if (!isEditableFeedText(d.newText))');
    const write = SERVICE.indexOf('await s.updatePostText(payload.postId, d.newText, payload.ts)');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });

  it('профиль конверта фиксируется вместе с хранилищем', () => {
    // `currentProfileId ?? 1` читался после нескольких await: голос, пришедший
    // в момент переключения профиля, записывался в чужой аккаунт.
    expect(SERVICE).toContain('const envelopePid = currentProfileId;');
    expect(SERVICE).toContain('const pid = envelopePid;');
    expect(SERVICE).not.toContain('currentProfileId ?? 1');
  });

  it('имя автора обрезается одинаково на обоих концах', () => {
    expect(SERVICE).toContain("clampFeedAuthorName(myName) ?? 'Аноним'");
    // (slice(0, 120) в файле остался — но это имя файла документа, не имя автора.)
    expect(SERVICE).not.toContain('myName.slice(');
  });

  it('модуль потолков не тянет за собой ничего', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'feedTextLimit.ts'), 'utf8');
    expect(src).not.toMatch(/^import /m);
  });
});
