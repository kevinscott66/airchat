/**
 * v4.32.553 — проверка сети стояла перед локальной записью в ленте.
 *
 * Дефект: реакция на пост, комментарий, удаление комментария и реакция на
 * комментарий начинались с `requireOnlineWrite()`. Все четыре сначала пишут в
 * свою базу, а рассылку при неудаче кладут в очередь повторов — ту самую, что
 * завели в v4.32.164 ради отсутствия сети. Проверка отменяла и запись, и
 * очередь. Удаление вдобавок документировано как «локальное» и всё равно
 * ждало сети, чтобы стереть строку в своей же базе.
 */
const mockCommentMeta = new Map<string, { postId: string; authorDid: string }>();
const mockDeleted: string[] = [];
const mockAdded: Array<{ id: string; text: string }> = [];
const mockReactions: Array<{ postId: string; emoji: string }> = [];
const mockOnline = { ok: true };

jest.mock('../../storage/feedStorage', () => ({
  FeedStorage: class {
    async init(): Promise<void> { /* стенд без базы */ }
    async getCommentMeta(id: string): Promise<{ postId: string; authorDid: string } | null> {
      return mockCommentMeta.get(id) ?? null;
    }
    async deleteComment(id: string): Promise<void> { mockDeleted.push(id); }
    async getPost(): Promise<null> { return null; }
    async addComment(row: { id: string; text: string }): Promise<void> { mockAdded.push(row); }
    async getComments(): Promise<[]> { return []; }
    async addReaction(postId: string, emoji: string): Promise<void> {
      mockReactions.push({ postId, emoji });
    }
  },
  deleteFeedDbForProfile: jest.fn(async () => undefined),
}));

jest.mock('../../sync/cachePolicy', () => ({
  CACHE_ONLY_MODE: true,
  checkOnlineWrite: jest.fn(async () =>
    mockOnline.ok
      ? { ok: true, path: 'allow', reachability: 'online' }
      : { ok: false, reason: 'offline', reachability: 'no-internet' }
  ),
  requireOnlineWrite: jest.fn(async () => {
    if (!mockOnline.ok) throw new Error('Нет сети: ни интернета, ни устройств поблизости.');
  }),
}));

jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => false), hasLocalPath: jest.fn(async () => false) },
}));
jest.mock('../../social/contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../../social/mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

import { readFileSync } from 'fs';
import { join } from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import {
  addAndBroadcastComment,
  addAndBroadcastReaction,
  deleteFeedComment,
  setFeedProfileContext,
} from '../../social/feedService';
import {
  blocksLocalWrite,
  offlineAction,
  queuesForLater,
  shouldAttemptBroadcast,
  type OfflineAction,
  type WriteShape,
} from '../localFirstWrite';

const SHAPES: WriteShape[] = ['network-only', 'local-first'];
const ACTIONS: OfflineAction[] = ['reject', 'write-and-queue', 'write-only'];

const MODULE = readFileSync(join(__dirname, '..', 'localFirstWrite.ts'), 'utf8');
const FEED = readFileSync(join(__dirname, '..', '..', 'social', 'feedService.ts'), 'utf8');

const { secretKey, publicKey } = ed25519.keygen();
const PAIR = { secretKey, publicKey };
const MY_DID = publicKeyToDidKey(publicKey);

// Очередь повторов ставит настоящий setTimeout: без поддельных таймеров он
// переживает набор и jest жалуется на незакрытый дескриптор. nextTick
// оставляем настоящим — на нём держатся промисы стенда.
beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
});

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

beforeEach(async () => {
  mockCommentMeta.clear();
  mockDeleted.length = 0;
  mockAdded.length = 0;
  mockReactions.length = 0;
  mockOnline.ok = true;
  await setFeedProfileContext(1);
});

