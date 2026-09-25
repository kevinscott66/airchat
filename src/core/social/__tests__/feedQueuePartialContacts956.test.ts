/**
 * Очередь публикации: короткий справочник контактов — не полный (v4.32.956).
 *
 * ДЕФЕКТ. Повтор рассылки заканчивается подсчётом: сколько контактов ещё не
 * получили запись. Круг адресатов брался через `listContactsReadFor(ownerPid)`,
 * а это `(await readContactsFor(pid))?.contacts ?? null` — поле `missing`
 * выбрасывается по дороге. Строку контакта, которую не удалось расшифровать
 * этим проходом, `readContactsFor` молча пропускает и идёт дальше, считая её в
 * `missing`. Наружу уходит КОРОТКИЙ список, от полного неотличимый.
 *
 * Проверка на null, стоящая тут с v4.32.724, ловит только отказ самого
 * указателя `contacts_index`, а не отказ по отдельным строкам.
 *
 * ЦЕНА. Пять контактов, конверт ушёл всем пятерым за прошлые проходы, но одна
 * строка справочника в этот раз не открылась (заблокированный после
 * перезагрузки Keychain, занятый момент базы). Тогда `allContactDids.size`
 * равен четырём, все четверо уже в `deliveredTo`, `remaining` сходится в ноль —
 * и запись уходит из очереди, не дойдя до пятого никогда: ни по таймеру
 * повтора, ни по обнаружению в сети, ни через две недели.
 *
 * Крайний случай хуже: заблокированный Keychain — причина общая для всех строк,
 * и не открывается ни одна. Тогда `contacts` равен `[]`, а не null, и ветка
 * «контактов нет → пост локальный, доставлять нечего» объявляет доставленным
 * пост, не ушедший вообще никому.
 *
 * ПРАВКА. Подсчёт переведён на подробное чтение — тот самый отдельный вход,
 * ради которого `ContactsRead` и заведён (v4.32.846) и которым уже пользуются
 * рассылка ленты (`feedTransport`) и сторис. Неполный справочник — это
 * слепота, а не «контактов стало меньше»: запись остаётся в очереди и тратит
 * попытку.
 *
 * ГРАНИЦЫ. Вечно висеть она от этого не станет: потолок повторов
 * (`MAX_QUEUE_RETRIES`) и четырнадцатидневный срок очереди снимут её сами, а
 * вот потеря необратима. Пересылка чужого (`feedGossipRelay`) по-прежнему
 * берёт голый `listContacts()` — там список нужен как граф связей сетевой
 * сессии, а не как круг адресатов записи.
 */
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubSubscribe: jest.fn(),
  pubsubPublish: jest.fn(),
}));
jest.mock('../../transport/multiTransport', () => ({
  multiTransportRouter: { send: jest.fn(async () => undefined) },
}));
jest.mock('../mutedAuthors', () => ({ isAuthorMuted: jest.fn(async () => false) }));

/** Контакты владельца записи; ключ — номер профиля. */
const mockContactsByPid = new Map<number, Array<{ peerPublicKey: string }>>();
/** Сколько строк справочника не открылось этим проходом; ключ — номер профиля. */
const mockMissingByPid = new Map<number, number>();

jest.mock('../contacts', () => ({
  listContactsFor: async (pid: number) => mockContactsByPid.get(pid) ?? [],
  // Сплющивающие входы оставлены в точности такими, какие они есть на самом
  // деле: `listContactsReadFor` отдаёт null только при отказе указателя и
  // ВЫБРАСЫВАЕТ число непрочитанных строк. Без этого прогон ДО правки шёл бы
  // не по настоящему коду.
  listContactsReadFor: async (pid: number) => mockContactsByPid.get(pid) ?? null,
  listContacts: async () => mockContactsByPid.get(mockActivePid) ?? [],
  listContactsRead: async () => mockContactsByPid.get(mockActivePid) ?? null,
  listContactsReadDetailed: async (pid?: number) => {
    const key = pid ?? mockActivePid;
    const list = mockContactsByPid.get(key);
    if (list === undefined) return null;
    return { contacts: list, missing: mockMissingByPid.get(key) ?? 0 };
  },
}));

/** Профиль, открытый на экране. */
let mockActivePid = 1;
let mockActiveDid = 'did:key:посторонний';
let mockAllProfiles: Array<{ id: number; did: string }> = [];

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: mockActivePid, did: mockActiveDid }),
    getAllProfiles: () => mockAllProfiles,
    getProfileIdsComplete: () => ({ ids: mockAllProfiles.map((p) => p.id), complete: true }),
  },
}));

type Row = { id: string; authorDid: string; text: string; timestamp: number };
const mockPosts = new Map<string, Row>();

