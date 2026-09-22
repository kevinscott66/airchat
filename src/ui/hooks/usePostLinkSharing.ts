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
import { publicPostStoreAvailable } from '../../core/social/publicPost';
import { listLinkPublishedPostIds } from '../../core/social/postLinkState';
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
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const pairRef = useRef(pair);
  pairRef.current = pair;
  const tRef = useRef(t);
  tRef.current = t;

  // Отметки у каждого профиля свои — перечитываются при смене личности.
  useEffect(() => {
    let alive = true;
    publishedRef.current = new Set();
    setPublishedIds(new Set());
    void listLinkPublishedPostIds().then((ids) => {
      if (!alive) return;
      publishedRef.current = new Set(ids);
      setPublishedIds(new Set(ids));
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
    const outcome = await flow.copyLink(target(post), buildPostLink(post.id).web);
    report(outcome, true);
    return outcome;
  }, [flow, target, report]);

  const shareLink = useCallback(async (post: LinkablePost, message: string) => {
    const outcome = await flow.shareLink(target(post), message);
    report(outcome, false);
    return outcome;
  }, [flow, target, report]);

  const publish = useCallback(async (post: LinkablePost) => {
    const outcome = await flow.publish(target(post));
    if (outcome === 'published') showSuccess(t('feed.linkPublishedToast'));
    else if (outcome === 'failed') showError(t('feed.linkPublishFailed'));
    else if (outcome === 'unavailable') showError(t('feed.linkPublishUnavailable'));
  }, [flow, target, t]);

  const revoke = useCallback(async (post: LinkablePost) => {
    const outcome = await flow.revoke(target(post));
    if (outcome === 'revoked') showSuccess(t('feed.linkRevokedToast'));
    else if (outcome === 'failed') showError(t('feed.linkRevokeFailed'));
  }, [flow, target, t]);

  const isPublished = useCallback((postId: string) => publishedIds.has(postId), [publishedIds]);
  const isBusy = useCallback((postId: string) => busyIds.has(postId), [busyIds]);
  const mayPublish = useCallback(
    (post: LinkablePost) => mayPublishByLink(target(post), { canPublish: publicPostStoreAvailable }),
    [target],
  );

  return { isPublished, isBusy, mayPublish, copyLink, shareLink, publish, revoke };
}
