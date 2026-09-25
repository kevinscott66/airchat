/**
 * Ссылки на свои публикации: экранная обвязка потока postLinkFlow (AC-04, AC-17).
 *
 * Сама логика — что и в каком порядке делать — живёт в
 * core/social/postLinkFlow и проверяется там. Здесь только то, что требует
 * экрана: диалоги подтверждения, буфер обмена, системный лист «поделиться»,
 * тосты и состояние для отрисовки («опубликовано по ссылке», «публикуем…»).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { publishPostLinkCopy, revokePostLinkCopy } from '../../core/social/feedService';
import { publicPostCopyExists, publicPostStoreAvailable } from '../../core/social/publicPost';
import { listLinkPublishedPostIds, setLinkPublished } from '../../core/social/postLinkState';
import {
  createPostLinkFlow,
  mayPublishByLink,
  type PostLinkHandoffOutcome,
  type PostLinkTarget,
} from '../../core/social/postLinkFlow';
import { buildPostLink } from '../../core/net/appLink';
import { COPIED_LINK } from '../clipboardText';
import { showError, showSuccess } from '../components/userFeedback';

/** Что нужно знать о записи, чтобы работать с её ссылкой. */
export interface LinkablePost {
  id: string;
  authorDid: string;
}

export interface PostLinkSharing {
  /** Опубликована ли запись по ссылке (показывается у поста). */
  isPublished: (postId: string) => boolean;
  /** Идёт ли сейчас публикация или отзыв — кнопки гаснут, горит индикатор. */
  isBusy: (postId: string) => boolean;
  /** Можно ли эту запись опубликовать по ссылке вообще (своя, облако есть). */
  mayPublish: (post: LinkablePost) => boolean;
  /**
   * Уточнить у сервера, опубликована ли своя запись, у которой отметки нет
   * (v4.32.917; прежде — только когда не прочитался весь список, v4.32.902).
   * Зовётся перед показом меню записи, чтобы «Отозвать ссылку» не пропало.
   */
  resolvePublished: (post: LinkablePost) => Promise<void>;
  copyLink: (post: LinkablePost) => Promise<PostLinkHandoffOutcome>;
  shareLink: (post: LinkablePost, message: string) => Promise<PostLinkHandoffOutcome>;
  publish: (post: LinkablePost) => Promise<void>;
  revoke: (post: LinkablePost) => Promise<void>;
}

/** Диалог «да/нет» как обещание. Закрытие мимо кнопок — это «нет». */
function askConfirm(title: string, message: string, cancel: string, ok: string, destructive: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    Alert.alert(
      title,
      message,
      [
        { text: cancel, style: 'cancel', onPress: () => done(false) },
        { text: ok, style: destructive ? 'destructive' : 'default', onPress: () => done(true) },
      ],
      { cancelable: true, onDismiss: () => done(false) },
    );
  });
}

