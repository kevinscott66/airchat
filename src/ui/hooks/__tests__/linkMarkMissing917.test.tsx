/**
 * Пропавшая отметка «опубликовано по ссылке» прятала единственный способ её снять (v4.32.917).
 *
 * Дефект. Признак «запись выложена по ссылке» живёт отметкой в базе
 * устройства, и меню записи рисует «Отозвать ссылку» ровно по нему. С
 * v4.32.902 приложение умело дочитывать признак у сервера — но только в одном
 * случае: когда не прочитался ВЕСЬ список отметок (`listLinkPublishedPostIds`
 * ответил `null`). Прочитанный пустой список считался знанием: «наружу ничего
 * не выложено».
 *
 * А отметка пропадает и поодиночке, и в списке от этого не `null`, а пусто:
 *   • `refreshPublicPostCopy` ставит её задним числом (копия на сервере есть,
 *     отметки нет — её не вела старая сборка), и до этой правки исход той
 *     записи выбрасывался;
 *   • `publishPostLinkCopy` при незаписавшейся отметке снимает копию обратно,
 *     но снять удаётся не всегда — тогда копия лежит, а отметки нет;
 *   • профиль перенесли на другое устройство: отметки — память устройства, а
 *     не слово сервера.
 *
 * Цена. Копия записи лежит на сервере НЕ зашифрованной: её читает любой, к
 * кому попала ссылка. Пункта «Отозвать ссылку» у такой записи не было ни в
 * одной сессии — не «до перезапуска», как в v4.32.902, а никогда. Хуже: меню
 * предлагало «Опубликовать по ссылке», то есть выложить ещё раз то, что уже
 * лежит открытым.
 *
 * Правка. Пустая отметка приравнена к незнанию: у своей записи, за которой
 * отметки не числится, состояние дочитывается у сервера (HEAD по копии) — один
 * раз на запись за сессию и только по долгому нажатию. Подтверждённая копия
 * тут же записывается отметкой, иначе следующий запуск начнёт с того же
 * незнания. Отдельный признак «список не прочитался» за ненадобностью убран:
 * пустой и нечитаемый список теперь разбираются одним путём.
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

/** Настроено ли облако. Без него спрашивать некого. */
let mockStoreOn = true;
/** Ответ сервера на «лежит ли копия»: HEAD по адресу копии. */
const mockCopyExists = jest.fn<Promise<boolean>, [string]>();
jest.mock('../../../core/social/publicPost', () => ({
  publicPostStoreAvailable: () => mockStoreOn,
  publicPostCopyExists: (id: string) => mockCopyExists(id),
}));

/** `null` — отметки не прочитались; пустой набор — прочитались и пусты. */
let mockStoredIds: Set<string> | null = new Set<string>();
const mockSetMark = jest.fn<Promise<boolean>, [string, boolean]>();
jest.mock('../../../core/social/postLinkState', () => ({
  listLinkPublishedPostIds: jest.fn(async () => (mockStoredIds === null ? null : new Set(mockStoredIds))),
  setLinkPublished: (id: string, v: boolean) => mockSetMark(id, v),
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

/** Исходник службы ленты: часть правки живёт в дописывании отметки. */
function feedService(): string {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'core', 'social', 'feedService.ts'),
    'utf8',
  );
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
  mockStoreOn = true;
  mockPublish.mockResolvedValue(true);
  mockRevoke.mockResolvedValue(true);
  mockCopyExists.mockResolvedValue(false);
  mockSetMark.mockResolvedValue(true);
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('хук поднимается и отдаёт разбор состояния', async () => {
    await mount();
    expect(typeof hook.resolvePublished).toBe('function');
    expect(typeof hook.isPublished).toBe('function');
  });

  it('мок сервера в этом наборе действительно зовут — иначе проверки пусты', async () => {
    // Нарочно берётся случай, который спрашивал сервер и до правки
    // (список не прочитался): проверка стоит ради живости мока, а не ради
    // нового поведения — его спрашивают ниже.
    mockStoredIds = null;
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.resolvePublished(post); });
    expect(mockCopyExists).toHaveBeenCalled();
  });
});

