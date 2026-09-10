/**
 * Репост не уходит без фотографий из-за временного сбоя чтения (v4.32.703).
 *
 * Байты вложений лежат отдельными ключами, а `kvGetInlineAttachment` отвечал
 * на три разных случая одинаково — `null`: строки нет, база занята, ключ
 * шифрования недоступен. Репост копирует байты оригинала под новый id, и на
 * этом схлопнутом ответе делал `continue`: занятая на секунду база выглядела
 * как «фотографии не было». Репост сохранялся у себя и уезжал всем контактам
 * без снимка, а человеку показывали «Репост опубликован».
 *
 * Разделение здесь то же, что у kvTryGet и kvGet: `null` — не прочиталось,
 * `{ value: null }` — строки нет. Обрывать репост на второй причине нельзя:
 * приём чужого поста намеренно терпит неудачную запись вложения (см.
 * `feed_inline_media_receive_save_failed`), и такой пост живёт со ссылкой в
 * пустоту. Безусловный отказ сделал бы его нерепостируемым навсегда — поэтому
 * снимок считается потерянным, а человек об этом узнаёт.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => undefined) },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));
jest.mock('../../sync/cachePolicy', () => ({
  checkOnlineWrite: jest.fn(async () => ({ ok: true, path: 'allow', reachability: 'online' })),
}));

type SavedPost = { id: string; mediaCids: string[] | null };
const mockSaved: SavedPost[] = [];

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async savePost(row: SavedPost): Promise<void> { mockSaved.push(row); }
  },
}));

/** Что отвечает хранилище на каждый ключ: null — не прочиталось. */
const mockCells = new Map<string, { value: string | null } | null>();
let mockInlineSetOk = true;
const mockDeletedPrefixes: string[] = [];

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async () => null),
  kvTryGet: jest.fn(async () => ({ value: null })),
  kvSet: jest.fn(async () => undefined),
  kvSetChecked: jest.fn(async () => true),
  kvDelete: jest.fn(async () => undefined),
  kvDeleteByPrefix: jest.fn(async (p: string) => { mockDeletedPrefixes.push(p); }),
  kvTryGetInlineAttachment: jest.fn(async (k: string) =>
    mockCells.has(k) ? mockCells.get(k) : { value: null }
  ),
  // Схлопнутое чтение — ровно то, что было у репоста до правки.
  kvGetInlineAttachment: jest.fn(async (k: string) =>
    (mockCells.has(k) ? mockCells.get(k) : { value: null })?.value ?? null
  ),
  kvSetInlineAttachment: jest.fn(async () => mockInlineSetOk),
  kvTryListKeysByPrefix: jest.fn(async () => []),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

type Envelope = {
  postId: string;
  data: { originalMedia?: string[] | null; originalMediaBase64?: string[] };
};
const mockSent: Envelope[] = [];

jest.mock('../feedTransport', () => ({
  ...jest.requireActual('../feedTransport'),
  signAndBroadcastFeedEnvelope: jest.fn(async (_pair: unknown, payload: Envelope) => {
    mockSent.push(payload);
    return { delivered: { total: 1, success: 1, successDids: ['did:key:zTest'] } };
  }),
}));

import { ed25519 } from '@noble/curves/ed25519.js';

import { publishRepost, setFeedProfileContext } from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };

const FEED = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
const LOCAL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'storage', 'local.ts'),
  'utf8'
);
const SCREEN = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'),
  'utf8'
);
const RU = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'i18n', 'ru.json'),
  'utf8'
);

