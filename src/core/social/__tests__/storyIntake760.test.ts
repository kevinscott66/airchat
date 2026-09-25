/**
 * Занятая база больше не теряет сторис контакта (v4.32.760).
 *
 * Приём сторис отвечал `true` всегда, и означало это «конверт наш». Ветка в
 * messaging.ts ответ даже не читала: она объявляла кадр разобранным в любом
 * исходе. «Разобрано» двигает метку докуда прочитано, а relay отдаёт
 * накопленное только по ней — и второй такой конверт не придёт: контакт помнит,
 * что опубликовал.
 *
 * Отказов внутри было четыре, и они разной породы. «Автор не в контактах» и «у
 * автора упёрся потолок активных» — решения окончательные, повтор их не изменит.
 * А «список контактов не прочитался» и «счётчик не прочитался» — это занятая на
 * секунду база; оба возвращали ровно то же самое, что и окончательные, и
 * сторис пропадала насовсем. Причём у автора она опубликована: конверт ушёл.
 *
 * Правка: приём отвечает `EnvelopeIntake`. Откладывается только занятая база —
 * разбор кадра второй раз означает повторную загрузку вложения, поэтому
 * откладываем ровно то, что пройдёт само.
 */

/**
 * Что сделает чтение списка контактов: true — откажет, как занятая база.
 *
 * v4.32.957: именно ОТКАЖЕТ, а не бросит. Настоящее `readContactsFor` гасит
 * любое исключение своим `catch` и отдаёт значением: null у различающих входов,
 * пустой список у сплющивающего. Прежняя подмена бросала — и потому проверка
 * ниже проходила по мёртвой ветке `catch`, а не по тому, что бывает на
 * устройстве.
 */
let mockContactsReadFails = false;
/** Что сделает счётчик активных сторис автора: true — бросит. */
let mockCountFails = false;
/** Что сделает запись строки сторис: true — бросит. */
let mockInsertFails = false;
/** Сколько активных сторис уже у автора. */
let mockActiveCount = 0;
/** Кто в контактах. */
let mockContacts: { peerPublicKey: string }[] = [];
/** Что записано — по порядку. */
const mockInserted: { id: string; text: string | null }[] = [];
/** Сколько раз скачивали вложение: отсрочка стоит повторной загрузки. */
let mockMediaFetches = 0;

let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `story${++mockUuid}` }));

jest.mock('../contacts', () => ({
  listContactsFor: async () => (mockContactsReadFails ? [] : mockContacts),
  listContactsReadFor: async () => (mockContactsReadFails ? null : mockContacts),
  listContactsReadDetailed: async () =>
    mockContactsReadFails ? null : { contacts: mockContacts, missing: 0 },
}));

jest.mock('../../storage/local', () => ({
  insertStory: async (row: { id: string; text: string | null }) => {
    if (mockInsertFails) throw new Error('database is locked');
    mockInserted.push({ id: row.id, text: row.text });
  },
  deleteExpiredStories: async () => undefined,
  countActiveStoriesByAuthor: async () => {
    if (mockCountFails) throw new Error('database is locked');
    return mockActiveCount;
  },
  STORY_TTL_MS: 24 * 60 * 60 * 1000,
}));

jest.mock('../../transport/ipfs/node', () => ({
  catFromIpfs: async () => {
    mockMediaFetches += 1;
    return null;
  },
}));

jest.mock('../../media/mediaBlob', () => ({
  isNbCid: () => false,
  parseNbCid: () => null,
  resolveBlobToLocalFile: async () => null,
}));

jest.mock('../../media/mediaUpload', () => ({ uploadMediaToCid: async () => null }));

jest.mock('../../identity/ownerPidLookup', () => ({ ownerPidForPublicKey: async () => 1 }));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { encodeStoryEnvelope, type StoryEnvelope } from '../storyEnvelope';
import { handleIncomingStory } from '../storyService';

const AUTHOR = 'A'.repeat(43);
const PID = 3;

