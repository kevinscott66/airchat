/**
 * «Отозвать ссылку» не должно пропадать оттого, что не прочиталась база.
 *
 * Дефект. Отметки «опубликовано по ссылке» экран читал один раз при монтаже, и
 * отказ базы приходил пустым набором. Дальше всю сессию своя опубликованная
 * запись выглядела неопубликованной: в меню вместо «Отозвать ссылку» стояло
 * «Опубликовать по ссылке».
 *
 * Цена. Копия записи лежит на сервере НЕ зашифрованной — её читает любой, к
 * кому попала ссылка. Единственная кнопка, которая её снимает, исчезала без
 * единого слова, и до перезапуска приложения отозвать ссылку было нечем.
 *
 * Правка (v4.32.902). `listLinkPublishedPostIds` отдаёт `null`, когда отметки
 * не прочитались, и хук это состояние помнит. При нём состояние конкретной
 * записи дочитывается у сервера (HEAD по копии) — перед показом меню и перед
 * любым действием со ссылкой. Когда отметки прочитались, сервер не трогается
 * вовсе.
 */
import React, { act } from 'react';
import { Alert, Share } from 'react-native';

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

/** Ответ сервера на «лежит ли копия»: HEAD по адресу копии. */
const mockCopyExists = jest.fn<Promise<boolean>, [string]>();
jest.mock('../../../core/social/publicPost', () => ({
  publicPostStoreAvailable: () => true,
  publicPostCopyExists: (id: string) => mockCopyExists(id),
}));

/** `null` — отметки не прочитались. */
let mockStoredIds: Set<string> | null = new Set<string>();
jest.mock('../../../core/social/postLinkState', () => ({
  listLinkPublishedPostIds: jest.fn(async () => (mockStoredIds === null ? null : new Set(mockStoredIds))),
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

import fs from 'fs';
import path from 'path';

import { usePostLinkSharing, type PostLinkSharing } from '../usePostLinkSharing';

/** Исходник экрана ленты: часть правки живёт в разметке меню. */
function feedScreen(): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'screens', 'FeedScreen.tsx'), 'utf8');
}

const ME = 'did:key:me';
const pair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };
const post = { id: 'p1', authorDid: ME };
const foreign = { id: 'p9', authorDid: 'did:key:someone' };

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
  buttons?.[1]?.onPress?.();
});
jest.spyOn(Share, 'share').mockImplementation(async () => ({ action: Share.sharedAction }));

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
  mockPublish.mockResolvedValue(true);
  mockRevoke.mockResolvedValue(true);
  mockCopyExists.mockResolvedValue(false);
});

describe('отметки не прочитались', () => {
  it('копия на сервере есть — запись снова считается опубликованной', async () => {
    mockStoredIds = null;
    mockCopyExists.mockResolvedValue(true);
    await mount();
    expect(hook.isPublished('p1')).toBe(false);
    await act(async () => { await hook.resolvePublished(post); });
    expect(mockCopyExists).toHaveBeenCalledWith('p1');
    expect(hook.isPublished('p1')).toBe(true);
  });

  it('«Отозвать ссылку» доходит до сервера, а не молчит', async () => {
    mockStoredIds = null;
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.revoke(post); });
    expect(mockRevoke).toHaveBeenCalledWith(pair, 'p1');
    expect(mockSuccess).toHaveBeenCalledWith('feed.linkRevokedToast');
    expect(hook.isPublished('p1')).toBe(false);
  });

  it('уже опубликованную запись «Копировать ссылку» не выкладывает заново', async () => {
    mockStoredIds = null;
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.copyLink(post); });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockCopy).toHaveBeenCalledWith('https://link/p1');
  });

  it('сервер спрашивается один раз на запись, а не при каждом открытии меню', async () => {
    mockStoredIds = null;
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.resolvePublished(post); });
    await act(async () => { await hook.resolvePublished(post); });
    expect(mockCopyExists).toHaveBeenCalledTimes(1);
  });

  it('меню записи дочитывает состояние перед показом', () => {
    expect(feedScreen()).toContain('void postLinks.resolvePublished(item);');
  });

  it('про чужую запись сервер не спрашивается: выкладывать её всё равно нечем', async () => {
    mockStoredIds = null;
    await mount();
    await act(async () => { await hook.resolvePublished(foreign); });
    expect(mockCopyExists).not.toHaveBeenCalled();
  });
});

describe('ничего лишнего', () => {
  it('копии на сервере нет — запись так и считается неопубликованной', async () => {
    mockStoredIds = null;
    mockCopyExists.mockResolvedValue(false);
    await mount();
    expect(hook.isPublished('p1')).toBe(false);
    await act(async () => { await hook.copyLink(post); });
    // Прежний путь цел: подтверждение, публикация, только потом буфер.
    expect(alertSpy).toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(pair, 'p1');
    expect(mockCopy).toHaveBeenCalledWith('https://link/p1');
  });

  it('отметки прочитались и пусты — это по-прежнему «не опубликовано»', async () => {
    await mount();
    expect(hook.isPublished('p1')).toBe(false);
    await act(async () => { await hook.copyLink(post); });
    expect(alertSpy).toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(pair, 'p1');
  });

  it('отметки прочитались — сервер про них не спрашивают', async () => {
    mockStoredIds = new Set(['p1']);
    await mount();
    expect(hook.isPublished('p1')).toBe(true);
    await act(async () => { await hook.revoke(post); });
    expect(mockCopyExists).not.toHaveBeenCalled();
    expect(mockRevoke).toHaveBeenCalledWith(pair, 'p1');
    expect(mockSuccess).toHaveBeenCalledWith('feed.linkRevokedToast');
  });

  it('в меню «Отозвать ссылку» по-прежнему висит на признаке публикации', () => {
    // Повод для правки жив: пункт по-прежнему рисуется только у записи,
    // которую приложение считает опубликованной, — значит, ошибиться в этом
    // признаке по-прежнему значит спрятать единственный способ отозвать копию.
    expect(feedScreen()).toContain('const linkPublishedP = isSelfP && postLinks.isPublished(p.id);');
    expect(feedScreen()).toContain('{isSelfP && linkPublishedP');
  });
});