/** Тело publishRepost без комментариев — чтобы форму не подтверждал текст о ней. */
function repostBody(): string {
  const from = FEED.indexOf('export async function publishRepost(');
  expect(from).toBeGreaterThan(0);
  const to = FEED.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return FEED.slice(from, to)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function original(cids: string[] | null): Parameters<typeof publishRepost>[1]['originalPost'] {
  return {
    id: 'orig1',
    authorDid: 'did:key:zSomebodyElse',
    authorName: 'Рита',
    text: 'оригинал',
    timestamp: 1000,
    mediaCids: cids,
    cid: null,
  } as unknown as Parameters<typeof publishRepost>[1]['originalPost'];
}

const twoPhotos = ['inline:image/jpeg;0:orig1', 'inline:image/jpeg;1:orig1'];

beforeAll(async () => { await setFeedProfileContext(1); });
beforeEach(() => {
  mockCells.clear();
  mockSaved.length = 0;
  mockSent.length = 0;
  mockDeletedPrefixes.length = 0;
  mockInlineSetOk = true;
});

describe('сбой устройства не превращается в репост без фотографии', () => {
  it('снимок не прочитался — наружу не уходит ничего', async () => {
    mockCells.set('feed_inline_media:orig1:0', null);
    const res = await publishRepost(pair, { originalPost: original(twoPhotos), authorName: 'Я' });
    expect(res.ok).toBe(false);
    expect(mockSaved).toEqual([]);
    expect(mockSent).toEqual([]);
  });

  it('и уже записанные байты за собой убираются', async () => {
    mockCells.set('feed_inline_media:orig1:0', { value: 'AAAA' });
    mockCells.set('feed_inline_media:orig1:1', null);
    expect((await publishRepost(pair, { originalPost: original(twoPhotos), authorName: 'Я' })).ok)
      .toBe(false);
    expect(mockDeletedPrefixes.some((p) => p.startsWith('feed_inline_media:'))).toBe(true);
    expect(mockDeletedPrefixes.some((p) => p.startsWith('feed_inline_doc:'))).toBe(true);
  });

  it('байты не легли на диск — тоже не уходит ничего', async () => {
    mockCells.set('feed_inline_media:orig1:0', { value: 'AAAA' });
    mockInlineSetOk = false;
    const res = await publishRepost(pair, { originalPost: original(twoPhotos), authorName: 'Я' });
    expect(res.ok).toBe(false);
    expect(mockSaved).toEqual([]);
    expect(mockSent).toEqual([]);
    expect(mockDeletedPrefixes.length).toBe(2);
  });
});

describe('снимка нет на устройстве — репост уходит, но об этом говорят', () => {
  it('потерянный снимок посчитан и назван', async () => {
    // Строки нет вовсе: так остаётся пост, у которого на приёме не легло
    // вложение. Запрещать его репостить навсегда — хуже.
    mockCells.set('feed_inline_media:orig1:0', { value: 'AAAA' });
    const res = await publishRepost(pair, { originalPost: original(twoPhotos), authorName: 'Я' });
    expect(res.ok).toBe(true);
    expect(res.mediaDropped).toBe(1);
    expect(mockSaved.length).toBe(1);
    expect(mockSaved[0].mediaCids?.length).toBe(1);
    expect(mockSent.length).toBe(1);
    expect(mockSent[0].data.originalMediaBase64).toEqual(['AAAA']);
  });

  it('не нашлось ни одного — репост всё равно уходит текстом', async () => {
    const res = await publishRepost(pair, { originalPost: original(twoPhotos), authorName: 'Я' });
    expect(res.ok).toBe(true);
    expect(res.mediaDropped).toBe(2);
    expect(mockSaved[0].mediaCids).toBeNull();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удачный репост проходит целиком', () => {
  it('обе фотографии на месте — ни счётчика, ни уборки', async () => {
    mockCells.set('feed_inline_media:orig1:0', { value: 'AAAA' });
    mockCells.set('feed_inline_media:orig1:1', { value: 'BBBB' });
    const res = await publishRepost(pair, { originalPost: original(twoPhotos), authorName: 'Я' });
    expect(res.ok).toBe(true);
    expect('mediaDropped' in res).toBe(false);
    expect(mockSaved[0].mediaCids?.length).toBe(2);
    expect(mockSent[0].data.originalMediaBase64).toEqual(['AAAA', 'BBBB']);
    expect(mockDeletedPrefixes).toEqual([]);
  });

  it('пост без вложений остаётся простым случаем', async () => {
    const res = await publishRepost(pair, { originalPost: original(null), authorName: 'Я' });
    expect(res.ok).toBe(true);
    expect('mediaDropped' in res).toBe(false);
    expect(mockSaved[0].mediaCids).toBeNull();
  });
});

describe('форма правки закреплена', () => {
  it('чтение трёхзначное и объявлено рядом со схлопнутым', () => {
    expect(LOCAL).toContain('export async function kvTryGetInlineAttachment(');
    expect(LOCAL).toContain(
      'return (await kvTryGetInlineAttachment(key))?.value ?? null;'
    );
  });

  it('репост читает трёхзначно и прежнего пропуска не осталось', () => {
    const b = repostBody();
    expect(b).toContain(
      'const cell = await kvTryGetInlineAttachment(`feed_inline_media:${origPostId}:${origIdx}`);'
    );
    expect(b).toContain('await cleanupInlinePayloads(newPostId);');
    expect(b).toContain('mediaDropped++;');
    expect(b).not.toContain('if (!b64) continue;');
  });

  it('отказ на записи байтов тоже обрывает репост, а не пропускает снимок', () => {
    const b = repostBody();
    const warn = b.indexOf("log.warn('feed_repost_inline_media_save_failed'");
    expect(warn).toBeGreaterThan(0);
    const after = b.slice(warn, warn + 400);
    expect(after).toContain('return { ok: false };');
  });

  it('экран называет причину, а не молчит', () => {
    expect(SCREEN).toContain(
      "t('feed.repostMediaDroppedDetail', { count: result.mediaDropped })"
    );
    expect(RU).toContain('"repostMediaDroppedDetail"');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('приём чужого поста по-прежнему терпит неудачную запись вложения', () => {
    // Ровно поэтому «строки нет» не может обрывать репост.
    expect(FEED).toContain("log.warn('feed_inline_media_receive_save_failed'");
  });

  it('kvTryGet по-прежнему отвечает null на неудачу чтения', () => {
    expect(LOCAL).toContain('export async function kvTryGet(');
    expect(LOCAL).toContain("log.warn('kv_get_failed'");
  });

  it('уборка вложений на месте', () => {
    expect(FEED).toContain('async function cleanupInlinePayloads(postId: string): Promise<void> {');
  });

  it('экран по-прежнему рапортует об успехе репоста', () => {
    expect(SCREEN).toContain("'feed.repostQueued' : 'feed.repostPublished'");
  });
});
