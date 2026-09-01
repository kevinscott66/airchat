/**
 * Уборка осиротевших вложений ленты (v4.32.333).
 *
 * Эта функция решает, какие посты УДАЛИТЬ. Ошибка здесь стирает опубликованное
 * человеком без спроса и без возможности вернуть, поэтому проверяется не только
 * «нашли пропажу», но и «не тронули лишнего».
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  INLINE_DOC_PREFIX,
  INLINE_MEDIA_PREFIX,
  inlineDocKey,
  inlineMediaKey,
  postIdFromInlineKey,
  scanInlineOrphans,
  type InlinePostRef,
} from '../feedOrphanScan';

const P1 = 'post-aaa';
const P2 = 'post-bbb';

/** Пост с N inline-фотографиями и M документами. */
function post(postId: string, media: number, docs: number): InlinePostRef {
  return {
    postId,
    mediaCids: Array.from({ length: media }, (_, i) => `inline:${postId}:${i}`),
    documentsCount: docs,
  };
}

/** Все ключи, которые должны существовать у такого поста. */
function keysFor(p: InlinePostRef): string[] {
  return [
    ...p.mediaCids.map((_, i) => inlineMediaKey(p.postId, i)),
    ...Array.from({ length: p.documentsCount }, (_, i) => inlineDocKey(p.postId, i)),
  ];
}

describe('postIdFromInlineKey', () => {
  it('достаёт postId из ключа фотографии и документа', () => {
    expect(postIdFromInlineKey(`${INLINE_MEDIA_PREFIX}${P1}:3`)).toBe(P1);
    expect(postIdFromInlineKey(`${INLINE_DOC_PREFIX}${P1}:0`)).toBe(P1);
  });

  it('чужой ключ не разбирается — его не за что удалять', () => {
    expect(postIdFromInlineKey('mute:did:key:z6Mk')).toBeNull();
    expect(postIdFromInlineKey(`${INLINE_MEDIA_PREFIX}`)).toBeNull();
    expect(postIdFromInlineKey(`${INLINE_MEDIA_PREFIX}:0`)).toBeNull();
    expect(postIdFromInlineKey(`${INLINE_MEDIA_PREFIX}${P1}`)).toBeNull();
  });
});

describe('целые посты не трогаются', () => {
  it('все вложения на месте — удалять нечего', () => {
    const p = post(P1, 2, 1);
    const r = scanInlineOrphans({ knownPostIdsEverywhere: [P1], posts: [p], inlineKeys: keysFor(p) });
    expect(r.purgePosts).toEqual([]);
    expect(r.orphanKeys).toEqual([]);
  });

  it('пост без вложений не считается битым при пустой базе ключей', () => {
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [{ postId: P1, mediaCids: [], documentsCount: 0 }],
      inlineKeys: [],
    });
    expect(r.purgePosts).toEqual([]);
  });

  it('старые IPFS-CID не ищутся в kv — байтов там и не было', () => {
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [{ postId: P1, mediaCids: ['bafybeigdyrzt', 'bafkreih'], documentsCount: 0 }],
      inlineKeys: [],
    });
    expect(r.purgePosts).toEqual([]);
  });

  it('нечитаемый mediaCids (не строки) не приводит к удалению поста', () => {
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [{ postId: P1, mediaCids: [null, undefined, 42], documentsCount: 0 }],
      inlineKeys: [],
    });
    expect(r.purgePosts).toEqual([]);
  });
});

describe('битые посты находятся', () => {
  it('пропавшая фотография уносит пост целиком', () => {
    const p = post(P1, 2, 0);
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [p],
      inlineKeys: [inlineMediaKey(P1, 0)],
    });
    expect(r.purgePosts).toEqual([{ postId: P1, missing: 1, mediaN: 2, docsN: 0 }]);
  });

  it('документы проверяются наравне с фотографиями', () => {
    const p = post(P1, 1, 2);
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [p],
      inlineKeys: [inlineMediaKey(P1, 0), inlineDocKey(P1, 0)],
    });
    expect(r.purgePosts[0]).toMatchObject({ missing: 1, mediaN: 1, docsN: 2 });
  });

  it('нумерация слотов идёт по позиции в mediaCids, а не по счётчику inline', () => {
    // Второй слот — старый IPFS-CID, у inline-фотографии индекс 2, а не 1.
    const p: InlinePostRef = {
      postId: P1,
      mediaCids: [`inline:${P1}:0`, 'bafybeigdyrzt', `inline:${P1}:2`],
      documentsCount: 0,
    };
    const ok = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [p],
      inlineKeys: [inlineMediaKey(P1, 0), inlineMediaKey(P1, 2)],
    });
    expect(ok.purgePosts).toEqual([]);

    const bad = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [p],
      inlineKeys: [inlineMediaKey(P1, 0), inlineMediaKey(P1, 1)],
    });
    expect(bad.purgePosts[0].missing).toBe(1);
  });

  it('битый пост не тянет за собой соседний целый', () => {
    const good = post(P1, 1, 0);
    const bad = post(P2, 1, 0);
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1, P2],
      posts: [good, bad],
      inlineKeys: keysFor(good),
    });
    expect(r.purgePosts.map((p) => p.postId)).toEqual([P2]);
  });
});

