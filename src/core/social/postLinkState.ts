/**
 * Какие свои записи опубликованы по ссылке (AC-04).
 *
 * Отметка ставится ТОЛЬКО после того, как сервер принял копию, и снимается,
 * когда копия отозвана или запись удалена. По ней экран показывает у поста
 * «опубликовано по ссылке», даёт «Отозвать ссылку» и решает, нужен ли перед
 * копированием ссылки диалог подтверждения: уже опубликованную запись
 * копирование ссылки заново никуда не выкладывает.
 *
 * Отметка — память устройства, а не слово сервера: сбой её записи не отменяет
 * публикацию и не выдаётся за неё.
 */
import { log } from '../logger';
import {
  scopedKvDeleteChecked,
  scopedKvListKeysByPrefix,
  scopedKvSetChecked,
} from '../storage/profileScopedKv';
import { FEED_LINK_PUBLISHED_PREFIX, feedLinkPublishedKey } from '../storage/kvKeys';

/** Id своих записей активного профиля, опубликованных по ссылке. */
export async function listLinkPublishedPostIds(): Promise<Set<string>> {
  try {
    const ids = new Set<string>();
    for (const key of await scopedKvListKeysByPrefix(FEED_LINK_PUBLISHED_PREFIX)) {
      const postId = key.slice(FEED_LINK_PUBLISHED_PREFIX.length);
      if (postId) ids.add(postId);
    }
    return ids;
  } catch (e) {
    log.warn('feed_link_published_list_failed', { err: e instanceof Error ? e.message : String(e) });
    return new Set();
  }
}

/** Поставить или снять отметку. `false` — база не ответила, отметка прежняя. */
export async function setLinkPublished(postId: string, published: boolean): Promise<boolean> {
  try {
    if (published) {
      return await scopedKvSetChecked(feedLinkPublishedKey(postId), String(Date.now()));
    }
    await scopedKvDeleteChecked(feedLinkPublishedKey(postId));
    return true;
  } catch (e) {
    log.warn('feed_link_published_write_failed', {
      postId: postId.slice(0, 24),
      published,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
