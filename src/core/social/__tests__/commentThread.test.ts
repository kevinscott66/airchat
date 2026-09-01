/**
 * Под постом видны его комментарии, а не соседнего (v4.32.504).
 *
 * Открытие треда — асинхронное чтение из базы. Пока оно идёт, человек успевает
 * закрыть тред и открыть другой пост: строки в ленте плотные, промах пальцем
 * стоит одного касания. Ответ первого чтения приходил позже и ложился в
 * состояние без вопросов — под постом B показывались комментарии поста A. Тем
 * же путём шли ответ на реакцию к комментарию (он возвращает весь тред) и свой
 * только что отправленный комментарий.
 *
 * Заодно закрыта проверка «перерисовывать нечего»: она сравнивала длину и id
 * последней строки, поэтому удаление одного комментария вместе с приходом
 * другого не обновляло список, а чужая реакция не двигала счётчик под
 * сердечком, пока тред не закроют.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  acceptCommentList,
  appendOwnComment,
  commentListGrew,
  commentListUnchanged,
  type CommentRowKey,
} from '../commentThread';

const c = (id: string, postId = 'A', extra: Partial<CommentRowKey> = {}): CommentRowKey => ({
  id,
  postId,
  text: `текст ${id}`,
  ...extra,
});

describe('чей тред открыт', () => {
  it('ответ опоздал — на экране остаётся прежний список, тем же объектом', () => {
    const prev = [c('a1')];
    expect(acceptCommentList('B', 'A', [c('a2')], prev)).toBe(prev);
  });

  it('тред уже закрыт — ответ не оживляет список', () => {
    const prev = [c('a1')];
    expect(acceptCommentList(null, 'A', [c('a2')], prev)).toBe(prev);
  });

  it('ответ про открытый пост — принимаем', () => {
    const list = [c('a1'), c('a2')];
    expect(acceptCommentList('A', 'A', list, [])).toEqual(list);
  });

  it('чужая строка внутри ответа отбрасывается', () => {
    const mixed = [c('a1'), c('b1', 'B'), c('a2')];
    expect(acceptCommentList('A', 'A', mixed, []).map((x) => x.id)).toEqual(['a1', 'a2']);
  });

  it('тред опустел — пустой список, а не прежний', () => {
    expect(acceptCommentList('A', 'A', [], [c('a1')])).toEqual([]);
  });

  it('прежний список не мутируется', () => {
    const prev = [c('a1')];
    acceptCommentList('A', 'A', [c('a2')], prev);
    expect(prev.map((x) => x.id)).toEqual(['a1']);
  });

  it('до фикса ответ ложился как есть — под постом B комментарии поста A', () => {
    const threadOfA = [c('a1'), c('a2')];
    const before = threadOfA; // прежнее поведение: setComments(list)
    expect(before.every((x) => x.postId === 'A')).toBe(true);
    expect(acceptCommentList('B', 'A', threadOfA, [])).toEqual([]);
  });
});

describe('свой отправленный комментарий', () => {
  it('дописывается в открытый тред', () => {
    expect(appendOwnComment('A', c('a2'), [c('a1')]).map((x) => x.id)).toEqual(['a1', 'a2']);
  });

  it('не попадает в чужой тред, если человек успел переключиться', () => {
    const prev = [c('b1', 'B')];
    expect(appendOwnComment('B', c('a2'), prev)).toBe(prev);
  });

  it('в закрытый тред не дописывается', () => {
    const prev = [c('a1')];
    expect(appendOwnComment(null, c('a2'), prev)).toBe(prev);
  });

  it('перезагрузка успела раньше — дубля не будет', () => {
    const prev = [c('a1'), c('a2')];
    expect(appendOwnComment('A', c('a2'), prev)).toBe(prev);
  });
});

describe('перерисовывать ли список', () => {
  it('тот же список — нечего', () => {
    const list = [c('a1')];
    expect(commentListUnchanged(list, list)).toBe(true);
    expect(commentListUnchanged([c('a1')], [c('a1')])).toBe(true);
  });

  it('пришёл новый комментарий', () => {
    expect(commentListUnchanged([c('a1')], [c('a1'), c('a2')])).toBe(false);
    expect(commentListGrew([c('a1')], [c('a1'), c('a2')])).toBe(true);
    expect(commentListGrew([c('a1'), c('a2')], [c('a1')])).toBe(false);
  });

  it('один удалён, другой пришёл — длина и хвост те же, но список другой', () => {
    // Ровно то, что прежняя проверка (длина + последний id) пропускала.
    const prev = [c('a1'), c('a2'), c('a9')];
    const next = [c('a1'), c('a3'), c('a9')];
    expect(prev.length === next.length && prev[prev.length - 1].id === next[next.length - 1].id).toBe(true);
    expect(commentListUnchanged(prev, next)).toBe(false);
  });

  it('чужая реакция на комментарий обновляет список', () => {
    const prev = [c('a1', 'A', { reactions: { '❤️': ['did:key:z1'] } })];
    const next = [c('a1', 'A', { reactions: { '❤️': ['did:key:z1', 'did:key:z2'] } })];
    expect(commentListUnchanged(prev, next)).toBe(false);
  });

  it('те же реакции в другом порядке — не повод перерисовывать', () => {
    const prev = [c('a1', 'A', { reactions: { '❤️': ['did:key:z2', 'did:key:z1'], '👍': [] } })];
    const next = [c('a1', 'A', { reactions: { '👍': [], '❤️': ['did:key:z1', 'did:key:z2'] } })];
    expect(commentListUnchanged(prev, next)).toBe(true);
  });

  it('снятая реакция замечается', () => {
    const prev = [c('a1', 'A', { reactions: { '❤️': ['did:key:z1'] } })];
    const next = [c('a1', 'A', { reactions: null })];
    expect(commentListUnchanged(prev, next)).toBe(false);
  });

  it('изменённый текст замечается', () => {
    expect(commentListUnchanged([c('a1')], [{ ...c('a1'), text: 'другое' }])).toBe(false);
  });

  it('пустые списки равны', () => {
    expect(commentListUnchanged([], [])).toBe(true);
  });
});

describe('форма кода', () => {
  const SRC = path.join(__dirname, '..', '..', '..');
  const FEED = fs.readFileSync(path.join(SRC, 'ui', 'screens', 'FeedScreen.tsx'), 'utf8');
  const MOD = fs.readFileSync(path.join(SRC, 'core', 'social', 'commentThread.ts'), 'utf8');

  it('каждый асинхронный ответ проверяет, чей тред открыт', () => {
    // Было 5. В v4.32.538 одно место ушло совсем: сбой чтения треда подменял
    // список пустым — «комментариев нет» вместо «прочитать не удалось». Теперь
    // при сбое список не трогают вовсе, проверять там нечего.
    expect(FEED.match(/acceptCommentList\(commentPostIdRef\.current, /g)).toHaveLength(4);
    expect(FEED).not.toContain('acceptCommentList(commentPostIdRef.current, postId, [], prev)');
    expect(FEED).toContain('appendOwnComment(commentPostIdRef.current, row, prev)');
    // Прямая передача setComments в .then — это и был обход проверки.
    expect(FEED).not.toContain('.then(setComments)');
  });

  it('прежняя проверка «длина и последний id» убрана', () => {
    expect(FEED).not.toContain('prev[prev.length - 1]?.id === list[list.length - 1]?.id');
    expect(FEED).toContain('commentListUnchanged(prev, next)');
    expect(FEED).toContain('commentListGrew(prev, next)');
  });

  it('список «Кто просмотрел» подписан своим постом', () => {
    expect(FEED).toContain('viewersPostIdRef.current = postId;');
    expect(FEED).toContain('if (viewersPostIdRef.current !== postId) return;');
    expect(FEED).toContain('viewersPostIdRef.current = null;');
  });

  it('правило живёт в одном экземпляре и без зависимостей', () => {
    expect(MOD).not.toMatch(/^import /m);
    expect(MOD).not.toContain('require(');
  });
});
