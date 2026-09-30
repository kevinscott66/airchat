/**
 * Непрочитанная адресная книга больше не отвечает за человека (v4.32.1090).
 *
 * ДЕФЕКТ. Рассылка «кто видит моё время последнего входа» спрашивала книгу
 * сводящей формой — `listContactsFor`. Отказ базы эта обёртка гасит внутри
 * себя и отдаёт пустой список (см. readContactsFor в contacts.ts), поэтому
 * стоявший вокруг неё `catch` не срабатывал никогда, а «книгу не прочитали»
 * приходило сюда неотличимо от «контактов нет ни одного». Вариант
 * «Контакты» считается ровно по ней: `shouldShareLastSeenWith` на пустой
 * книге отвечает «не контакт» про каждого.
 *
 * ЦЕНА. Человек выбирает «Контакты», то есть открывает время входа близким.
 * Уходит обратное: каждому адресату — просьба спрятать. Отметку «был в сети»
 * ведёт получатель, сервера, который её поправит, нет. Хуже самой отправки
 * то, что она ложится в карту отправленного как доставленная: рассылка идёт
 * только по нажатию на настройку, а `syncLastSeenPrefTo` — при открытии
 * переписки, которая уже открыта. Второго захода нет, и само это не чинится.
 *
 * ПРАВКА. Книга читается различающей формой (`listContactsReadFor`). Там, где
 * ответ от неё зависит — вариант «Контакты», — при отказе не отправляется
 * ничего: выдуманное «нет» необратимо, а молчание догоняется повтором.
 * Рассылка называет исход словом `contacts_unreadable`, и экран настроек
 * просит выбрать вариант ещё раз.
 *
 * ГРАНИЦЫ. «Все» и «Никто» от книги не зависят — их рассылка идёт и при
 * отказе, по тем адресатам, кого видно. Сорванная карта отправленного — это
 * по-прежнему свой, более узкий исход.
 */
import fs from 'fs';
import path from 'path';

const mockPid = 2;
const CONTACT = 'контактВСписке==';
const EX = 'бывшийКонтакт==';
const SENT_DB_KEY = `p${mockPid}:presence:pref_sent`;

const mockKv = new Map<string, string>();
/** Ключи, чтение которых база не выполняет. */
const mockFailReads = new Set<string>();
let mockContacts: string[] = [];
/** Адресная книга не прочиталась. */
let mockBookFails = false;
let mockVisibility = 'nobody';
const mockSent: Array<{ peer: string; text: string }> = [];

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockFailReads.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSetChecked: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvGetSecretCellScoped: async (pid: number, k: string) => {
    const scoped = `p${pid}:${k}`;
    if (mockFailReads.has(scoped)) return { state: 'unreadable' };
    const own = mockKv.get(scoped);
    return own === undefined ? { state: 'absent' } : { state: 'plain', text: own };
  },
  kvSetSecret: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => { mockKv.delete(k); },
  kvListKeysByPrefix: async () => [],
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockPid }) },
}));
jest.mock('../contacts', () => ({
  // Сводящая форма — ровно такая, как настоящая: отказ отдаётся пустым
  // списком. Именно она и была дырой.
  listContactsFor: async () => (mockBookFails ? [] : mockContacts.map((p) => ({ peerPublicKey: p }))),
  listContactsReadFor: async () => (mockBookFails ? null : mockContacts.map((p) => ({ peerPublicKey: p }))),
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryGetFor: async () => ({ value: mockVisibility }),
}));
jest.mock('../presenceService', () => ({
  setPeerLastSeenAllowedFor: () => {},
  setMyLastSeenVisibility: () => {},
  effectiveMyLastSeenVisibility: () => 'nobody',
  presenceOwnerPid: () => mockPid,
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (peer: string, text: string) => { mockSent.push({ peer, text }); return 'cid-1090'; },
  }),
}));
jest.mock('../sendGate', () => ({ canReachPeer: async () => true }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { broadcastLastSeenPref, syncLastSeenPrefTo } from '../presencePrefSync';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const readSrc = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SETTINGS = (): string => readSrc('src/ui/screens/SettingsScreen.tsx');
const CONTACTS_SRC = (): string => readSrc('src/core/social/contacts.ts');

/** Только код: пояснение не должно само удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');

/** Что сказали этому собеседнику в последний раз; undefined — ничего. */
function saidTo(peer: string): boolean | undefined {
  const hit = [...mockSent].reverse().find((m) => m.peer === peer);
  if (!hit) return undefined;
  return JSON.parse(hit.text.slice(hit.text.indexOf('{'))).show as boolean;
}

beforeEach(() => {
  mockKv.clear();
  mockFailReads.clear();
  mockSent.length = 0;
  mockContacts = [CONTACT];
  mockBookFails = false;
  mockVisibility = 'contacts';
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('на живой книге рассылка и правда доходит', async () => {
    expect(await broadcastLastSeenPref()).toBe('ok');
    expect(saidTo(CONTACT)).toBe(true);
    expect(mockSent.length).toBe(1);
  });

  it('карта отправленного читается и пополняется', async () => {
    await broadcastLastSeenPref();
    expect(JSON.parse(mockKv.get(SENT_DB_KEY) as string)).toEqual({ [CONTACT]: true });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('сводящая обёртка по-прежнему выдаёт отказ за пустую книгу', () => {
    // Мок выше повторяет её поведение не на слово: так она и написана.
    const body = codeOnly(CONTACTS_SRC());
    expect(body).toContain('export async function listContactsFor(ownerProfileId: number): Promise<Contact[]> {');
    expect(body).toMatch(/listContactsFor[\s\S]{0,120}\?\?\s*\[\];/);
  });

  it('ответ для «Контакты» и правда считается по книге', async () => {
    mockVisibility = 'contacts';
    await broadcastLastSeenPref();
    expect(saidTo(CONTACT)).toBe(true);

    mockSent.length = 0;
    mockKv.clear();
    mockContacts = [];
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    await broadcastLastSeenPref();
    // Тот же вариант настройки, другая книга — обратный ответ. Значит
    // подменять книгу пустотой нельзя.
    expect(saidTo(EX)).toBe(false);
  });
});

describe('непрочитанная книга не выдаётся за пустую', () => {
  it('«Контакты»: отказ книги — не повод сказать «спрячь»', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [CONTACT]: true }));
    mockBookFails = true;
    expect(await broadcastLastSeenPref()).toBe('contacts_unreadable');
    expect(saidTo(CONTACT)).toBeUndefined();
    expect(mockSent.length).toBe(0);
  });

  it('выдумка не попадает в карту отправленного', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [CONTACT]: true }));
    mockBookFails = true;
    await broadcastLastSeenPref();
    expect(JSON.parse(mockKv.get(SENT_DB_KEY) as string)).toEqual({ [CONTACT]: true });
  });

  it('повторить и правда есть чем: живая книга догоняет', async () => {
    // Карта не пуста нарочно: без неё адресатов при отказе нет вовсе, и
    // молчание вышло бы само собой. Здесь адресат есть, и молчание — решение.
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [CONTACT]: false }));
    mockBookFails = true;
    await broadcastLastSeenPref();
    expect(mockSent.length).toBe(0);

    mockBookFails = false;
    expect(await broadcastLastSeenPref()).toBe('ok');
    expect(saidTo(CONTACT)).toBe(true);
  });

  it('«Никто» от книги не зависит — отзыв уходит и при отказе', async () => {
    mockVisibility = 'nobody';
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    mockBookFails = true;
    // Молчать здесь было бы своей бедой: просьба спрятать время входа — та,
    // ради которой настройку и трогают.
    expect(await broadcastLastSeenPref()).toBe('contacts_unreadable');
    expect(saidTo(EX)).toBe(false);
  });

  it('«Все» от книги не зависит тоже', async () => {
    mockVisibility = 'everybody';
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: false }));
    mockBookFails = true;
    expect(await broadcastLastSeenPref()).toBe('contacts_unreadable');
    expect(saidTo(EX)).toBe(true);
  });
});

