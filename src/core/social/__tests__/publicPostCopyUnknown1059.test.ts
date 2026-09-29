/**
 * ДЕФЕКТ (v4.32.1059). «Спросить у сервера не удалось» выдавалось за
 * «копии на сервере нет».
 *
 * `publicPostCopyExists` — HEAD по адресу копии. Её собственный комментарий с
 * v4.32.614 говорит верно: «404 — это не отказ, а ответ… Всё остальное
 * означает, что мы про копию так ничего и не узнали». Но возвращала она при
 * этом одно и то же `false` — и у честного 404, и у 503, и у оборванной сети.
 *
 * ЦЕНА. Читает этот ответ не человек, а снятие копии:
 *
 *   `dropPublicPostCopy` при отказе сервера на удаление переспрашивает HEAD и
 *   отвечает `!exists`. Значит, в метро связка «удалить не вышло» + «спросить
 *   не вышло» читалась как «копию сняли». Дальше по этому слову:
 *     • `revokePostLinkCopy` рапортовал успех и снимал отметку
 *       «опубликовано по ссылке» — а меню рисует «Отозвать ссылку» ровно по
 *       ней, и других способов снять копию в приложении нет;
 *     • `deleteFeedPost` не ставил удаление в очередь повторов и возвращал
 *       `linkCopyLeft: false` — «удалено у всех»;
 *     • `flushLinkDeleteOutbox` вычёркивал запись из очереди навсегда.
 *
 *   Копия при этом незашифрованная и открыта всякому, у кого есть ссылка:
 *   у ссылки нет получателя, чьим ключом её можно было бы закрыть. То есть
 *   человек стирал запись, приложение говорило «стёрта», а по ссылке она
 *   продолжала открываться — и убрать её было больше нечем.
 *
 * ПРАВКА. У чтения три ответа: `true`, `false`, `null`. `null` — «не знаем»:
 * снятие копии считает его неудачей (очередь повторов, отметка на месте),
 * правка записи — расхождением (`linkCopyStale`), а экран ленты перестал
 * запоминать такой ответ за ответ сервера и спросит заново.
 *
 * ГРАНИЦЫ. Идемпотентность снятия держалась на честном 404 и осталась: копии
 * нет — снятие успешно, второе нажатие лечит застрявшую отметку. Тихий `false`
 * остался там, где наружу не ходили вовсе: нет адреса сервера в сборке и
 * негодный id. Отметку «опубликовано» по незнанию не ставим — это слово
 * сервера, а он его не сказал.
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
jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
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

/**
 * Сервер: `head` — что отвечает проверка наличия копии.
 * `null` и есть предмет разбора: «спросили, но не узнали».
 */
const mockServer = {
  copies: new Set<string>(),
  deleteWorks: true,
  head: 'real' as 'real' | 'unknown',
};

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => true,
  isPublicPostId: () => true,
  publicPostCopyExists: jest.fn(async (postId: string) => (
    mockServer.head === 'unknown' ? null : mockServer.copies.has(postId)
  )),
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
import {
  closeFeedStorage,
  publishPostLinkCopy,
  refreshPublicPostCopy,
  revokePostLinkCopy,
  setFeedProfileContext,
} from '../feedService';
import { listLinkPublishedPostIds } from '../postLinkState';

const SRC = readFileSync(join(__dirname, '..', 'feedService.ts'), 'utf8');
const PUB = readFileSync(join(__dirname, '..', 'publicPost.ts'), 'utf8');
const HOOK = readFileSync(join(__dirname, '..', '..', '..', 'ui', 'hooks', 'usePostLinkSharing.ts'), 'utf8');
const RU = readFileSync(join(__dirname, '..', '..', '..', 'i18n', 'ru.json'), 'utf8');

