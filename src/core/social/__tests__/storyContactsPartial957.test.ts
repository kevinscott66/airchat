/**
 * Короткий справочник контактов не делает автора сторис незнакомцем (v4.32.957).
 *
 * ДЕФЕКТ. Разделение исходов в `applyIncomingStory` было сделано на `catch`:
 * `try { const contacts = await listContactsFor(pid); … } catch { return
 * 'deferred'; }`. Но `listContactsFor` при отказе чтения не бросает НИКОГДА —
 * это `(await listContactsReadFor(pid)) ?? []`, а `readContactsFor` гасит любое
 * исключение своим `catch` и возвращает null. То есть отказ базы приходил сюда
 * пустым массивом, `catch` был мёртв, и выполнялась ветка «автора нет в
 * контактах» → 'consumed'.
 *
 * ЦЕНА. Кадр объявлялся разобранным, метка «докуда прочитано» у ретранслятора
 * уезжала вперёд — и второй раз этот конверт не придёт. Сторис контакта
 * пропадала молча и безвозвратно: живёт она сутки, повторов у неё нет, у автора
 * она при этом опубликована. Ровно та потеря, против которой написан докблок
 * `applyIncomingStory` (v4.32.760) — только приходящая с другой стороны: там
 * отказ считали броском, а он приходит значением.
 *
 * Тот же исход давал ЧАСТИЧНЫЙ отказ: справочник прочитан, но строка именно
 * этого контакта не расшифровалась этим проходом (заблокированный после
 * перезагрузки Keychain, занятый момент базы). Автор объявлялся незнакомцем по
 * неполному списку.
 *
 * ПРАВКА. Спрашивается подробное чтение — тот самый отдельный вход, ради
 * которого заведён `ContactsRead` (v4.32.846) и который в этом же файле уже
 * используется двадцатью строками выше, в `publishStory`. null — не открылся
 * указатель, `missing` — сколько строк не открылось. Незнакомцем автор
 * объявляется только по ПОЛНОМУ справочнику.
 *
 * ГРАНИЦЫ. Лента сторис от этого не открывается: пока справочник неполон,
 * ничего не пишется — кадр откладывается. Отсрочка у сторис дороже, чем у
 * настроек (второй разбор — это ещё одна загрузка вложения), поэтому
 * окончательные отказы обязаны остаться окончательными, и это проверяется
 * отдельно.
 */

/** Кто в контактах — из тех строк, что открылись. */
let mockContacts: { peerPublicKey: string }[] = [];
/** Сколько строк справочника не открылось этим проходом. */
let mockMissing = 0;
/** true — не открылся сам указатель contacts_index. */
let mockIndexFails = false;
/** Что записано — по порядку. */
const mockInserted: { id: string; text: string | null }[] = [];
/** Сколько раз качали вложение: отсрочка стоит повторной загрузки. */
let mockMediaFetches = 0;

let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `story${++mockUuid}` }));

jest.mock('../contacts', () => ({
  // Сплющивающие входы — в точности такие, какие они есть на самом деле:
  // отказ приходит значением, а не броском, и `listContactsFor` сводит его
  // с «контактов нет» в один пустой массив. Без этого прогон ДО правки шёл бы
  // не по настоящему коду.
  listContactsFor: async () => (mockIndexFails ? [] : mockContacts),
  listContactsReadFor: async () => (mockIndexFails ? null : mockContacts),
  listContactsReadDetailed: async () =>
    mockIndexFails ? null : { contacts: mockContacts, missing: mockMissing },
}));

