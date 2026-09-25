/**
 * Не скачавшееся медиа больше не превращает сторис в пустую карточку (v4.32.820).
 *
 * Дефект. Вложение сторис качается сразу при приёме — и это не оплошность:
 * сторис живёт сутки, а вложение на relay около трёх часов. Но любой отказ
 * скачивания молча оставлял адрес пустым, и сторис записывалась БЕЗ снимка
 * навсегда: строка есть, повтора у конверта нет, второй раз её не пришлют.
 *
 * Цена. Оффлайн в минуту приёма — обычное дело, а итог его был неотличим от
 * «друг выложил пустую карточку»: у сторис текст необязателен, так что в ленте
 * оставался пустой прямоугольник, и объяснить его было нечем.
 *
 * Правка. Исход похода за медиа называется словом. «Сейчас не достали»
 * откладывает кадр — он полежит на relay и придёт снова; ждать недолго и
 * безопасно, потому что просроченный конверт разбор уже не принимает, и
 * откладывание кончается вместе с самой сторис. «Не возьмём никогда» (битая
 * ссылка, медиа больше потолка) записывается как есть: текст может быть всем
 * содержанием, а каждая лишняя попытка — это ещё одно скачивание.
 */

/** Байты, которые отдаст IPFS; null — не достали. */
let mockIpfsBytes: Uint8Array | null = null;
/** Сколько раз ходили в IPFS. */
let mockIpfsFetches = 0;
/** Это `nb:`-вложение (шифрованное) вместо обычного CID. */
let mockIsNb = false;
/** Разбирается ли `nb:`-ссылка. */
let mockNbParses = true;
/** Путь к расшифрованному файлу; null — не достали. */
let mockBlobFile: string | null = null;

/** Что записано — с адресом медиа. */
const mockInserted: { id: string; text: string | null; mediaUri: string | null }[] = [];
/** Сколько активных сторис уже у автора. */
let mockActiveCount = 0;
/** Кто в контактах. */
let mockContacts: { peerPublicKey: string }[] = [];

let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `story${++mockUuid}` }));

jest.mock('../contacts', () => ({
  listContactsFor: async () => mockContacts,
  listContactsReadFor: async () => mockContacts,
  // v4.32.957: приём сторис спрашивает справочник вместе с числом строк,
  // которые не открылись, — короткий список он больше не принимает за полный.
  listContactsReadDetailed: async () => ({ contacts: mockContacts, missing: 0 }),
}));

jest.mock('../../storage/local', () => ({
  insertStory: async (row: { id: string; text: string | null; mediaUri: string | null }) => {
    mockInserted.push({ id: row.id, text: row.text, mediaUri: row.mediaUri });
  },
  deleteExpiredStories: async () => undefined,
  countActiveStoriesByAuthor: async () => mockActiveCount,
  STORY_TTL_MS: 24 * 60 * 60 * 1000,
}));

jest.mock('../../transport/ipfs/node', () => ({
  catFromIpfs: async () => {
    mockIpfsFetches += 1;
    return mockIpfsBytes;
  },
}));

jest.mock('../../media/mediaBlob', () => ({
  isNbCid: () => mockIsNb,
  parseNbCid: () => (mockNbParses ? { i: 'id', k: 'key', u: 'https://relay/x' } : null),
  resolveBlobToLocalFile: async () => mockBlobFile,
}));