describe('осиротевшие байты', () => {
  it('ключи удалённого поста уходят в orphanKeys', () => {
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [post(P1, 0, 0)],
      inlineKeys: [inlineMediaKey(P2, 0), inlineDocKey(P2, 0)],
    });
    expect(r.orphanKeys.sort()).toEqual([inlineMediaKey(P2, 0), inlineDocKey(P2, 0)].sort());
  });

  it('пост, который не удалось расшифровать, свои байты не теряет', () => {
    // общий список знает о посте, posts — нет (getPost вернул null).
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [],
      inlineKeys: [inlineMediaKey(P1, 0)],
    });
    expect(r.orphanKeys).toEqual([]);
    expect(r.purgePosts).toEqual([]);
  });

  it('байты битого поста не дублируются в orphanKeys — их снимет удаление по префиксу', () => {
    const p = post(P1, 2, 0);
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [P1],
      posts: [p],
      inlineKeys: [inlineMediaKey(P1, 0)],
    });
    expect(r.purgePosts).toHaveLength(1);
    expect(r.orphanKeys).toEqual([]);
  });

  it('посторонние kv-ключи не попадают под удаление', () => {
    const r = scanInlineOrphans({
      knownPostIdsEverywhere: [],
      posts: [],
      inlineKeys: ['mute:did:key:z6Mk', 'recently_deleted_abc'],
    });
    expect(r.orphanKeys).toEqual([]);
  });
});

/**
 * v4.32.433. Ключи вложений лежат в общей таблице kv без префикса профиля, а
 * посты — в отдельной базе на профиль (airchat_feed_p<id>.db). Уборка
 * запускается на каждую привязку личности и раньше получала список постов
 * ТОЛЬКО активного профиля: вложения всех остальных профилей выглядели как
 * байты удалённых постов и стирались безвозвратно. Дальше их собственная
 * уборка видела посты без байтов и удаляла сами посты. Два профиля — и оба
 * теряли ленту при первом же переключении.
 */
describe('вложения соседнего профиля', () => {
  it('не считаются сиротами, когда общий список о них знает', () => {
    const mine = post(P1, 1, 0);
    const theirs = post(P2, 1, 0);
    const r = scanInlineOrphans({
      posts: [mine],
      inlineKeys: [...keysFor(mine), ...keysFor(theirs)],
      knownPostIdsEverywhere: [P1, P2],
    });
    expect(r.orphanKeys).toEqual([]);
    expect(r.purgePosts).toEqual([]);
  });

  it('стали бы сиротами по списку одного профиля — так и терялись', () => {
    const mine = post(P1, 1, 0);
    const theirs = post(P2, 1, 0);
    const r = scanInlineOrphans({
      posts: [mine],
      inlineKeys: [...keysFor(mine), ...keysFor(theirs)],
      knownPostIdsEverywhere: [P1],
    });
    expect(r.orphanKeys).toEqual(keysFor(theirs));
  });

  it('без общего списка сироты не ищутся вовсе', () => {
    const mine = post(P1, 1, 0);
    const r = scanInlineOrphans({
      posts: [mine],
      inlineKeys: [inlineMediaKey(P2, 0)],
      knownPostIdsEverywhere: null,
    });
    expect(r.orphanKeys).toEqual([]);
  });

  it('без общего списка пропажа своих байтов всё равно видна', () => {
    const mine = post(P1, 2, 0);
    const r = scanInlineOrphans({
      posts: [mine],
      inlineKeys: [inlineMediaKey(P1, 0)],
      knownPostIdsEverywhere: null,
    });
    expect(r.purgePosts.map((x) => x.postId)).toEqual([P1]);
  });
});

describe('вызывающий даёт общий список, а не свой', () => {
  const feedService = fs.readFileSync(
    path.join(__dirname, '..', 'feedService.ts'),
    'utf8'
  );

  it('уборка спрашивает посты всех профилей', () => {
    expect(feedService).toContain('const knownPostIdsEverywhere = await listPostIdsEverywhere();');
    expect(feedService).toContain('profileManager.getProfileIds()');
  });

  it('прежняя форма вызова не вернулась', () => {
    expect(feedService).not.toContain('allPostIds: postIds');
    expect(feedService).not.toContain('allPostIds:');
  });

  it('удаление вложений профиля идёт по общим префиксам, а не по литералам', () => {
    expect(feedService).not.toContain("kvDeleteByPrefix(`feed_inline_media:");
    expect(feedService).not.toContain("kvDeleteByPrefix(`feed_inline_doc:");
    expect(feedService).toContain('kvDeleteByPrefix(`${INLINE_MEDIA_PREFIX}');
  });
});