describe('где стоять проверке сети', () => {
  it('локальную запись запрещает ровно network-only', () => {
    expect(SHAPES.filter((s) => blocksLocalWrite(offlineAction(s, true)))).toEqual(['network-only']);
    expect(SHAPES.filter((s) => blocksLocalWrite(offlineAction(s, false)))).toEqual(['network-only']);
  });

  it('очередь обещаем только тем, у кого она есть', () => {
    expect(offlineAction('local-first', true)).toBe('write-and-queue');
    expect(offlineAction('local-first', false)).toBe('write-only');
    expect(queuesForLater(offlineAction('local-first', false))).toBe(false);
  });

  it('очередь и запрет никогда не совпадают', () => {
    for (const action of ACTIONS) {
      expect(blocksLocalWrite(action) && queuesForLater(action)).toBe(false);
    }
  });

  it('оффлайн-рассылку не пробуем — ответ известен заранее', () => {
    expect(shouldAttemptBroadcast(false)).toBe(false);
    expect(shouldAttemptBroadcast(true)).toBe(true);
  });

  it('наличие очереди не влияет на право писать', () => {
    for (const shape of SHAPES) {
      expect(blocksLocalWrite(offlineAction(shape, true)))
        .toBe(blocksLocalWrite(offlineAction(shape, false)));
    }
  });
});

describe('лента без сети', () => {
  it('удаление комментария и правда локальное', async () => {
    mockCommentMeta.set('c1', { postId: 'p1', authorDid: MY_DID });
    mockOnline.ok = false;

    await expect(deleteFeedComment(PAIR, 'c1')).resolves.toBeUndefined();
    expect(mockDeleted).toEqual(['c1']);
  });

  it('комментарий пишется локально, а не отвергается', async () => {
    mockOnline.ok = false;
    const row = await addAndBroadcastComment(PAIR, 'p1', 'без сети', 'Я');
    expect(row.text).toBe('без сети');
    expect(mockAdded).toHaveLength(1);
  });

  it('реакция ставится себе даже в Wi-Fi без интернета', async () => {
    mockOnline.ok = false;
    await expect(addAndBroadcastReaction(PAIR, 'p1', '👍')).resolves.toBeUndefined();
    expect(mockReactions).toEqual([{ postId: 'p1', emoji: '👍' }]);
  });

  it('проверка не пустая: те же вызовы проходят и с сетью', async () => {
    mockCommentMeta.set('c2', { postId: 'p1', authorDid: MY_DID });
    await expect(deleteFeedComment(PAIR, 'c2')).resolves.toBeUndefined();
    expect(mockDeleted).toEqual(['c2']);
    await addAndBroadcastComment(PAIR, 'p1', 'с сетью', 'Я');
    expect(mockAdded).toHaveLength(1);
  });

  it('чужой комментарий по-прежнему не удаляется', async () => {
    mockCommentMeta.set('c3', { postId: 'p1', authorDid: 'did:key:z6Mkчужой' });
    mockOnline.ok = false;
    await deleteFeedComment(PAIR, 'c3');
    expect(mockDeleted).toEqual([]);
  });

  it('пустой комментарий отвергается и без сети', async () => {
    mockOnline.ok = false;
    await expect(addAndBroadcastComment(PAIR, 'p1', '   ', 'Я')).rejects.toThrow('пустой');
    expect(mockAdded).toEqual([]);
  });
});

describe('форма исходников', () => {
  it('модуль решения без импортов', () => {
    expect(MODULE).not.toMatch(/^import\s/m);
    expect(MODULE).not.toMatch(/\brequire\(/);
  });

  it('в ленте не осталось проверки перед локальной записью', () => {
    expect(FEED).not.toContain('requireOnlineWrite');
  });

  it('все четыре действия спрашивают сеть перед рассылкой', () => {
    // v4.32.554: считать все вхождения подряд больше нельзя — публикация и
    // репост спрашивают сеть тем же способом. Проверяем сами обёртки: три
    // рассылки комментариев внутри условия и отдельная ветка реакции.
    const guarded = FEED.match(
      /if \(shouldAttemptBroadcast\(online\.ok\)\) \{[\s\S]{0,200}?res = await signAndBroadcastFeedEnvelope/g
    );
    expect(guarded).toHaveLength(3);
    expect(FEED).toMatch(
      /if \(!shouldAttemptBroadcast\(online\.ok\)\) \{[\s\S]{0,200}?feed_reaction_local_only/
    );
  });

  it('пропуск рассылки не молчит', () => {
    expect(FEED).toContain("log.info('feed_comment_queued_offline'");
    expect(FEED).toContain("log.info('feed_comment_delete_queued_offline'");
    expect(FEED).toContain("log.info('feed_comment_reaction_queued_offline'");
    expect(FEED).toContain("log.info('feed_reaction_local_only'");
  });
});