export function usePostLinkSharing(pair: KeyPairBytes, did: string): PostLinkSharing {
  const { t } = useTranslation();
  const [publishedIds, setPublishedIds] = useState<ReadonlySet<string>>(() => new Set());
  // Тот же набор, но без ожидания перерисовки: нажатие сразу после публикации
  // не должно снова спрашивать «опубликовать?» по устаревшему состоянию.
  const publishedRef = useRef<Set<string>>(new Set());
  // v4.32.917: отдельного признака «список не прочитался» больше нет.
  // Прочитанный пустой список и нечитаемый говорят одно и то же — «отметки у
  // нас нет», — а «Отозвать ссылку» пропадает одинаково в обоих случаях.
  // Разбирается это ниже, в resolvePublished, одним путём на оба.
  //
  // У кого уже спрашивали сервер — второй раз за ту же сессию не ходим.
  const askedRef = useRef<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const pairRef = useRef(pair);
  pairRef.current = pair;
  const tRef = useRef(t);
  tRef.current = t;

  // Отметки у каждого профиля свои — перечитываются при смене личности.
  useEffect(() => {
    let alive = true;
    publishedRef.current = new Set();
    askedRef.current = new Set();
    setPublishedIds(new Set());
    void listLinkPublishedPostIds().then((ids) => {
      if (!alive) return;
      publishedRef.current = new Set(ids ?? []);
      setPublishedIds(new Set(ids ?? []));
    });
    return () => { alive = false; };
  }, [did]);

  const flow = useMemo(() => createPostLinkFlow({
    canPublish: publicPostStoreAvailable,
    confirmPublish: () => askConfirm(
      tRef.current('feed.linkPublishConfirmTitle'),
      tRef.current('feed.linkPublishConfirmMsg'),
      tRef.current('common.cancel'),
      tRef.current('feed.linkPublishConfirmOk'),
      false,
    ),
    confirmRevoke: () => askConfirm(
      tRef.current('feed.linkRevokeConfirmTitle'),
      tRef.current('feed.linkRevokeConfirmMsg'),
      tRef.current('common.cancel'),
      tRef.current('feed.linkRevokeConfirmOk'),
      true,
    ),
    publish: (postId) => publishPostLinkCopy(pairRef.current, postId),
    revoke: (postId) => revokePostLinkCopy(pairRef.current, postId),
    copy: async (text) => { await Clipboard.setStringAsync(text); },
    share: async (message) => { await Share.share({ message }); },
    onBusyChange: (postId, busy) => setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(postId); else next.delete(postId);
      return next;
    }),
    onPublishedChange: (postId, published) => {
      if (published) publishedRef.current.add(postId); else publishedRef.current.delete(postId);
      setPublishedIds(new Set(publishedRef.current));
    },
  }), []);

  const target = useCallback((post: LinkablePost): PostLinkTarget => ({
    postId: post.id,
    own: post.authorDid === did,
    published: publishedRef.current.has(post.id),
  }), [did]);

  /**
   * Дочитать у сервера состояние своей записи, за которой отметки не числится.
   *
   * v4.32.902 спрашивал сервер только тогда, когда не прочитался ВЕСЬ список
   * отметок. Но отметка пропадает и поодиночке, а последствие то же самое:
   * «Отозвать ссылку» рисуется ровно по ней, и без неё незашифрованную копию
   * нечем снять. Поодиночке отметка теряется не в теории:
   *   • `refreshPublicPostCopy` ставит её задним числом, когда копия на
   *     сервере есть, а отметки нет (старая сборка ссылок ещё не отмечала), и
   *     отказ этой записи до v4.32.917 выбрасывался;
   *   • `publishPostLinkCopy` при незаписавшейся отметке снимает копию, но
   *     снять её удаётся не всегда — тогда копия остаётся, а отметки нет;
   *   • профиль переносили на другое устройство, и отметки — память
   *     устройства, а не слово сервера.
   * Пустой прочитанный список поэтому такое же незнание, как и нечитаемый:
   * он говорит «мы не отмечали», а не «на сервере ничего нет».
   *
   * Цена вопроса — один HEAD на свою запись за сессию, и только по долгому
   * нажатию. Ответ «есть» тут же записывается отметкой: иначе следующий
   * запуск начнёт с того же незнания, а человек — с того же пустого меню.
   *
   * HEAD отвечает «есть» только когда копия действительно есть; отказ сети от
   * «копии нет» не отличается, но хуже прежнего не делает — раньше запись в
   * обоих случаях считалась неопубликованной.
   */
  const resolvePublished = useCallback(async (post: LinkablePost) => {
    if (!publicPostStoreAvailable()) return;
    if (post.authorDid !== did || publishedRef.current.has(post.id)) return;
    if (askedRef.current.has(post.id)) return;
    askedRef.current.add(post.id);
    let exists = false;
    try {
      exists = await publicPostCopyExists(post.id);
    } catch {
      exists = false;
    }
    if (!exists) return;
    publishedRef.current.add(post.id);
    setPublishedIds(new Set(publishedRef.current));
    // Отметка — то, по чему меню узнаёт о копии после перезапуска. Отказ
    // записи ничего не отменяет: в этой сессии «Отозвать ссылку» уже на месте,
    // а в следующей сервер спросят заново.
    void setLinkPublished(post.id, true);
  }, [did]);

  /** Общий разбор исхода: что сказать человеку. */
  const report = useCallback((outcome: PostLinkHandoffOutcome, copied: boolean) => {
    switch (outcome.kind) {
      case 'done':
        if (!copied) return;
        if (outcome.reach === 'local') showSuccess(t('feed.linkCopiedForeign'));
        else showSuccess(outcome.justPublished ? t('feed.linkPublishedCopied') : COPIED_LINK);
        return;
      case 'publishFailed':
        showError(t('feed.linkPublishFailed'));
        return;
      case 'handoffFailed':
        showError(copied ? t('feed.linkCopyFailed') : t('feed.linkShareFailed'));
        return;
      case 'cancelled':
      case 'busy':
        // Отмена — решение человека, а по второму нажатию индикатор уже горит.
        return;
    }
  }, [t]);

  const copyLink = useCallback(async (post: LinkablePost) => {
    await resolvePublished(post);
    const outcome = await flow.copyLink(target(post), buildPostLink(post.id).web);
    report(outcome, true);
    return outcome;
  }, [flow, target, report, resolvePublished]);

  const shareLink = useCallback(async (post: LinkablePost, message: string) => {
    await resolvePublished(post);
    const outcome = await flow.shareLink(target(post), message);
    report(outcome, false);
    return outcome;
  }, [flow, target, report, resolvePublished]);

  const publish = useCallback(async (post: LinkablePost) => {
    await resolvePublished(post);
    const outcome = await flow.publish(target(post));
    if (outcome === 'published') showSuccess(t('feed.linkPublishedToast'));
    else if (outcome === 'failed') showError(t('feed.linkPublishFailed'));
    else if (outcome === 'unavailable') showError(t('feed.linkPublishUnavailable'));
    // v4.32.902: 'alreadyPublished' молчит — сюда приходят, когда отметку
    // дочитали у сервера, и пункт меню уже сменился на «Отозвать ссылку».
  }, [flow, target, t, resolvePublished]);

  const revoke = useCallback(async (post: LinkablePost) => {
    await resolvePublished(post);
    const outcome = await flow.revoke(target(post));
    if (outcome === 'revoked') showSuccess(t('feed.linkRevokedToast'));
    else if (outcome === 'failed') showError(t('feed.linkRevokeFailed'));
  }, [flow, target, t, resolvePublished]);

  const isPublished = useCallback((postId: string) => publishedIds.has(postId), [publishedIds]);
  const isBusy = useCallback((postId: string) => busyIds.has(postId), [busyIds]);
  const mayPublish = useCallback(
    (post: LinkablePost) => mayPublishByLink(target(post), { canPublish: publicPostStoreAvailable }),
    [target],
  );

  return { isPublished, isBusy, mayPublish, resolvePublished, copyLink, shareLink, publish, revoke };
}
