/**
 * Секретная запись обязана сознаваться в провале (v4.32.435).
 *
 * kvSetSecret объявлен как «возвращает, записалось ли», и с v4.32.293 на этом
 * слове стоят три отката: перенос заметки о контакте, перенос поля карточки
 * профиля и раздача общей записи по профилям — все они удаляют исходную
 * запись, «только если копия действительно легла». Но внутри звали kvSet,
 * который гасит ошибку записи и возвращает void, так что ответ был всегда
 * «легло», а try/catch ловил разве что провал шифрования. На полном диске
 * оригинал стирался, а копии не появлялось.
 */
let mockWriteFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => {
      if (mockWriteFails) throw new Error('SQLITE_FULL: database or disk is full');
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
  encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
  decryptAtRestString: jest.fn((v: string) => v.replace('enc2:', '')),
  decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : v.replace('enc2:', ''))),
  isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { kvSetChecked, kvSetSecret } from '../local';

beforeEach(() => {
  mockWriteFails = false;
});

describe('kvSetSecret сообщает правду о записи', () => {
  it('успешная запись — true', async () => {
    await expect(kvSetSecret('k1', 'v1')).resolves.toBe(true);
  });

  it('диск полон — false, а не «сохранено»', async () => {
    mockWriteFails = true;
    await expect(kvSetSecret('k2', 'v2')).resolves.toBe(false);
  });

  it('проверка не пустая: тот же стенд валит и обычную проверенную запись', async () => {
    mockWriteFails = true;
    await expect(kvSetChecked('k3', 'v3')).resolves.toBe(false);
    mockWriteFails = false;
    await expect(kvSetChecked('k3', 'v3')).resolves.toBe(true);
  });
});

describe('слово «легло» нельзя выдать, не спросив базу', () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
  const VOID_WRITE = 'await kvSet(';

  /** Тела экспортируемых функций, обещающих ответ «легло / не легло». */
  function boolWriters(source: string): { name: string; body: string }[] {
    const lines = source.split('\n');
    const out: { name: string; body: string }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes('Promise<boolean>') || !lines[i].includes('export async function')) continue;
      const name = lines[i].split('function ')[1].split('(')[0];
      let end = i;
      while (end < lines.length && lines[end] !== '}') end += 1;
      out.push({ name, body: lines.slice(i, end + 1).join('\n') });
    }
    return out;
  }

  it('таких функций в local.ts несколько', () => {
    const names = boolWriters(SOURCE).map((f) => f.name);
    expect(names).toContain('kvSetSecret');
    expect(names).toContain('kvSetChecked');
  });

  it('ни одна из них не пишет через void-версию kvSet', () => {
    const offenders = boolWriters(SOURCE)
      .filter((f) => f.body.includes(VOID_WRITE))
      .map((f) => f.name);
    // kvSet гасит ошибку и возвращает void: после него сказать «легло» нечем.
    expect(offenders).toEqual([]);
  });

  it('проверка не пустая: прежняя редакция kvSetSecret ловится', () => {
    const before = [
      'export async function kvSetSecret(key: string, value: string): Promise<boolean> {',
      '  try {',
      '    const dek = await getOrCreateDataEncryptionKey();',
      '    await kvSet(key, encryptAtRestString(value, dek));',
      '    return true;',
      '  } catch (e) {',
      '    return false;',
      '  }',
      '}',
    ].join('\n');
    expect(boolWriters(before).map((f) => f.name)).toEqual(['kvSetSecret']);
    expect(boolWriters(before).filter((f) => f.body.includes(VOID_WRITE)).length).toBe(1);
  });
});
