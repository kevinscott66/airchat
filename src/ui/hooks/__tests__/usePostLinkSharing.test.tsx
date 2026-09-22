/**
 * Хук ссылок на публикации в живом рендере (AC-04, AC-17, AC-18).
 *
 * Поток проверен отдельно (core/social/__tests__/postLinkFlow). Здесь — что
 * экранная обвязка соединяет его с настоящими диалогом, буфером обмена, листом
 * «поделиться» и тостами в правильном порядке, а состояние «опубликовано по
 * ссылке» и индикатор доходят до отрисовки.
 */
import React, { act } from 'react';
import { Alert, Share } from 'react-native';

// react-test-renderer приходит вместе с jest-expo (его зависимость), но
// деклараций типов у него в проекте нет — нужная нам часть описана здесь.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => { unmount: () => void };
};

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockPublish = jest.fn<Promise<boolean>, [unknown, string]>();
const mockRevoke = jest.fn<Promise<boolean>, [unknown, string]>();
jest.mock('../../../core/social/feedService', () => ({
  publishPostLinkCopy: (pair: unknown, id: string) => mockPublish(pair, id),
  revokePostLinkCopy: (pair: unknown, id: string) => mockRevoke(pair, id),
}));
jest.mock('../../../core/social/publicPost', () => ({ publicPostStoreAvailable: () => true }));
let mockStoredIds = new Set<string>();
jest.mock('../../../core/social/postLinkState', () => ({
  listLinkPublishedPostIds: jest.fn(async () => new Set(mockStoredIds)),
}));
const mockCopy = jest.fn(async (_text: string) => true);
jest.mock('expo-clipboard', () => ({ setStringAsync: (text: string) => mockCopy(text) }));
const mockSuccess = jest.fn();
const mockError = jest.fn();
jest.mock('../../components/userFeedback', () => ({
  showSuccess: (m: string) => mockSuccess(m),
  showError: (m: string) => mockError(m),
}));
jest.mock('../../../core/net/appLink', () => ({
  buildPostLink: (id: string) => ({ web: `https://link/${id}` }),
}));

import { usePostLinkSharing, type PostLinkSharing } from '../usePostLinkSharing';

const ME = 'did:key:me';
const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };
const post = { id: 'p1', authorDid: ME };

/** Что человек нажмёт в следующем диалоге: подтверждающую кнопку или отмену. */
let mockAnswer: 'ok' | 'cancel' = 'ok';
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
  const btn = buttons?.[mockAnswer === 'ok' ? 1 : 0];
  btn?.onPress?.();
});
const shareSpy = jest.spyOn(Share, 'share').mockImplementation(async () => ({ action: Share.sharedAction }));

let hook: PostLinkSharing;
function Harness(): null {
  hook = usePostLinkSharing(pair, ME);
  return null;
}

let mounted: { unmount: () => void } | null = null;
async function mount(): Promise<void> {
  await act(async () => { mounted = TestRenderer.create(<Harness />); });
}

afterEach(() => {
  act(() => { mounted?.unmount(); });
  mounted = null;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStoredIds = new Set();
  mockAnswer = 'ok';
  mockPublish.mockResolvedValue(true);
  mockRevoke.mockResolvedValue(true);
});

describe('usePostLinkSharing', () => {
  it('«Копировать ссылку»: диалог → публикация → буфер → тост; статус у поста', async () => {
    const order: string[] = [];
    alertSpy.mockImplementationOnce((_t, _m, buttons) => { order.push('confirm'); buttons?.[1]?.onPress?.(); });
    mockPublish.mockImplementationOnce(async () => { order.push('publish'); return true; });
    mockCopy.mockImplementationOnce(async () => { order.push('copy'); return true; });
    await mount();
    expect(hook.isPublished('p1')).toBe(false);
    await act(async () => { await hook.copyLink(post); });
    expect(order).toEqual(['confirm', 'publish', 'copy']);
    expect(mockCopy).toHaveBeenCalledWith('https://link/p1');
    expect(mockSuccess).toHaveBeenCalledWith('feed.linkPublishedCopied');
    expect(hook.isPublished('p1')).toBe(true);
  });

  it('отказ публикации — ошибка, ничего не скопировано', async () => {
    mockPublish.mockResolvedValueOnce(false);
    await mount();
    await act(async () => { await hook.copyLink(post); });
    expect(mockCopy).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith('feed.linkPublishFailed');
    expect(hook.isPublished('p1')).toBe(false);
  });

  it('отмена диалога — ни публикации, ни листа «поделиться»', async () => {
    mockAnswer = 'cancel';
    await mount();
    await act(async () => { await hook.shareLink(post, 'msg'); });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(shareSpy).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('индикатор горит, пока идёт публикация; повторное нажатие её не повторяет', async () => {
    let finish!: (v: boolean) => void;
    mockPublish.mockImplementationOnce(() => new Promise<boolean>((r) => { finish = r; }));
    await mount();
    let first!: Promise<unknown>;
    await act(async () => { first = hook.shareLink(post, 'msg'); await Promise.resolve(); });
    expect(hook.isBusy('p1')).toBe(true);
    await act(async () => { await hook.shareLink(post, 'msg'); });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(shareSpy).not.toHaveBeenCalled();
    await act(async () => { finish(true); await first; });
    expect(hook.isBusy('p1')).toBe(false);
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(shareSpy).toHaveBeenCalledWith({ message: 'msg' });
  });

  it('уже опубликованная запись копируется без диалога и без публикации', async () => {
    mockStoredIds = new Set(['p1']);
    await mount();
    expect(hook.isPublished('p1')).toBe(true);
    await act(async () => { await hook.copyLink(post); });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockCopy).toHaveBeenCalledWith('https://link/p1');
  });

  it('«Отозвать ссылку» снимает статус; отказ сервера — оставляет', async () => {
    mockStoredIds = new Set(['p1']);
    await mount();
    mockRevoke.mockResolvedValueOnce(false);
    await act(async () => { await hook.revoke(post); });
    expect(hook.isPublished('p1')).toBe(true);
    expect(mockError).toHaveBeenCalledWith('feed.linkRevokeFailed');
    await act(async () => { await hook.revoke(post); });
    expect(hook.isPublished('p1')).toBe(false);
    expect(mockSuccess).toHaveBeenCalledWith('feed.linkRevokedToast');
  });

  it('чужая запись: ссылка копируется честно «местной», без диалога', async () => {
    await mount();
    await act(async () => { await hook.copyLink({ id: 'p2', authorDid: 'did:key:other' }); });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockSuccess).toHaveBeenCalledWith('feed.linkCopiedForeign');
    expect(hook.mayPublish({ id: 'p2', authorDid: 'did:key:other' })).toBe(false);
  });
});
