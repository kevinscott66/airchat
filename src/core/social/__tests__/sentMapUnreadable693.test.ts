/**
 * Карта «кому уже сказано» не переписывается вслепую (v4.32.693).
 *
 * `loadSent` читал карту простым чтением, и отказ базы приходил тем же пустым
 * ответом, что и нетронутая запись. `recordSent` домешивал к этой пустоте свою
 * правку и записывал результат ПОВЕРХ настоящей карты: всё, кроме последней
 * правки, исчезало навсегда.
 *
 * Для рассылки решения о времени последнего входа это не мелочь. Адресаты
 * там — контакты И все, кому решение уже отправлялось, и второй список нужен
 * ровно затем, чтобы отзыв дошёл до человека, которого удалили из адресной
 * книги ПОСЛЕ того, как ему сказали «показывай». Потеряв карту, приложение
 * теряет единственный способ его найти: он продолжает видеть время входа, а
 * владелец уверен, что закрыл его всем.
 *
 * Правило после правки: не прочитали — не пишем. Цена — лишняя отправка на
 * следующем заходе, и она несравнимо дешевле недоставленного отзыва.
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
    // v4.32.715: пустой ответ — отказ, и он больше не попадает в карту
    // «этому уже сообщено». Возвращаем cid, чтобы проверять именно карту.
    sendMessage: async (peer: string, text: string) => {
      mockSent.push({ peer, text });
      return 'cid-693';
    },
  }),
}));
jest.mock('../sendGate', () => ({ canReachPeer: async () => true }));
jest.mock('../controlWatermark', () => ({ acceptControlTs: async () => true }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { broadcastLastSeenPref } from '../presencePrefSync';

const src = (name: string): string =>
  fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

/** Кому и что сказали в последней рассылке. */
function saidTo(peer: string): boolean | undefined {
  const hit = [...mockSent].reverse().find((m) => m.peer === peer);
  if (!hit) return undefined;
  return JSON.parse(hit.text.slice(hit.text.indexOf('{'))).show as boolean;
}

/** Карта, как она лежит в базе сейчас. */
function storedMap(): Record<string, boolean> {
  const raw = mockKv.get(SENT_DB_KEY);
  return raw ? JSON.parse(raw) : {};
}

beforeEach(() => {
  mockKv.clear();
  mockFailReads.clear();
  mockSent.length = 0;
  mockContacts = [CONTACT];
  mockVisibility = 'nobody';
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: рассылка при работающей базе делает своё', () => {
  it('отзыв уходит и контакту, и тому, кому уже говорили', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    await broadcastLastSeenPref();
    expect(saidTo(CONTACT)).toBe(false);
    expect(saidTo(EX)).toBe(false);
    expect(storedMap()).toEqual({ [EX]: false, [CONTACT]: false });
  });

  it('исходники на месте', () => {
    expect(src('presencePrefSync.ts').length).toBeGreaterThan(3000);
    expect(src('profileSync.ts').length).toBeGreaterThan(3000);
  });
});

describe('отказ чтения не стирает карту', () => {
  it('запись поверх настоящей карты не идёт', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    mockFailReads.add(SENT_DB_KEY);
    await broadcastLastSeenPref();
    // Контакту сказать успели — это лучше, чем не сказать никому.
    expect(saidTo(CONTACT)).toBe(false);
    // А карта в базе осталась прежней: бывший контакт из неё не пропал.
    expect(JSON.parse(mockKv.get(SENT_DB_KEY) as string)).toEqual({ [EX]: true });
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: после сбоя отзыв всё ещё доходит до бывшего контакта', async () => {
    mockKv.set(SENT_DB_KEY, JSON.stringify({ [EX]: true }));
    mockFailReads.add(SENT_DB_KEY);
    await broadcastLastSeenPref();
    expect(saidTo(EX)).toBeUndefined();

    // База ожила — следующая рассылка обязана найти бывшего контакта.
    mockFailReads.clear();
    mockSent.length = 0;
    await broadcastLastSeenPref();
    expect(saidTo(EX)).toBe(false);
  });

  it('карта не создаётся из одной последней правки', async () => {
    // Карты ещё нет, читать её база отказывается. Старый код записал бы сюда
    // одну свежую правку — и это выглядело бы как полный список.
    mockFailReads.add(SENT_DB_KEY);
    await broadcastLastSeenPref();
    expect(saidTo(CONTACT)).toBe(false);
    expect(mockKv.has(SENT_DB_KEY)).toBe(false);
  });
});

describe('оба списка «кому отправлено» читаются одинаково', () => {
  for (const [file, guard] of [
    ['presencePrefSync.ts', 'isSentFlag'],
    ['profileSync.ts', 'isSentVersion'],
  ] as const) {
    it(`${file}: чтение трёхзначное`, () => {
      const s = src(file);
      expect(s).toContain('async function loadSent(pid: number): Promise<SentMap | null> {');
      expect(s).toContain('const read = await scopedKvTryGetFor(pid, SENT_KEY);');
      expect(s).toContain(`return read === null ? null : parseSentMap(read.value, ${guard});`);
      expect(s).not.toContain('scopedKvGetFor(pid, SENT_KEY)');
    });

    it(`${file}: не прочитали — не пишем`, () => {
      const s = src(file);
      expect(s).toContain('    const stored = await loadSent(pid);\n    if (stored === null) {');
      expect(s).toContain('const merged = trimSentMap(mergeSentMap(stored, patch), SENT_MAX);');
      expect(s).not.toContain('mergeSentMap(await loadSent(pid), patch)');
    });

    it(`${file}: у читающих подставлено пустое, а не «не знаем»`, () => {
      const s = src(file);
      expect(s).not.toMatch(/const sent = await loadSent\(pid\);/);
      expect(s).toContain('const sent = (await loadSent(pid)) ?? {};');
    });
  }
});
