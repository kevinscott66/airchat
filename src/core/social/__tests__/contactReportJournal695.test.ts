/**
 * v4.32.695: жалоба перестала стирать журнал жалоб.
 *
 * `listContactReports` читала через `scopedKvGet`, а тот сводит «база не
 * ответила» и «ничего не записано» в один null. `recordContactReport` брала
 * этот null за пустой журнал и записывала поверх него одну новую жалобу —
 * весь прежний след (до двухсот записей) исчезал навсегда. Модуль сам
 * объявляет журнал единственным следом человека: «чтобы у человека остался
 * собственный след: у кого он это увидел и что сделал».
 *
 * Проверка ведётся поведением: profileScopedKv берётся настоящий, а отказ
 * подделывается на уровне базы — `kvTryGet` отвечает null ровно так же, как
 * отвечает при сбое SQLite.
 */
const mockPid = 2;
const DID = 'did:key:z6MkПервый';
const OTHER = 'did:key:z6MkВторой';
const JOURNAL_KEY = `p${mockPid}:contact_reports`;

const mockKv = new Map<string, string>();
/** Ключи, чтение которых база не выполняет (kvTryGet отвечает null). */
const mockFailReads = new Set<string>();
/** Ключи, запись которых база не выполняет (kvSetChecked отвечает false). */
const mockFailWrites = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockFailReads.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSetChecked: async (k: string, v: string) => {
    if (mockFailWrites.has(k)) return false;
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => { mockKv.delete(k); },
  kvListKeysByPrefix: async () => [],
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockPid }) },
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { hasReported, listContactReports, recordContactReport } from '../contactReport';

const SRC = readFileSync(join(__dirname, '..', 'contactReport.ts'), 'utf8');

beforeEach(() => {
  mockKv.clear();
  mockFailReads.clear();
  mockFailWrites.clear();
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: журнал вообще работает', () => {
  it('записанная жалоба читается обратно', async () => {
    await recordContactReport(DID, 'spam', true);
    const all = await listContactReports();
    expect(all.map((r) => r.did)).toEqual([DID]);
    expect(all[0].reason).toBe('spam');
    expect(all[0].blocked).toBe(true);
    await expect(hasReported(DID)).resolves.toBe(true);
  });

  it('новая жалоба встаёт впереди прежних, а прежние остаются', async () => {
    await recordContactReport(DID, 'spam', false);
    await recordContactReport(OTHER, 'fraud', true);
    expect((await listContactReports()).map((r) => r.did)).toEqual([OTHER, DID]);
  });
});

describe('отказ чтения не стирает журнал', () => {
  it('прежние записи остаются на месте', async () => {
    await recordContactReport(DID, 'spam', false);
    await recordContactReport(OTHER, 'fraud', true);
    const before = mockKv.get(JOURNAL_KEY);

    mockFailReads.add(JOURNAL_KEY);
    await expect(recordContactReport('did:key:z6MkТретий', 'abuse', false)).rejects.toThrow();

    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: на диске лежит ровно то, что лежало до попытки.
    expect(mockKv.get(JOURNAL_KEY)).toBe(before);
    mockFailReads.clear();
    expect((await listContactReports()).map((r) => r.did)).toEqual([OTHER, DID]);
  });

  it('журнал не создаётся из одной последней жалобы', async () => {
    mockFailReads.add(JOURNAL_KEY);
    await expect(recordContactReport(DID, 'spam', false)).rejects.toThrow();
    expect(mockKv.has(JOURNAL_KEY)).toBe(false);
  });

  it('отказ доходит до карточки понятным человеку текстом', async () => {
    mockFailReads.add(JOURNAL_KEY);
    await expect(recordContactReport(DID, 'spam', false)).rejects.toThrow(/[А-Яа-я]/);
  });

  it('но саму карточку открыть не мешает', async () => {
    mockFailReads.add(JOURNAL_KEY);
    await expect(listContactReports()).resolves.toEqual([]);
    await expect(hasReported(DID)).resolves.toBe(false);
  });
});

describe('испорченный журнал — это по-прежнему пустой журнал', () => {
  it('поверх нечитаемого JSON новая жалоба записывается', async () => {
    mockKv.set(JOURNAL_KEY, 'не json');
    await recordContactReport(DID, 'spam', false);
    expect((await listContactReports()).map((r) => r.did)).toEqual([DID]);
  });
});

describe('отказ записи тоже не выдаётся за успех', () => {
  it('запись не легла — жалоба сообщает об этом броском', async () => {
    mockFailWrites.add(JOURNAL_KEY);
    await expect(recordContactReport(DID, 'spam', false)).rejects.toThrow(/[А-Яа-я]/);
    expect(mockKv.has(JOURNAL_KEY)).toBe(false);
  });
});

describe('исходник: чтение объявлено тройственным', () => {
  it('есть readReports с тремя ответами и на нём стоит запись', () => {
    expect(SRC).toContain('async function readReports(): Promise<ContactReport[] | null> {');
    expect(SRC).toContain('const read = await scopedKvTryGet(KEY);');
    expect(SRC).toContain('return read === null ? null : parseReports(read.value);');
    expect(SRC).toContain('const prev = await readReports();');
    expect(SRC).toContain('if (prev === null) {');
  });

  it('старая слепая пара «прочитать-записать» не вернулась', () => {
    expect(SRC).not.toContain('scopedKvGet(KEY)');
    expect(SRC).not.toContain('await scopedKvSet(KEY,');
    expect(SRC).toContain('await scopedKvSetChecked(KEY, JSON.stringify(next))');
  });
});
