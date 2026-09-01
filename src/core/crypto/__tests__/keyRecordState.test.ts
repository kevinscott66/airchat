/**
 * Нечитаемый ключ устройства не должен превращаться в новую личность (v4.32.547).
 *
 * Дефект. `loadKeyPair()` отвечал `null` в двух разных случаях: «ключей нет»
 * (первый запуск) и «ключи есть, но прочитать их не вышло» — хранилище ключей
 * отказало на холодном старте, DEK оказался другим, запись побилась.
 * `ensureKeyPair()` не различал эти случаи: на любой `null` он заводил новую
 * пару и записывал её поверх старой. Отказ ЧТЕНИЯ становился необратимой
 * ЗАПИСЬЮ — человек терял свой адрес навсегда, а собеседники видели вместо
 * него незнакомца. Ровно та же беда, что с зашифрованными столбцами в
 * v4.32.544, только этажом выше и ценой в целую личность.
 *
 * Вторая половина: секрет и открытый ключ — две записи SecureStore, и «секрет
 * есть, открытого нет» тоже отвечало `null`. Но секрет самодостаточен —
 * открытый ключ из него выводится, и такая запись чинится, а не заменяется.
 */
const mockStore = new Map<string, string>();
const mockWrites: string[] = [];
const mockDekHolder = { bytes: new Uint8Array(32).fill(7) };
const mockFail = { read: false };

jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: async (k: string) => {
    if (mockFail.read) throw new Error('keystore locked');
    return mockStore.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => {
    mockWrites.push(k);
    mockStore.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    mockStore.delete(k);
  },
  isAvailableAsync: async () => true,
}));