jest.mock('../../storage/feedStorage', () => ({
  deleteFeedDbForProfile: jest.fn(async () => undefined),
  FeedStorage: class {
    async init(): Promise<void> { /* база в тесте не нужна */ }
    async getPost(id: string): Promise<unknown> { return mockPosts.get(id) ?? null; }
    async deletePost(id: string): Promise<void> { mockPosts.delete(id); }
  },
}));

const mockKv = new Map<string, string>();
const mockQueueKey = 'feed_publish_queue_v2';

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv.get(k) ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvDelete: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteChecked: jest.fn(async (k: string) => { mockKv.delete(k); }),
  kvDeleteByPrefix: jest.fn(async () => undefined),
  kvGetSecretCell: jest.fn(async (k: string) => {
    const raw = mockKv.get(k);
    return raw === undefined ? { state: 'absent' } : { state: 'plain', text: raw };
  }),
  kvSetSecret: jest.fn(async (k: string, v: string) => { mockKv.set(k, v); return true; }),
  kvGetInlineAttachment: jest.fn(async () => null),
  kvTryGetInlineAttachment: jest.fn(async () => ({ value: null })),
  kvSetInlineAttachment: jest.fn(async () => true),
  kvTryListKeysByPrefix: jest.fn(async () => []),
  setPollVote: jest.fn(async () => undefined),
  deletePollVote: jest.fn(async () => undefined),
  parsePollText: jest.fn(() => null),
  POLL_PREFIX: '[[poll]]',
}));

jest.mock('../publicPost', () => ({
  publicPostStoreAvailable: () => false,
  isPublicPostId: () => false,
  publicPostCopyExists: jest.fn(async () => false),
  putPublicPostCopy: jest.fn(async () => true),
  getPublicPostFrame: jest.fn(async () => null),
  deletePublicPostCopy: jest.fn(async () => true),
}));

import * as fs from 'fs';
import * as path from 'path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { publicKeyToDidKey } from '../../identity/did';
import { flushFeedPublishQueue, setFeedProfileContext } from '../feedService';

const keys = ed25519.keygen();
const pair = { secretKey: keys.secretKey, publicKey: keys.publicKey };
const myDid = publicKeyToDidKey(keys.publicKey);

/** Пятеро контактов владельца: четверо прочитаны, пятый — как повезёт. */
const peers = Array.from({ length: 5 }, () => ed25519.keygen());
const PUBS = peers.map((k) => Buffer.from(k.publicKey).toString('base64'));
const DIDS = peers.map((k) => publicKeyToDidKey(k.publicKey));

/** Номер профиля, которому принадлежит наш ключ. */
const OWNER = 2;
/** Номер профиля, открытого на экране. */
const OTHER = 1;

type Queued = {
  id: string; postId: string; text: string; authorName: string;
  retries: number; createdAt: number; authorDid: string; deliveredTo?: string[];
};

function seedQueue(deliveredTo?: string[]): void {
  const now = Date.now();
  const item: Queued = {
    id: 'p1', postId: 'p1', text: 'текст p1', authorName: 'Я',
    retries: 0, createdAt: now, authorDid: myDid,
    ...(deliveredTo ? { deliveredTo } : {}),
  };
  mockKv.set(mockQueueKey, JSON.stringify([item]));
  mockPosts.set('p1', { id: 'p1', authorDid: myDid, text: 'текст p1', timestamp: now });
}

function storedQueue(): Queued[] | null {
  const raw = mockKv.get(mockQueueKey);
  return raw === undefined ? null : (JSON.parse(raw) as Queued[]);
}

