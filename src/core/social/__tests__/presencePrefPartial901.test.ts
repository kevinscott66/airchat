/**
 * Неполная рассылка «кто видит моё время входа» больше не молчит (v4.32.901).
 *
 * Дефект. `broadcastLastSeenPref` берёт адресатов из двух списков: нынешние
 * контакты и карта «кому уже сказано». Второй список — единственный способ
 * найти человека, которого удалили из адресной книги ПОСЛЕ того, как ему
 * сказали «показывай моё время». Карта читается трёхзначно (`null` —
 * прочитать не вышло, v4.32.693), но здесь `null` сводился к пустой карте
 * одним `?? {}`: для дедупликации это безвредно, а как список адресатов —
 * это молча вычеркнутые бывшие контакты.
 *
 * Цена. Переключатель встаёт в «Никто», ошибки нет, и человек уверен, что
 * закрылся ото всех. Отметку «был в сети» ведёт получатель — сервера, который
 * её спрячет, не существует, — поэтому бывший контакт видит время входа
 * дальше, без срока. Второго захода нет: рассылка идёт только по нажатию на
 * настройку, а `syncLastSeenPrefTo` срабатывает при открытии переписки,
 * которой с удалённым контактом уже не открыть.
 *
 * Правка. Рассылка отвечает словом: `ok` либо `sent_map_unreadable`. На втором
 * экран настроек говорит, что выбор сохранён, но дошёл не до всех, и просит
 * повторить. Просьба честная: `recordSent` отказывается писать поверх
 * непрочитанной карты, поэтому на диске она цела и повтор догонит остальных.
 */
import fs from 'fs';
import path from 'path';

const mockPid = 2;
const CONTACT = 'контактВСписке==';
const EX = 'бывшийКонтакт==';
const SENT_DB_KEY = `p${mockPid}:presence:pref_sent`;

const mockKv = new Map<string, string>();
/** Ключи, чтение которых база не выполняет (kvTryGet отвечает null). */
const mockFailReads = new Set<string>();
let mockContacts: string[] = [];
let mockVisibility: string | null = 'nobody';
const mockSent: Array<{ peer: string; text: string }> = [];

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockFailReads.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSetChecked: async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvDeleteChecked: async (k: string) => {
    mockKv.delete(k);
  },
  kvListKeysByPrefix: async () => [],
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockPid }) },
}));
jest.mock('../contacts', () => ({
  listContactsFor: async () => mockContacts.map((p) => ({ peerPublicKey: p })),
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryGetFor: async () => (mockVisibility === null ? null : { value: mockVisibility }),
}));
jest.mock('../presenceService', () => ({
  setPeerLastSeenAllowedFor: () => {},
  setMyLastSeenVisibility: () => {},
  effectiveMyLastSeenVisibility: () => 'nobody',
  presenceOwnerPid: () => mockPid,
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (peer: string, text: string) => {
      mockSent.push({ peer, text });
      return 'cid-901';
    },
  }),
}));
jest.mock('../sendGate', () => ({ canReachPeer: async () => true }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { broadcastLastSeenPref, syncLastSeenPrefTo } from '../presencePrefSync';

const SETTINGS = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'SettingsScreen.tsx');
const settingsSrc = (): string => fs.readFileSync(SETTINGS, 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const settingsCode = (): string =>
  settingsSrc()
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

/** Кому и что сказали в последней рассылке. */
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
  mockVisibility = 'nobody';
});

describe('рассылка признаётся, что дошла не до всех', () => {
  it('отказ чтения карты назван словом', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    mockFailReads.add(SENT_DB_KEY);
    expect(await broadcastLastSeenPref()).toBe('sent_map_unreadable');
  });

  it('при живой базе рассылка не жалуется', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    expect(await broadcastLastSeenPref()).toBe('ok');
    expect(saidTo(EX)).toBe(false);
  });

  it('пустая карта — это не отказ', async () => {
    // Карты ещё нет: сказать бывшим контактам нечего, и жаловаться не на что.
    expect(await broadcastLastSeenPref()).toBe('ok');
    expect(saidTo(CONTACT)).toBe(false);
  });
});

describe('экран настроек не молчит об этом исходе', () => {
  it('сообщение показывают именно на нём', () => {
    const body = settingsCode();
    expect(body).toContain("if (res === 'sent_map_unreadable') showError(LAST_SEEN_PARTIAL);");
    expect(body).not.toContain('.then((ok) => { if (ok) return broadcastLastSeenPref(); });');
  });

  it('текст не отрицает сохранения и просит повторить', () => {
    const m = settingsSrc().match(/const LAST_SEEN_PARTIAL =\s*\n?\s*'([^']+)'/);
    expect(m).not.toBeNull();
    const msg = (m as RegExpMatchArray)[1];
    expect(msg).toContain('сохранён');
    expect(msg).toMatch(/ещё раз|повтор/i);
    // Ни слова о том, что выбор не применился: он применился и разослан
    // нынешним контактам — переделывать нечего, надо повторить.
    expect(msg).not.toMatch(/не удалось сохранить|не сохран/i);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('при отказе чтения бывший контакт и правда остаётся без отзыва', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    mockFailReads.add(SENT_DB_KEY);
    await broadcastLastSeenPref();
    expect(saidTo(CONTACT)).toBe(false);
    expect(saidTo(EX)).toBeUndefined();
  });

  it('повторить и правда есть чем: карта на диске цела', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    mockFailReads.add(SENT_DB_KEY);
    await broadcastLastSeenPref();
    expect(JSON.parse(mockKv.get(SENT_DB_KEY) as string)).toEqual({ [EX]: true });

    // Само слово исхода проверено выше; здесь важно только, что повтор
    // действительно находит бывшего контакта.
    mockFailReads.clear();
    mockSent.length = 0;
    await broadcastLastSeenPref();
    expect(saidTo(EX)).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('одиночная досылка при нечитаемой карте ошибается в строгую сторону', async () => {
    // Здесь пустая карта безвредна: «не показывай» уйдёт лишний раз, а вот
    // «показывай» на пустом месте не отправляется — это и есть строгая
    // сторона. Поэтому правка нужна была именно рассылке.
    mockFailReads.add(SENT_DB_KEY);
    await syncLastSeenPrefTo(EX);
    expect(saidTo(EX)).toBe(false);

    mockSent.length = 0;
    mockVisibility = 'everybody';
    await syncLastSeenPrefTo(EX);
    expect(saidTo(EX)).toBeUndefined();
  });

  it('экран настроек по-прежнему сначала сохраняет, и только потом рассылает', () => {
    const body = settingsCode();
    const apply = body.indexOf("privacyPrefSet('privacy_last_seen_visibility', val)");
    expect(apply).toBeGreaterThan(0);
    const call = body.indexOf('broadcastLastSeenPref()', apply);
    expect(call).toBeGreaterThan(apply);
    expect(body.split('showError(').length - 1).toBeGreaterThan(20);
  });
});