jest.mock('../../storage/localEncryption', () => ({
  getOrCreateDataEncryptionKey: async () => mockDekHolder.bytes,
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import fs from 'fs';
import path from 'path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  classifyKeyRecord,
  mayMintNewIdentity,
  isUsableRecord,
  KEY_STORE_UNREADABLE_TEXT,
} from '../keyRecordState';
import {
  KEYPAIR_SECURE_KEYS,
  KeyStoreUnreadableError,
  ensureKeyPair,
  loadKeyPair,
  persistKeyPair,
  readKeyRecord,
} from '../keyManager';

const [SK_KEY, PK_KEY] = KEYPAIR_SECURE_KEYS;
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const PAIR = ed25519.keygen();
const OTHER = ed25519.keygen();

beforeEach(() => {
  mockStore.clear();
  mockWrites.length = 0;
  mockDekHolder.bytes = new Uint8Array(32).fill(7);
  mockFail.read = false;
  jest.clearAllMocks();
});

const facts = (
  hasSecret: boolean,
  hasPublic: boolean,
  secretUsable: boolean,
  publicMatches: boolean
) => ({ hasSecret, hasPublic, secretUsable, publicMatches });

describe('разбор записи', () => {
  it('пустое хранилище — это отсутствие, а не поломка', () => {
    expect(classifyKeyRecord(facts(false, false, false, false))).toBe('absent');
  });

  it('один открытый ключ без секрета — восстанавливать нечего', () => {
    expect(classifyKeyRecord(facts(false, true, false, false))).toBe('orphan-public');
  });

  it('секрет есть, но не читается — это поломка, а не отсутствие', () => {
    expect(classifyKeyRecord(facts(true, true, false, false))).toBe('unreadable');
  });

  it('нечитаемый секрет остаётся поломкой и без открытого ключа', () => {
    expect(classifyKeyRecord(facts(true, false, false, false))).toBe('unreadable');
  });

  it('согласованность открытого ключа не отменяет нечитаемого секрета', () => {
    expect(classifyKeyRecord(facts(true, true, false, true))).toBe('unreadable');
  });

  it('секрет читается, открытого ключа нет — чинится выводом', () => {
    expect(classifyKeyRecord(facts(true, false, true, false))).toBe('repairable');
  });

  it('секрет читается, открытый ключ не тот — тоже чинится', () => {
    expect(classifyKeyRecord(facts(true, true, true, false))).toBe('repairable');
  });

  it('обе записи на месте и согласованы', () => {
    expect(classifyKeyRecord(facts(true, true, true, true))).toBe('ok');
  });
});

describe('право завести новую личность', () => {
  it('даётся только там, где стирать нечего', () => {
    expect(mayMintNewIdentity('absent')).toBe(true);
    expect(mayMintNewIdentity('orphan-public')).toBe(true);
  });

  it('не даётся на нечитаемой записи — это и есть весь смысл правки', () => {
    expect(mayMintNewIdentity('unreadable')).toBe(false);
  });

  it('не даётся там, где запись рабочая', () => {
    expect(mayMintNewIdentity('ok')).toBe(false);
    expect(mayMintNewIdentity('repairable')).toBe(false);
  });

  it('годными считаются целая и починимая записи', () => {
    expect(isUsableRecord('ok')).toBe(true);
    expect(isUsableRecord('repairable')).toBe(true);
    expect(isUsableRecord('absent')).toBe(false);
    expect(isUsableRecord('orphan-public')).toBe(false);
    expect(isUsableRecord('unreadable')).toBe(false);
  });

  it('состояния, дающие право на запись, и годные к работе не пересекаются', () => {
    const all = ['absent', 'orphan-public', 'unreadable', 'repairable', 'ok'] as const;
    for (const s of all) {
      expect(mayMintNewIdentity(s) && isUsableRecord(s)).toBe(false);
    }
  });
});

describe('чтение настоящего хранилища', () => {
  it('целая пара читается как ok и ничего не переписывает', async () => {
    await persistKeyPair({ secretKey: PAIR.secretKey, publicKey: PAIR.publicKey });
    mockWrites.length = 0;
    const read = await readKeyRecord();
    expect(read.state).toBe('ok');
    expect(read.pair && b64(read.pair.publicKey)).toBe(b64(PAIR.publicKey));
    expect(mockWrites).toEqual([]);
  });

  it('пустое хранилище читается как absent', async () => {
    const read = await readKeyRecord();
    expect(read.state).toBe('absent');
    expect(read.pair).toBeNull();
  });

  it('один открытый ключ без секрета — orphan-public', async () => {
    mockStore.set(PK_KEY, b64(PAIR.publicKey));
    const read = await readKeyRecord();
    expect(read.state).toBe('orphan-public');
  });

  it('секрет под другим ключом шифрования — unreadable, а не absent', async () => {
    await persistKeyPair({ secretKey: PAIR.secretKey, publicKey: PAIR.publicKey });
    mockDekHolder.bytes = new Uint8Array(32).fill(9);
    const read = await readKeyRecord();
    expect(read.state).toBe('unreadable');
    expect(read.pair).toBeNull();
  });

  it('отказ хранилища ключей — unreadable, а не absent', async () => {
    mockFail.read = true;
    const read = await readKeyRecord();
    expect(read.state).toBe('unreadable');
  });

  it('порченый старый секрет — unreadable', async () => {
    mockStore.set(SK_KEY, b64(PAIR.secretKey.slice(0, 10)));
    mockStore.set(PK_KEY, b64(PAIR.publicKey));
    const read = await readKeyRecord();
    expect(read.state).toBe('unreadable');
  });

  it('секрет без открытого ключа чинится, а не теряется', async () => {
    mockStore.set(SK_KEY, b64(PAIR.secretKey));
    const read = await readKeyRecord();
    expect(read.state).toBe('repairable');
    expect(read.pair && b64(read.pair.publicKey)).toBe(b64(PAIR.publicKey));
    expect(mockStore.get(PK_KEY)).toBe(b64(PAIR.publicKey));
  });

  it('порченый открытый ключ чинится выводом из секрета', async () => {
    mockStore.set(SK_KEY, b64(PAIR.secretKey));
    mockStore.set(PK_KEY, b64(new Uint8Array(10)));
    const read = await readKeyRecord();
    expect(read.state).toBe('repairable');
    expect(read.pair && b64(read.pair.publicKey)).toBe(b64(PAIR.publicKey));
  });

  it('чужой открытый ключ рядом с секретом чинится, а не отбрасывается', async () => {
    mockStore.set(SK_KEY, b64(PAIR.secretKey));
    mockStore.set(PK_KEY, b64(OTHER.publicKey));
    const read = await readKeyRecord();
    expect(read.state).toBe('repairable');
    expect(read.pair && b64(read.pair.publicKey)).toBe(b64(PAIR.publicKey));
  });

  it('loadKeyPair остаётся тонкой обёрткой: та же пара, тот же null', async () => {
    expect(await loadKeyPair()).toBeNull();
    await persistKeyPair({ secretKey: PAIR.secretKey, publicKey: PAIR.publicKey });
    const loaded = await loadKeyPair();
    expect(loaded && b64(loaded.secretKey)).toBe(b64(PAIR.secretKey));
  });
});

describe('ensureKeyPair', () => {
  it('на пустом хранилище заводит пару — первый запуск не сломан', async () => {
    const pair = await ensureKeyPair();
    expect(pair.secretKey.length).toBe(32);
    expect(mockWrites).toEqual([SK_KEY, PK_KEY]);
  });

  it('на осиротевшем открытом ключе заводит пару: стирать нечего', async () => {
    mockStore.set(PK_KEY, b64(PAIR.publicKey));
    const pair = await ensureKeyPair();
    expect(b64(pair.publicKey)).not.toBe(b64(PAIR.publicKey));
  });

  it('на целой паре ничего не пишет и отдаёт ту же личность', async () => {
    await persistKeyPair({ secretKey: PAIR.secretKey, publicKey: PAIR.publicKey });
    mockWrites.length = 0;
    const pair = await ensureKeyPair();
    expect(b64(pair.publicKey)).toBe(b64(PAIR.publicKey));
    expect(mockWrites).toEqual([]);
  });

  it('на нечитаемом секрете НЕ заводит новую личность, а падает', async () => {
    await persistKeyPair({ secretKey: PAIR.secretKey, publicKey: PAIR.publicKey });
    const before = mockStore.get(SK_KEY);
    mockDekHolder.bytes = new Uint8Array(32).fill(9);
    mockWrites.length = 0;
    await expect(ensureKeyPair()).rejects.toBeInstanceOf(KeyStoreUnreadableError);
    expect(mockWrites).toEqual([]);
    expect(mockStore.get(SK_KEY)).toBe(before);
  });

  it('на отказе хранилища тоже падает, а не подменяет ключ', async () => {
    mockFail.read = true;
    await expect(ensureKeyPair()).rejects.toBeInstanceOf(KeyStoreUnreadableError);
    expect(mockWrites).toEqual([]);
  });

  it('сообщение об отказе — по-русски и про перезапуск', async () => {
    mockFail.read = true;
    await expect(ensureKeyPair()).rejects.toThrow(KEY_STORE_UNREADABLE_TEXT);
    expect(KEY_STORE_UNREADABLE_TEXT).toMatch(/[а-яё]/i);
    expect(KEY_STORE_UNREADABLE_TEXT).not.toMatch(/[a-z]{4}/i);
  });

  it('починимую запись чинит, а не заменяет', async () => {
    mockStore.set(SK_KEY, b64(PAIR.secretKey));
    const pair = await ensureKeyPair();
    expect(b64(pair.publicKey)).toBe(b64(PAIR.publicKey));
  });
});

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const PURE = read('../keyRecordState.ts');
const KM = read('../keyManager.ts');
const APP = read('../../../App.tsx');

const bodyOf = (src: string, head: string): string => {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
};
const ENSURE = (): string => bodyOf(KM, 'export async function ensureKeyPair(): Promise<KeyPairBytes> {');

describe('форма исходников', () => {
  it('разбор состояний живёт без импортов — его можно проверить целиком', () => {
    expect(PURE.split('\n').filter((l) => l.startsWith('import ')).length).toBe(0);
    expect(PURE).toContain('export function classifyKeyRecord(');
    expect(PURE).toContain('export function mayMintNewIdentity(');
  });

  it('ensureKeyPair спрашивает разрешение прежде, чем заводить пару', () => {
    const body = ENSURE();
    const guard = body.indexOf('mayMintNewIdentity(');
    const mint = body.indexOf('generateKeyPair(');
    expect(guard).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(guard);
    expect(body).toContain('throw new KeyStoreUnreadableError(');
  });

  it('ensureKeyPair не пишет в хранилище раньше проверки', () => {
    const body = ENSURE();
    expect(body.indexOf('persistKeyPair(')).toBeGreaterThan(body.indexOf('mayMintNewIdentity('));
  });

  it('loadKeyPair больше не решает сам — только пересказывает readKeyRecord', () => {
    const body = bodyOf(KM, 'export async function loadKeyPair(): Promise<KeyPairBytes | null> {');
    expect(body).toContain('readKeyRecord()');
    expect(body).not.toContain('SecureStore.');
  });

  it('отказ хранилища в readKeyRecord не выдаётся за отсутствие ключей', () => {
    const body = bodyOf(KM, 'export async function readKeyRecord(): Promise<KeyRecordRead> {');
    expect(body).toContain("return { state: 'unreadable', pair: null };");
    expect(body).not.toContain('return null;');
  });

  it('загрузка приложения различает «нет ключей» и «не читается»', () => {
    expect(APP).toContain("import { KEY_STORE_UNREADABLE_TEXT } from './core/crypto/keyRecordState';");
    expect(APP).toContain("keyRecord.state === 'unreadable'");
    expect(APP).toContain('setBootError(KEY_STORE_UNREADABLE_TEXT)');
    expect(APP).toContain('withTimeout(readKeyRecord(), 120000');
  });
});
