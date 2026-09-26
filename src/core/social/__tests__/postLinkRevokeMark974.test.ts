/**
 * Отзыв ссылки: снятие отметки — часть обещания, а не побочное дело (v4.32.974).
 *
 * Дефект. `revokePostLinkCopy` выбрасывал ответ `setLinkPublished(postId,
 * false)` и всё равно возвращал `true`. Обещание в его же описании — «копии на
 * сервере больше нет, отметка снята» — при отказе базы становилось неправдой.
 *
 * Цена. Копия с сервера действительно уходит, а отметка остаётся лежать. Экран
 * в эту минуту ничего не замечает: он снимает пометку у себя в памяти по
 * ответу `true` и показывает «Ссылка отозвана». Но при следующем запуске
 * отметки перечитываются с диска (`listLinkPublishedPostIds`), и отозванная
 * запись снова горит «опубликовано по ссылке», предлагая отозвать то, чего
 * давно нет. Человек видит открытой ссылку, которую сам закрыл.
 *
 * Правка. Отказ снятия отметки доходит до вызывающего: `false`, экран говорит
 * «не удалось отозвать», и по второму нажатию всё лечится — снятие копии
 * идемпотентно (`dropPublicPostCopy` при отсутствии копии отвечает `true`),
 * а отметка снимается заново.
 *
 * Границы. Отказ сервера — прежний `false` без попытки трогать отметку.
 * Рабочая база — прежний `true`. Повторное нажатие после сбоя — успех.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => undefined) },
}));
jest.mock('../contacts', () => ({ listContacts: jest.fn(async () => []) }));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

type Row = { id: string; authorDid: string; text: string; timestamp: number };
const mockPosts = new Map<string, Row>();

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async close(): Promise<void> { /* закрывать нечего */ }
    async getPost(id: string): Promise<unknown> { return mockPosts.get(id) ?? null; }
  },
}));

const mockKv = new Map<string, string>();
/** Выключатель на СНЯТИЕ отметки — именно на него, а не на базу целиком. */
const mockKvWrites = { unmarkOk: true };
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  // Проверенная форма отказ базы не глотает, а бросает, — так её и подменяем.
  kvDeleteChecked: jest.fn(async (k: string) => {
    if (!mockKvWrites.unmarkOk && k.includes('feed_link_published:')) throw new Error('база не ответила');
    mockKv.delete(k);
  }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvSetSecret: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvGetSecretCell: jest.fn(async (k: string) => {
    const v = mockKv.get(k);
    return v == null ? { state: 'absent' } : { state: 'plain', text: v };
  }),
  kvGetSecretCellUpgrading: jest.fn(async (k: string) => {
    const v = mockKv.get(k);
    return v == null ? { state: 'absent' } : { state: 'plain', text: v };
  }),
  kvGetInlineAttachment: jest.fn(async () => null),
  kvTryGetInlineAttachment: jest.fn(async () => ({ value: null })),
  kvSetInlineAttachment: jest.fn(async () => true),
  kvTryListKeysByPrefix: jest.fn(async (prefix: string) => [...mockKv.keys()].filter((k) => k.startsWith(prefix))),
  kvListKeysByPrefix: jest.fn(async (prefix: string) => [...mockKv.keys()].filter((k) => k.startsWith(prefix))),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

const mockServer = { copies: new Set<string>(), deleteWorks: true };

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => true,
  isPublicPostId: () => true,
  publicPostCopyExists: jest.fn(async (postId: string) => mockServer.copies.has(postId)),
  putPublicPostCopy: jest.fn(async (_p: unknown, payload: { postId: string }) => {
    mockServer.copies.add(payload.postId);
    return true;
  }),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async (_p: unknown, postId: string) => {
    if (!mockServer.deleteWorks) return false;
    mockServer.copies.delete(postId);
    return true;
  }),
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { closeFeedStorage, publishPostLinkCopy, revokePostLinkCopy, setFeedProfileContext } from '../feedService';
import { listLinkPublishedPostIds } from '../postLinkState';

const SRC = readFileSync(join(__dirname, '..', 'feedService.ts'), 'utf8');
const MARK_SRC = readFileSync(join(__dirname, '..', 'postLinkState.ts'), 'utf8');

/** Только код: прозой закрепку не удовлетворить. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

async function publishedIds(): Promise<Set<string>> {
  const ids = await listLinkPublishedPostIds();
  expect(ids).not.toBeNull();
  return ids ?? new Set<string>();
}

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

beforeAll(async () => { await setFeedProfileContext(1); });
afterAll(async () => { await closeFeedStorage(); });

beforeEach(() => {
  mockPosts.clear();
  mockKv.clear();
  mockServer.copies.clear();
  mockServer.deleteWorks = true;
  mockKvWrites.unmarkOk = true;
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'запись', timestamp: 1000 });
});

describe('отзыв ссылки отвечает и за отметку', () => {
  it('отметка не снялась — «отозвано» не говорят', async () => {
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    mockKvWrites.unmarkOk = false;
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(false);
    // Копия ушла — это и есть та половина дела, что удалась.
    expect(mockServer.copies.has('p1')).toBe(false);
    // А отметка лежит: именно её перечитают при следующем запуске.
    expect((await publishedIds()).has('p1')).toBe(true);
  });

  it('ГРАНИЦА: по второму нажатию всё лечится', async () => {
    await publishPostLinkCopy(pair, 'p1');
    mockKvWrites.unmarkOk = false;
    await revokePostLinkCopy(pair, 'p1');
    mockKvWrites.unmarkOk = true;
    // Копии на сервере уже нет — снятие идемпотентно и отвечает «нет её».
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(true);
    expect((await publishedIds()).size).toBe(0);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: с рабочей базой отзыв идёт как прежде', async () => {
    expect(await publishPostLinkCopy(pair, 'p1')).toBe(true);
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockServer.copies.has('p1')).toBe(false);
    expect((await publishedIds()).size).toBe(0);
    // Сама запись остаётся у автора.
    expect(mockPosts.has('p1')).toBe(true);
  });

  it('ГРАНИЦА: сервер отказал — отметка остаётся, отзыв не удался', async () => {
    await publishPostLinkCopy(pair, 'p1');
    mockServer.deleteWorks = false;
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(false);
    expect((await publishedIds()).has('p1')).toBe(true);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: снятие отметки умеет отвечать отказом', () => {
    // Если бы `setLinkPublished` всегда возвращала `true`, проверять было бы
    // нечего: отказ базы просто некому было бы заметить.
    expect(codeOnly(MARK_SRC)).toContain('await scopedKvDeleteChecked(feedLinkPublishedKey(postId));');
    expect(codeOnly(MARK_SRC)).toContain('return false;');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: снятие копии идемпотентно — иначе лечить было бы нечем', () => {
    expect(codeOnly(SRC)).toContain('return !(await publicPostCopyExists(postId));');
  });

  it('ЗАКРЕПКА: ответ снятия отметки не выбрасывается', () => {
    const code = codeOnly(SRC);
    expect(code).toContain('const unmarked = await setLinkPublished(postId, false);');
    expect(code).toContain('if (!unmarked) {');
    expect(code).not.toContain('    await setLinkPublished(postId, false);\n    log.info(');
  });
});