describe('отметки нет, а копия на сервере лежит', () => {
  it('прочитанный пустой список — это незнание, а не «ничего не выложено»', async () => {
    mockStoredIds = new Set();
    mockCopyExists.mockResolvedValue(true);
    await mount();
    expect(hook.isPublished('p1')).toBe(false);
    await act(async () => { await hook.resolvePublished(post); });
    expect(mockCopyExists).toHaveBeenCalledWith('p1');
    expect(hook.isPublished('p1')).toBe(true);
  });

  it('подтверждённая копия записывается отметкой — иначе следующий запуск начнёт с нуля', async () => {
    mockStoredIds = new Set();
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.resolvePublished(post); });
    expect(mockSetMark).toHaveBeenCalledWith('p1', true);
  });

  it('«Копировать ссылку» у такой записи не выкладывает её заново', async () => {
    mockStoredIds = new Set();
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.copyLink(post); });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockCopy).toHaveBeenCalledWith('https://link/p1');
  });

  it('«Отозвать ссылку» доходит до сервера и по отметке, которой не было', async () => {
    mockStoredIds = new Set();
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.revoke(post); });
    expect(mockRevoke).toHaveBeenCalledWith(pair, 'p1');
    expect(mockSuccess).toHaveBeenCalledWith('feed.linkRevokedToast');
    expect(hook.isPublished('p1')).toBe(false);
  });

  it('без настроенного облака сервер не спрашивают вовсе', async () => {
    mockStoredIds = null;
    mockStoreOn = false;
    await mount();
    await act(async () => { await hook.resolvePublished(post); });
    expect(mockCopyExists).not.toHaveBeenCalled();
  });

  it('дописывание отметки задним числом больше не выбрасывает исход', () => {
    const src = feedService();
    expect(src).toContain('if (!(await setLinkPublished(postId, true))) {');
    expect(src).toContain("log.warn('public_post_backfill_mark_failed'");
    // Прежняя форма: запись без проверки прямо посреди обновления копии.
    expect(src).not.toContain('    await setLinkPublished(postId, true);');
  });
});

describe('до правки было верно и осталось верно', () => {
  it('отметка есть — сервер про неё не спрашивают', async () => {
    mockStoredIds = new Set(['p1']);
    await mount();
    expect(hook.isPublished('p1')).toBe(true);
    await act(async () => { await hook.revoke(post); });
    expect(mockCopyExists).not.toHaveBeenCalled();
    expect(mockRevoke).toHaveBeenCalledWith(pair, 'p1');
    expect(mockSuccess).toHaveBeenCalledWith('feed.linkRevokedToast');
  });

  it('копии на сервере нет — прежний путь публикации цел', async () => {
    mockStoredIds = new Set();
    mockCopyExists.mockResolvedValue(false);
    await mount();
    await act(async () => { await hook.copyLink(post); });
    expect(alertSpy).toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(pair, 'p1');
    expect(mockCopy).toHaveBeenCalledWith('https://link/p1');
  });

  it('про чужую запись сервер не спрашивают: выкладывать её всё равно нечем', async () => {
    mockStoredIds = null;
    await mount();
    await act(async () => { await hook.resolvePublished(foreign); });
    expect(mockCopyExists).not.toHaveBeenCalled();
  });

  it('сервер спрашивают один раз на запись, а не при каждом открытии меню', async () => {
    mockStoredIds = null;
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.resolvePublished(post); });
    await act(async () => { await hook.resolvePublished(post); });
    expect(mockCopyExists).toHaveBeenCalledTimes(1);
  });

  it('нечитаемый список разбирается тем же путём, что и прежде', async () => {
    mockStoredIds = null;
    mockCopyExists.mockResolvedValue(true);
    await mount();
    await act(async () => { await hook.resolvePublished(post); });
    expect(hook.isPublished('p1')).toBe(true);
  });
});