describe('досылка при открытии переписки — по тому же правилу', () => {
  it('«Контакты» и отказ книги: не говорим ничего', async () => {
    mockBookFails = true;
    await syncLastSeenPrefTo(CONTACT);
    expect(mockSent.length).toBe(0);
    expect(mockKv.get(SENT_DB_KEY)).toBeUndefined();
  });

  it('«Никто» и отказ книги: просьба спрятать всё равно уходит', async () => {
    mockVisibility = 'nobody';
    mockBookFails = true;
    await syncLastSeenPrefTo(EX);
    expect(saidTo(EX)).toBe(false);
  });

  it('живая книга: отправленное раньше «спрячь» отзывается', async () => {
    // Просто «показывай» на пустом месте не шлётся — это состояние по
    // умолчанию у любого клиента. Отзыв прежней просьбы — шлётся, и это
    // ровно тот путь, которым чинится ошибочно отправленное «спрячь».
    mockVisibility = 'contacts';
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [CONTACT]: false }));
    await syncLastSeenPrefTo(CONTACT);
    expect(saidTo(CONTACT)).toBe(true);
  });
});

describe('экран настроек называет этот исход отдельно', () => {
  it('у него своё сообщение, не общее с сорванной картой', () => {
    const body = codeOnly(SETTINGS());
    expect(body).toContain("if (res === 'contacts_unreadable') showError(LAST_SEEN_BOOK_UNREADABLE);");
    expect(body).toContain("if (res === 'sent_map_unreadable') showError(LAST_SEEN_PARTIAL);");
  });

  it('текст не отрицает сохранения и просит повторить', () => {
    const m = SETTINGS().match(/const LAST_SEEN_BOOK_UNREADABLE =\s*\n?\s*'([^']+)'/);
    expect(m).not.toBeNull();
    const msg = (m as RegExpMatchArray)[1];
    expect(msg).toContain('сохранён');
    expect(msg).toMatch(/ещё раз|повтор/i);
    expect(msg).not.toMatch(/не удалось сохранить|не сохран/i);
  });
});

describe('ГРАНИЦА', () => {
  it('всё прочиталось — жаловаться не на что', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    expect(await broadcastLastSeenPref()).toBe('ok');
  });

  it('сорванная карта остаётся своим, более узким исходом', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    mockFailReads.add(SENT_DB_KEY);
    expect(await broadcastLastSeenPref()).toBe('sent_map_unreadable');
  });

  it('обе беды сразу — говорим о большей', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    mockFailReads.add(SENT_DB_KEY);
    mockBookFails = true;
    expect(await broadcastLastSeenPref()).toBe('contacts_unreadable');
  });

  it('мёртвого catch вокруг чтения книги в рассылке больше нет', () => {
    const body = codeOnly(readSrc('src/core/social/presencePrefSync.ts'));
    expect(body).not.toContain("log.warn('presence_pref_contacts_failed'");
  });
});
