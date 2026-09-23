/**
 * Разбор осиротевших вложений ленты — чистая часть reconcileOrphanInlineMedia.
 *
 * Байты фотографий и документов поста лежат не в строке поста, а отдельными
 * kv-записями `feed_inline_media:<postId>:<i>` и `feed_inline_doc:<postId>:<i>`.
 * Две половинки могут разъехаться: процесс убили между сохранением поста и
 * записью байтов (тогда пост ссылается в пустоту), или наоборот — пост удалён,
 * а байты остались.
 *
 * Решение «что удалить» вынесено сюда отдельно от работы с базой: это решение
 * стирает посты человека, и проверять его надо тестами, а не на живой базе.
 */

export const INLINE_MEDIA_PREFIX = 'feed_inline_media:';
export const INLINE_DOC_PREFIX = 'feed_inline_doc:';

export const inlineMediaKey = (postId: string, index: number): string =>
  `${INLINE_MEDIA_PREFIX}${postId}:${index}`;

export const inlineDocKey = (postId: string, index: number): string =>
  `${INLINE_DOC_PREFIX}${postId}:${index}`;

/** Пост в том виде, в каком его знает разбор: только ссылки на вложения. */
export type InlinePostRef = {
  postId: string;
  mediaCids: readonly unknown[];
  documentsCount: number;
  /**
   * Наш ли это пост (v4.32.735).
   *
   * Удаление оправдано ровно одним случаем — своя публикация, оборванная между
   * записью строки и записью байтов: разослать её не успели, значит и терять
   * нечего. У принятой от контакта публикации всё наоборот: она уже единственная
   * копия. Перезапросить её нечем — отправитель считает доставку состоявшейся, —
   * и снести её из-за одной не легшей фотографии значит стереть заодно текст и
   * остальные снимки, безвозвратно.
   *
   * Неизвестно, чей пост, — считается чужим: цена ошибки здесь односторонняя.
   */
  own: boolean;
};

export type PostToPurge = {
  postId: string;
  /** Сколько слотов вложений не нашлось — попадает в лог. */
  missing: number;
  mediaN: number;
  docsN: number;
};

export type OrphanScanResult = {
  /** Посты, у которых пропала хотя бы часть вложений. */
  purgePosts: PostToPurge[];
  /**
   * Чужие посты с той же пропажей (v4.32.735). Не удаляются — только попадают
   * в журнал: место фотографии останется пустым (resolveFeedMediaUri отдаёт на
   * такую ссылку пустую строку), а текст и остальные снимки целы.
   */
  keepForeign: PostToPurge[];
  /** kv-ключи, чьего поста больше нет. */
  orphanKeys: string[];
};

/**
 * Достаёт postId из ключа вложения. Возвращает null, если ключ не той формы:
 * лишний ключ в базе не повод считать его чужим и удалить.
 *
 * postId — base64url хеша, двоеточий в нём нет, поэтому первое двоеточие после
 * префикса и есть граница.
 */
export function postIdFromInlineKey(key: string): string | null {
  const prefix = key.startsWith(INLINE_MEDIA_PREFIX)
    ? INLINE_MEDIA_PREFIX
    : key.startsWith(INLINE_DOC_PREFIX)
      ? INLINE_DOC_PREFIX
      : null;
  if (!prefix) return null;
  const rest = key.slice(prefix.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  return rest.slice(0, colon);
}

/**
 * @param posts       Посты активного профиля, которые удалось прочитать, со
 *                    ссылками на вложения. По ним ищется пропажа байтов.
 * @param inlineKeys  ВСЕ существующие ключи обоих префиксов. Именно все: чего
 *                    в списке нет, то считается пропавшим, и пост из-за этого
 *                    удаляется. Неполный список = потерянные посты.
 * @param knownPostIdsEverywhere
 *                    Посты ВСЕХ профилей, включая нечитаемые. Именно всех:
 *                    ключи вложений лежат в общей таблице kv без префикса
 *                    профиля, а посты — в отдельной базе на профиль
 *                    (airchat_feed_p<id>.db). Список одного профиля здесь
 *                    означает, что вложения всех остальных профилей выглядят
 *                    как байты удалённых постов и стираются безвозвратно.
 *                    null — список собрать не удалось; тогда сироты не ищутся
 *                    вовсе, потому что отличить чужое от брошенного нечем.
 */
export function scanInlineOrphans(input: {
  posts: readonly InlinePostRef[];
  inlineKeys: readonly string[];
  knownPostIdsEverywhere: readonly string[] | null;
}): OrphanScanResult {
  const present = new Set(input.inlineKeys);

  const purgePosts: PostToPurge[] = [];
  const keepForeign: PostToPurge[] = [];
  for (const post of input.posts) {
    const mediaCids = post.mediaCids ?? [];
    const inlineSlots: string[] = [];
    for (let i = 0; i < mediaCids.length; i++) {
      const cid = mediaCids[i];
      // Не-inline CID — это ссылка на IPFS из старых версий, байтов в kv у неё нет.
      if (typeof cid === 'string' && cid.startsWith('inline:')) {
        inlineSlots.push(inlineMediaKey(post.postId, i));
      }
    }
    const docsN = Math.max(0, post.documentsCount);
    for (let i = 0; i < docsN; i++) inlineSlots.push(inlineDocKey(post.postId, i));

    if (inlineSlots.length === 0) continue;
    const missing = inlineSlots.reduce((n, key) => (present.has(key) ? n : n + 1), 0);
    if (missing > 0) {
      const found = { postId: post.postId, missing, mediaN: mediaCids.length, docsN };
      (post.own ? purgePosts : keepForeign).push(found);
    }
  }

  // Ключи удалённых постов. Посты из purgePosts сюда не попадают: их вложения
  // сносятся удалением по префиксу, а не по одному ключу.
  const orphanKeys: string[] = [];
  if (input.knownPostIdsEverywhere === null) return { purgePosts, keepForeign, orphanKeys };
  const knownPosts = new Set(input.knownPostIdsEverywhere);
  for (const key of input.inlineKeys) {
    const pid = postIdFromInlineKey(key);
    if (!pid) continue;
    if (!knownPosts.has(pid)) orphanKeys.push(key);
  }

  return { purgePosts, keepForeign, orphanKeys };
}