/** Справочник владельца: сколько строк открылось и сколько нет. */
function ownerContacts(readable: number, missing: number): void {
  mockContactsByPid.set(OWNER, PUBS.slice(0, readable).map((peerPublicKey) => ({ peerPublicKey })));
  mockMissingByPid.set(OWNER, missing);
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
const CONTACTS = fs.readFileSync(path.join(__dirname, '..', 'contacts.ts'), 'utf8');

beforeAll(async () => {
  jest.useFakeTimers();
  mockAllProfiles = [{ id: OTHER, did: 'did:key:посторонний' }, { id: OWNER, did: myDid }];
  await setFeedProfileContext(OWNER);
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  mockKv.clear();
  mockPosts.clear();
  mockContactsByPid.clear();
  mockMissingByPid.clear();
  mockContactsByPid.set(OTHER, []);
  mockActivePid = OTHER;
  mockActiveDid = 'did:key:посторонний';
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: с полным справочником всё идёт как прежде', () => {
  test('все контакты получили запись — её снимают с очереди', async () => {
    ownerContacts(5, 0);
    seedQueue(DIDS);
    await flushFeedPublishQueue(pair);
    expect(storedQueue()).toEqual([]);
  });

  test('кто-то ещё не получил — запись остаётся и тратит попытку', async () => {
    ownerContacts(5, 0);
    seedQueue(DIDS.slice(0, 4));
    await flushFeedPublishQueue(pair);
    expect((storedQueue() ?? []).map((i) => i.id)).toEqual(['p1']);
    expect((storedQueue() ?? [])[0]?.retries).toBe(1);
  });
});

describe('короткий справочник не выдаётся за полный', () => {
  test('одна строка не открылась — запись не объявляют доставленной всем', async () => {
    // Прочитаны четверо, и все четверо уже получили. Пятый — в контактах, но
    // его строка этим проходом не расшифровалась.
    ownerContacts(4, 1);
    seedQueue(DIDS.slice(0, 4));
    await flushFeedPublishQueue(pair);
    expect((storedQueue() ?? []).map((i) => i.id)).toEqual(['p1']);
  });

  test('попытка при этом тратится — очередь не крутится вхолостую', async () => {
    ownerContacts(4, 1);
    seedQueue(DIDS.slice(0, 4));
    await flushFeedPublishQueue(pair);
    expect((storedQueue() ?? [])[0]?.retries).toBe(1);
  });

  test('не открылась ни одна строка — это не «контактов нет вовсе»', async () => {
    // Заблокированный Keychain — причина общая для всех строк сразу. Указатель
    // при этом прочитан, поэтому подробное чтение отдаёт пустой список с
    // ненулевым missing, а не null.
    ownerContacts(0, 5);
    seedQueue();
    await flushFeedPublishQueue(pair);
    expect((storedQueue() ?? []).map((i) => i.id)).toEqual(['p1']);
    expect((storedQueue() ?? [])[0]?.retries).toBe(1);
  });

  test('не открылось больше половины — остаток сходится в ноль по ошибке', async () => {
    // Прочитаны двое, оба уже получили; трое остались за непрочитанными
    // строками. Именно тут короткий справочник и выглядит полным.
    ownerContacts(2, 3);
    seedQueue(DIDS.slice(0, 2));
    await flushFeedPublishQueue(pair);
    expect((storedQueue() ?? []).map((i) => i.id)).toEqual(['p1']);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прежние исходы не подменены осторожностью', () => {
  test('контактов нет вовсе — запись местная, её по-прежнему снимают', async () => {
    ownerContacts(0, 0);
    seedQueue();
    await flushFeedPublishQueue(pair);
    expect(storedQueue()).toEqual([]);
  });

  test('указатель не прочитался — запись остаётся (v4.32.724 цела)', async () => {
    mockContactsByPid.delete(OWNER);
    seedQueue();
    await flushFeedPublishQueue(pair);
    expect((storedQueue() ?? []).map((i) => i.id)).toEqual(['p1']);
  });

  test('сплющивающий вход по-прежнему теряет число непрочитанных строк', () => {
    // Если он однажды начнёт его отдавать, эта правка станет лишней — и тест
    // должен об этом сказать, а не молча продолжать сторожить.
    expect(CONTACTS).toContain(
      'export async function listContactsReadFor(ownerProfileId: number): Promise<Contact[] | null> {',
    );
    expect(CONTACTS).toContain('return (await readContactsFor(ownerProfileId))?.contacts ?? null;');
    expect(CONTACTS).toContain("if (cell.state === 'unreadable') {");
  });
});

describe('вторая половина правки: чем подсчёт читает справочник', () => {
  test('подсчёт зовёт подробное чтение у владельца записи', () => {
    const owner = SRC.indexOf('const ownerPid = ownerPidForPublicKey(pair.publicKey);');
    const read = SRC.indexOf('const contactsRead = await listContactsReadDetailed(ownerPid);');
    expect(owner).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(owner);
    expect(SRC).toContain("import { listContacts, listContactsReadDetailed } from './contacts';");
  });

  test('неполный справочник разобран отдельной веткой и объяснён в логе', () => {
    expect(SRC).toContain('if (contactsRead.missing > 0) {');
    expect(SRC).toContain("log.warn('feed_queue_contacts_partial_kept'");
    expect(SRC).toMatch(
      /if \(contactsRead\.missing > 0\) \{[\s\S]{0,700}?\n\s*return \{ fullyDelivered: false \};/,
    );
  });

  test('отказ указателя остался отдельным исходом', () => {
    expect(SRC).toContain('if (contactsRead === null) {');
    expect(SRC).toContain("log.warn('feed_queue_contacts_unreadable_kept'");
  });
});