jest.mock('../../media/mediaUpload', () => ({ uploadMediaToCid: async () => null }));
jest.mock('../../identity/ownerPidLookup', () => ({ ownerPidForPublicKey: async () => 1 }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { encodeStoryEnvelope, type StoryEnvelope } from '../storyEnvelope';
import { handleIncomingStory, resolveStoryMedia, resolveStoryMediaRead } from '../storyService';

const AUTHOR = 'A'.repeat(43);
const PID = 3;
const CID = 'bafy' + 'q'.repeat(50);

function storyEnv(id: string, over: Partial<StoryEnvelope> = {}): string {
  const now = Date.now();
  return encodeStoryEnvelope({
    id,
    authorPubB64: AUTHOR,
    authorDid: 'did:key:zAuthor',
    mediaCid: CID,
    mediaType: 'image',
    text: `сторис ${id}`,
    expiresAt: now + 3600_000,
    createdAt: now - 1000,
    ...over,
  });
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SRC = codeOnly(readFileSync(join(__dirname, '..', 'storyService.ts'), 'utf8'));

beforeEach(() => {
  mockIpfsBytes = null;
  mockIpfsFetches = 0;
  mockIsNb = false;
  mockNbParses = true;
  mockBlobFile = null;
  mockInserted.length = 0;
  mockActiveCount = 0;
  mockContacts = [{ peerPublicKey: AUTHOR }];
});

describe('медиа не достали — кадр ждёт, а не записывается пустым', () => {
  it('IPFS молчит: отложено, строки нет', async () => {
    expect(await handleIncomingStory(storyEnv('s1'), AUTHOR, PID)).toBe('deferred');
    expect(mockInserted).toEqual([]);
  });

  it('связь вернулась — тот же кадр приносит сторис со снимком', async () => {
    const env = storyEnv('s2');
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('deferred');

    mockIpfsBytes = new Uint8Array([1, 2, 3]);
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0].mediaUri).toContain('data:image/jpeg;base64,');
  });

  it('поход за медиа называет беду словом, а не пустотой', async () => {
    await expect(resolveStoryMediaRead(CID, 'image')).resolves.toEqual({ state: 'unavailable' });
    mockIpfsBytes = new Uint8Array([1]);
    await expect(resolveStoryMediaRead(CID, 'image')).resolves.toEqual({
      state: 'ready',
      uri: expect.stringContaining('data:image/jpeg;base64,'),
    });
  });

  it('шифрованное вложение не расшифровалось в файл: отложено', async () => {
    mockIsNb = true;
    expect(await handleIncomingStory(storyEnv('s3'), AUTHOR, PID)).toBe('deferred');
    expect(mockInserted).toEqual([]);

    mockBlobFile = 'file:///cache/s3.jpg';
    expect(await handleIncomingStory(storyEnv('s3'), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted[0].mediaUri).toBe('file:///cache/s3.jpg');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отсрочка у сторис дороже, чем у настроек: второй разбор кадра — это ещё одна
 * загрузка. Откладывать можно ровно то, что пройдёт само; окончательное
 * обязано остаться окончательным, иначе каждый отказ превращается в трафик,
 * повторяемый до конца суток.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: окончательные отказы медиа остаются окончательными', () => {
  it('медиа больше потолка — сторис записывается текстом, кадр разобран', async () => {
    mockIpfsBytes = new Uint8Array(11 * 1024 * 1024);
    expect(await handleIncomingStory(storyEnv('s4'), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0].mediaUri).toBeNull();
    expect(mockInserted[0].text).toBe('сторис s4');
  });

  it('битая `nb:`-ссылка — тоже текстом, и в сеть за ней не ходят', async () => {
    mockIsNb = true;
    mockNbParses = false;
    expect(await handleIncomingStory(storyEnv('s5'), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted[0].mediaUri).toBeNull();
    expect(mockIpfsFetches).toBe(0);
  });

  it('сторис без вложения проходит с первого раза', async () => {
    expect(await handleIncomingStory(storyEnv('s6', { mediaCid: null }), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toHaveLength(1);
    expect(mockIpfsFetches).toBe(0);
  });

  it('удачное скачивание — один поход в сеть, а не два', async () => {
    mockIpfsBytes = new Uint8Array([7]);
    expect(await handleIncomingStory(storyEnv('s7'), AUTHOR, PID)).toBe('consumed');
    expect(mockIpfsFetches).toBe(1);
  });

  it('отказ до медиа по-прежнему обходится без скачивания', async () => {
    mockContacts = [];
    expect(await handleIncomingStory(storyEnv('s8'), AUTHOR, PID)).toBe('consumed');
    expect(mockIpfsFetches).toBe(0);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Поход за медиа сообщает о беде ОТВЕТОМ, а не исключением: `try/catch` вокруг
 * него ловил ровно ничего, а пустой ответ уходил в запись. Значит пустая
 * карточка — это именно проглоченное слово, а не «упало бы и так».
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: неудача скачивания не бросает', () => {
  it('поход за медиа не бросает — он тихо отвечает пустотой', async () => {
    await expect(resolveStoryMedia(CID, 'image')).resolves.toBeNull();
    mockIsNb = true;
    await expect(resolveStoryMedia(CID, 'image')).resolves.toBeNull();
  });

  it('экрану альбома разница пород не нужна — ему по-прежнему отвечают адресом или ничем', async () => {
    await expect(resolveStoryMedia(CID, 'image')).resolves.toBeNull();
    mockIpfsBytes = new Uint8Array([1]);
    await expect(resolveStoryMedia(CID, 'image')).resolves.toContain('data:image/jpeg;base64,');
  });
});

describe('форма исходников: исход скачивания прочитан', () => {
  it('приём различает «сейчас нет» и «не будет никогда»', () => {
    const at = SRC.indexOf('async function applyIncomingStory(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, SRC.indexOf('export async function handleIncomingStory(', at));
    expect(body).toContain('await resolveStoryMediaRead(envelope.mediaCid, envelope.mediaType)');
    const defer = body.indexOf("if (read.state === 'unavailable') {");
    expect(defer).toBeGreaterThan(0);
    expect(body.slice(defer, defer + 260)).toContain("return 'deferred';");
    // Немой `catch {}`, из-за которого адрес оставался пустым, ушёл.
    expect(body).not.toContain('mediaUri = await resolveStoryMedia(');
  });

  it('слово об исходе рождается там же, где скачивание', () => {
    expect(SRC).toContain('export async function resolveStoryMediaRead(');
    expect(SRC).toContain("state: 'unavailable'");
    expect(SRC).toContain("state: 'rejected'");
  });
});