jest.mock('../../storage/local', () => ({
  insertStory: async (row: { id: string; text: string | null }) => {
    mockInserted.push({ id: row.id, text: row.text });
  },
  deleteExpiredStories: async () => undefined,
  countActiveStoriesByAuthor: async () => 0,
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
const OTHER = 'B'.repeat(43);
const PID = 3;

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
  mockContacts = [{ peerPublicKey: AUTHOR }];
  mockMissing = 0;
  mockIndexFails = false;
  mockInserted.length = 0;
  mockMediaFetches = 0;
});

describe('неполный справочник не съедает сторис', () => {
  it('строка автора не открылась — кадр откладывается, а не разбирается', async () => {
    mockContacts = [{ peerPublicKey: OTHER }];
    mockMissing = 1;
    expect(await handleIncomingStory(storyEnv('s1'), AUTHOR, PID)).toBe('deferred');
    expect(mockInserted).toEqual([]);
  });

  it('база освободилась — та же сторис доходит вторым заходом', async () => {
    mockContacts = [{ peerPublicKey: OTHER }];
    mockMissing = 1;
    const env = storyEnv('s2');
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('deferred');

    mockContacts = [{ peerPublicKey: OTHER }, { peerPublicKey: AUTHOR }];
    mockMissing = 0;
    expect(await handleIncomingStory(env, AUTHOR, PID)).toBe('consumed');
    expect(mockInserted.map((s) => s.text)).toEqual(['сторис s2']);
  });

  it('не открылась ни одна строка — это не «автор незнакомец»', async () => {
    // Заблокированный Keychain — причина общая для всех строк сразу. Указатель
    // при этом прочитан, поэтому подробное чтение отдаёт пустой список с
    // ненулевым missing, а не null.
    mockContacts = [];
    mockMissing = 4;
    expect(await handleIncomingStory(storyEnv('s3'), AUTHOR, PID)).toBe('deferred');
    expect(mockInserted).toEqual([]);
  });

  it('указатель не прочитался — тоже отсрочка (v4.32.760 цела)', async () => {
    mockIndexFails = true;
    expect(await handleIncomingStory(storyEnv('s4'), AUTHOR, PID)).toBe('deferred');
    expect(mockInserted).toEqual([]);
  });

  it('неполный справочник ленту не открывает: ничего не пишется', async () => {
    mockContacts = [];
    mockMissing = 2;
    await handleIncomingStory(storyEnv('s5'), AUTHOR, PID);
    expect(mockInserted).toEqual([]);
  });

  it('отсрочка наступает ДО медиа — вложение не качается ни разу', async () => {
    mockContacts = [];
    mockMissing = 2;
    await handleIncomingStory(storyEnv('s6', { mediaCid: 'bafy' + 'q'.repeat(40) }), AUTHOR, PID);
    expect(mockMediaFetches).toBe(0);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: окончательное остаётся окончательным', () => {
  it('справочник полон, автора в нём нет — «разобрано»', async () => {
    mockContacts = [{ peerPublicKey: OTHER }];
    mockMissing = 0;
    expect(await handleIncomingStory(storyEnv('s7'), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });

  it('контактов нет вовсе и справочник полон — «разобрано»', async () => {
    mockContacts = [];
    mockMissing = 0;
    expect(await handleIncomingStory(storyEnv('s8'), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });

  it('автор на месте при неполном справочнике — сторис принимается', async () => {
    // `missing` сам по себе кадр не откладывает: если автор НАЙДЕН среди
    // открывшихся строк, он контакт, и непрочитанные строки к делу не идут.
    mockContacts = [{ peerPublicKey: AUTHOR }];
    mockMissing = 3;
    expect(await handleIncomingStory(storyEnv('s9'), AUTHOR, PID)).toBe('consumed');
    expect(mockInserted.map((s) => s.text)).toEqual(['сторис s9']);
  });

  it('подставленный автор — «разобрано»: чужая сторис годной не станет', async () => {
    mockMissing = 1;
    expect(await handleIncomingStory(storyEnv('s10'), OTHER, PID)).toBe('consumed');
    expect(mockInserted).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const STORY = read('core/social/storyService.ts');
  const CONTACTS = read('core/social/contacts.ts');

  it('сплющивающий вход по-прежнему гасит отказ чтения в пустой список', () => {
    // Если он однажды начнёт бросать или отдавать null, эта правка станет
    // лишней — и тест обязан об этом сказать, а не молча сторожить дальше.
    expect(CONTACTS).toContain('return (await listContactsReadFor(ownerProfileId)) ?? [];');
    expect(CONTACTS).toContain('return (await readContactsFor(ownerProfileId))?.contacts ?? null;');
  });

  it('readContactsFor гасит исключение внутри себя', () => {
    const at = CONTACTS.indexOf('async function readContactsFor(');
    expect(at).toBeGreaterThan(-1);
    const tail = CONTACTS.slice(at, CONTACTS.indexOf('\n}', at));
    expect(tail).toContain('} catch (e) {');
    expect(tail).toContain('return null;');
  });

  it('приём сторис спрашивает подробное чтение, а не сплющивающее', () => {
    const body = codeOnly(STORY);
    const at = body.indexOf('async function applyIncomingStory(');
    expect(at).toBeGreaterThan(0);
    const tail = body.slice(at);
    expect(tail).toContain('contactsRead = await listContactsReadDetailed(pid);');
    expect(tail).not.toContain('await listContactsFor(pid)');
    expect(tail).toContain('if (contactsRead === null) {');
    expect(tail).toContain('if (contactsRead.missing > 0) {');
  });

  it('неполный справочник назван в журнале отдельно от окончательного отказа', () => {
    const body = codeOnly(STORY);
    const at = body.indexOf('async function applyIncomingStory(');
    const tail = body.slice(at);
    expect(tail).toContain("log.warn('story_contacts_partial_defer'");
    expect(tail).toContain("log.debug('story_author_not_in_contacts_drop'");
    expect(tail).toContain("log.warn('story_contacts_unreadable_defer'");
  });
});