/** Конверт сторис текстом — без вложения, чтобы загрузка не мешала счёту. */
function storyEnv(id: string, over: Partial<StoryEnvelope> = {}): string {
  const now = Date.now();
  return encodeStoryEnvelope({
    id,
    authorPubB64: AUTHOR,
    authorDid: 'did:key:zAuthor',
    mediaCid: null,
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

const read = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');

beforeEach(() => {
  mockContactsReadFails = false;
  mockCountFails = false;
  mockInsertFails = false;
  mockActiveCount = 0;
  mockContacts = [{ peerPublicKey: AUTHOR }];
  mockInserted.length = 0;
  mockMediaFetches = 0;
});

describe('занятая база откладывает кадр, а не съедает сторис', () => {
  it('список контактов не прочитался — отложено, и потом сторис приходит', async () => {
    mockContactsReadFails = true;
    const env = storyEnv('s1');
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('deferred');
    expect(mockInserted).toEqual([]);

    // База освободилась — тот же кадр, принесённый relay заново.
    mockContactsReadFails = false;
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('consumed');
    expect(mockInserted.map((s) => s.text)).toEqual(['сторис s1']);
  });

  it('счётчик не прочитался — отложено', async () => {
    mockCountFails = true;
    expect(await handleIncomingStory(storyEnv('s2'), AUTHOR, PID)).toBe('deferred');
    expect(mockInserted).toEqual([]);
  });

  it('строка не записалась — отложено', async () => {
    mockInsertFails = true;
    const env = storyEnv('s3');
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('deferred');
    expect(mockInserted).toEqual([]);

    mockInsertFails = false;
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toHaveLength(1);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отсрочка у сторис дороже, чем у настроек: второй разбор кадра — это ещё одна
 * загрузка вложения. Обработчик, который откладывает всё подряд, платил бы
 * трафиком за каждый отброшенный конверт, поэтому окончательные отказы обязаны
 * остаться окончательными.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: окончательное остаётся окончательным', () => {
  it('автор не в контактах — «разобрано», и второго захода не будет', async () => {
    mockContacts = [];
    expect(await handleIncomingStory(storyEnv('s4'), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });

  it('у автора упёрся потолок активных — «разобрано»', async () => {
    mockActiveCount = 30;
    expect(await handleIncomingStory(storyEnv('s5'), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });

  it('мусор вместо конверта — «разобрано»', async () => {
    expect(await handleIncomingStory('\x13story:{не json', AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });

  it('подставленный автор — «разобрано»: чужая сторис годной не станет', async () => {
    mockContactsReadFails = true;
    const someoneElse = 'B'.repeat(43);
    expect(await handleIncomingStory(storyEnv('s6'), someoneElse, PID)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });

  it('просроченный конверт — «разобрано»', async () => {
    const stale = storyEnv('s7', { expiresAt: Date.now() - 1000 });
    expect(await handleIncomingStory(stale, AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });

  it('удавшийся приём — «разобрано», повтор второй строки не заводит', async () => {
    const env = storyEnv('s8');
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('consumed');
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('consumed');
    // Имя строки собрано из ключа автора и номера конверта: повтор кадра
    // метит в ту же строку, а INSERT OR IGNORE в storage/local второй не
    // заводит.
    expect(new Set(mockInserted.map((s) => s.id)).size).toBe(1);
  });

  it('отказ до медиа — вложение не качается ни разу', async () => {
    mockContacts = [];
    await handleIncomingStory(storyEnv('s9', { mediaCid: 'bafy' + 'q'.repeat(40) }), AUTHOR, PID);
    expect(mockMediaFetches).toBe(0);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Слово обработчика решает не само по себе, а через того, кто его отдаёт
 * наружу. Ветка живёт в messaging.ts, который тянет транспорт и SQLite
 * целиком, поэтому здесь — форма.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ответ приёма сторис — ответ ветки', () => {
    const body = codeOnly(read('core/social/messaging.ts'));
    const at = body.indexOf('if (textPayload.text?.startsWith(STORY_PREFIX)) {');
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 400)).toContain(
      'return await handleIncomingStory(textPayload.text, peerPubKeyB64, ownerPid);'
    );
  });

  it('приём сторис отвечает словом, а не булевым', () => {
    const body = codeOnly(read('core/social/storyService.ts'));
    const at = body.indexOf('export async function handleIncomingStory(');
    expect(at).toBeGreaterThan(0);
    const head = body.slice(at, at + 260);
    expect(head).toContain('): Promise<EnvelopeIntake> {');
    expect(head).not.toContain('): Promise<boolean> {');
  });

  it('общая часть приёма тоже различает породы отказа', () => {
    const body = codeOnly(read('core/social/storyService.ts'));
    const at = body.indexOf('async function applyIncomingStory(');
    expect(at).toBeGreaterThan(0);
    const tail = body.slice(at);
    // Отказы базы названы отдельно от окончательных — по именам в журнале.
    expect(tail).toContain("log.warn('story_contacts_unreadable_defer'");
    expect(tail).toContain("log.warn('story_count_unreadable_defer'");
    expect(tail).toContain("log.warn('story_insert_failed_defer'");
    // Прежние немые «уронить и забыть» ушли вместе с ними.
    expect(tail).not.toContain('story_contacts_unreadable_drop');
    expect(tail).not.toContain('story_count_unreadable_drop');
  });
});