/** Только код: прозой закрепку не удовлетворить. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

/** Кусок между двумя опорами — окно фиксированной длины залезает в соседей. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

async function publishedIds(): Promise<Set<string>> {
  const ids = await listLinkPublishedPostIds();
  expect(ids).not.toBeNull();
  return new Set(ids ?? []);
}

function identity(): { pair: { publicKey: Uint8Array; secretKey: Uint8Array }; did: string } {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { pair: { publicKey, secretKey }, did: publicKeyToDidKey(publicKey) };
}

let pair: { publicKey: Uint8Array; secretKey: Uint8Array };

beforeEach(async () => {
  mockKv.clear();
  mockPosts.clear();
  mockServer.copies.clear();
  mockServer.deleteWorks = true;
  mockServer.head = 'real';
  const who = identity();
  pair = who.pair;
  mockPosts.set('p1', { id: 'p1', authorDid: who.did, text: 'т', timestamp: Date.now() });
  await setFeedProfileContext(1);
  await publishPostLinkCopy(pair, 'p1');
});

afterEach(async () => {
  await closeFeedStorage();
});

describe('отзыв ссылки, когда состояние копии не прочиталось', () => {
  it('не объявляется успехом', async () => {
    mockServer.deleteWorks = false;
    mockServer.head = 'unknown';
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(false);
  });

  it('отметка остаётся — иначе снять копию было бы больше нечем', async () => {
    mockServer.deleteWorks = false;
    mockServer.head = 'unknown';
    await revokePostLinkCopy(pair, 'p1');
    expect((await publishedIds()).has('p1')).toBe(true);
  });

  it('копия на сервере и правда осталась: рапорт был бы неправдой', async () => {
    mockServer.deleteWorks = false;
    mockServer.head = 'unknown';
    await revokePostLinkCopy(pair, 'p1');
    expect(mockServer.copies.has('p1')).toBe(true);
  });

  it('ГРАНИЦА: сервер сказал «нет такой копии» — снятие идемпотентно, как и было', async () => {
    mockServer.deleteWorks = false;
    mockServer.copies.delete('p1');
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(true);
    expect((await publishedIds()).has('p1')).toBe(false);
  });

  it('ГРАНИЦА: рабочее удаление незнанием не задето — HEAD туда и не ходит', async () => {
    mockServer.head = 'unknown';
    expect(await revokePostLinkCopy(pair, 'p1')).toBe(true);
    expect(mockServer.copies.has('p1')).toBe(false);
    expect((await publishedIds()).has('p1')).toBe(false);
  });
});

describe('правка записи, когда состояние копии не прочиталось', () => {
  it('называется расхождением, а не «обновлять было нечего»', async () => {
    mockServer.head = 'unknown';
    expect(await refreshPublicPostCopy(pair, 'p1')).toBe(false);
  });

  it('ГРАНИЦА: копии нет — расхождения нет, запись наружу не кладём', async () => {
    mockServer.copies.clear();
    expect(await refreshPublicPostCopy(pair, 'p1')).toBe(true);
    expect(mockServer.copies.size).toBe(0);
  });

  it('текст для человека годится и там, где копии может не быть вовсе', () => {
    // Прежний текст утверждал, что по ссылке ОТКРЫВАЕТСЯ прежняя редакция. При
    // непрочитанном состоянии мы не знаем даже, есть ли что открывать.
    const ru = JSON.parse(RU) as { feed: Record<string, string> };
    expect(ru.feed.linkCopyStale).toContain('не удалось');
    expect(ru.feed.linkCopyStale).toContain('может');
  });
});

describe('что видно в коде снятия копии', () => {
  it('отказ чтения разобран отдельно от «нет такой копии»', () => {
    const body = between(codeOnly(SRC), 'async function dropPublicPostCopy(', '} catch { return false; }');
    expect(body).toContain('const left = await publicPostCopyExists(postId);');
    expect(body).toContain('if (left === null) {');
    expect(body).toContain("log.warn('public_post_copy_state_unknown'");
    expect(body).toContain('return !left;');
  });

  it('ветка незнания стоит ДО ответа: `!null` иначе прочтётся как «копии нет»', () => {
    const body = between(codeOnly(SRC), 'async function dropPublicPostCopy(', '} catch { return false; }');
    expect(body.indexOf('if (left === null) {')).toBeLessThan(body.indexOf('return !left;'));
    // И механизм, ради которого порядок важен, на месте:
    const notKnown: boolean | null = null;
    expect(!notKnown).toBe(true);
  });

  it('правка записи разбирает тот же ответ своим словом', () => {
    const body = between(codeOnly(SRC), 'export async function refreshPublicPostCopy(', 'export async function fetchPostByLink');
    expect(body).toContain('const copy = await publicPostCopyExists(postId);');
    expect(body).toContain('if (copy === null) {');
    expect(body).toContain("log.warn('public_post_refresh_state_unknown'");
    expect(body).toContain('if (!copy) return true;');
  });
});

describe('что делает экран ленты', () => {
  it('непрочитанный ответ больше не запоминается за ответ сервера', () => {
    const body = between(codeOnly(HOOK), 'const resolvePublished = useCallback', 'const report = useCallback');
    expect(body).toContain('if (exists === null) {');
    expect(body).toContain('askedRef.current.delete(post.id);');
  });

  it('отметку «опубликовано» по незнанию не ставим: выход раньше обоих мест', () => {
    const body = between(codeOnly(HOOK), 'const resolvePublished = useCallback', 'const report = useCallback');
    // Порядок сравнивается только после того, как обе опоры найдены: -1 у
    // отсутствующей строки «меньше» чего угодно, и проверка была бы пустой.
    expect(body).toContain('askedRef.current.delete(post.id);');
    expect(body).toContain('publishedRef.current.add(post.id);');
    expect(body).toContain('void setLinkPublished(post.id, true);');
    // Возврат из ветки незнания идёт ДО записи отметки и до показа пункта меню.
    expect(body.indexOf('askedRef.current.delete(post.id);'))
      .toBeLessThan(body.indexOf('publishedRef.current.add(post.id);'));
    expect(body.indexOf('askedRef.current.delete(post.id);'))
      .toBeLessThan(body.indexOf('void setLinkPublished(post.id, true);'));
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: копия по ссылке не зашифрована — цена именно в этом', () => {
    expect(PUB).toContain('но не зашифрован');
  });

  it('ЗАКРЕПКА: у чтения три ответа, и тихий `false` остался только до сети', () => {
    const body = between(codeOnly(PUB), 'export async function publicPostCopyExists(', '\n}\n');
    expect(body).toContain('Promise<boolean | null>');
    expect(body).toContain('if (!base) return false;');
    expect(body).toContain('if (!isPublicPostId(postId)) return false;');
    expect(body).toContain('if (response.status === 404) return false;');
    expect(body).toContain('return null;');
  });

  it('ЗАКРЕПКА: 404 отвечает раньше журнала — это ответ, а не отказ', () => {
    const body = between(codeOnly(PUB), 'export async function publicPostCopyExists(', '\n}\n');
    expect(body).toContain('if (response.status === 404) return false;');
    expect(body).toContain("log.warn('public_post_head_failed'");
    expect(body.indexOf('if (response.status === 404) return false;'))
      .toBeLessThan(body.indexOf("log.warn('public_post_head_failed'"));
  });

  it('ЗАКРЕПКА: очередь повторов зовётся ровно там, где снятие не удалось', () => {
    const code = codeOnly(SRC);
    // Два места, где неудачное снятие уходит в повтор: гонка с удалением
    // записи и незаписавшаяся отметка при выкладке.
    expect(code.match(/if \(!\(await dropPublicPostCopy\(pair, postId\)\)\) \{/g)).toHaveLength(2);
    expect(code.match(/await queueLinkCopyDelete\(pair, postId\);/g)?.length).toBeGreaterThanOrEqual(3);
    expect(code).toContain('if (!copyGone) await queueLinkCopyDelete(pair, postId);');
  });

  it('ЗАКРЕПКА: других способов снять копию в приложении нет', () => {
    // Вся правка держится на том, что отметка — единственная дверь к отзыву.
    expect(codeOnly(SRC)).toContain('const gone = await dropPublicPostCopy(pair, postId);');
    expect(codeOnly(SRC)).toContain('if (!gone) return false;');
  });
});
