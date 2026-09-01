/**
 * v4.32.552 — непрочитанная секретная запись не должна перезаписываться.
 *
 * Дефект: `kvGetSecret` звал `decryptAtRestString`, а тот при неудаче отдаёт
 * пустую строку. Три места читали корзину «недавно удалённые» (переписка,
 * группа — удаление и восстановление) и одно — личную заметку о человеке,
 * и все четыре принимали эту пустоту за «прежнего содержимого не было»:
 * список начинался с нуля и уходил в базу поверх старого шифртекста.
 */
const mockRows = new Map<string, string>();
let mockDecryptFails = false;
let mockWriteFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, args: unknown[]) => {
      if (mockWriteFails) throw new Error('SQLITE_FULL: database or disk is full');
      if (/^INSERT OR REPLACE INTO kv /i.test(sql)) mockRows.set(String(args[0]), String(args[1]));
      if (/^DELETE FROM kv WHERE k = \?/i.test(sql)) mockRows.delete(String(args[0]));
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string, args: unknown[]) => {
      if (/FROM kv/i.test(sql)) {
        const v = mockRows.get(String(args[0]));
        return v === undefined ? null : { v };
      }
      return null;
    }),
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

jest.mock('../localEncryption', () => {
  const { classifyAtRestCell } = jest.requireActual('../atRestCell');
  const decode = (v: string): string | null => {
    if (!v.startsWith('enc2:')) return v;
    return mockDecryptFails ? null : v.slice('enc2:'.length);
  };
  return {
    AT_REST_PREFIX: 'enc2:',
    AT_REST_COLUMNS: [],
    DEK_KEY: 'dek',
    getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
    encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
    encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
    encryptAtRestIfPlain: jest.fn((v: string | null) =>
      v == null || v === '' || v.startsWith('enc2:') ? v : `enc2:${v}`
    ),
    decryptAtRestString: jest.fn((v: string) => decode(v) ?? ''),
    decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : decode(v) ?? '')),
    tryDecryptAtRest: jest.fn((v: string) => decode(v)),
    readAtRestCell: jest.fn((v: string | null) =>
      v === null ? classifyAtRestCell(null, null) : classifyAtRestCell(v, decode(v))
    ),
    canaryOpensWith: jest.fn(async () => true),
    persistDek: jest.fn(async () => undefined),
    isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
    resetDataEncryptionKeyCache: jest.fn(),
  };
});

import * as fs from 'fs';
import * as path from 'path';

import {
  SECRET_UNREADABLE_TEXT,
  decideSecretUpdate,
  isReadableSecret,
  type SecretCellState,
} from '../secretUpdate';
import {
  kvGetSecret,
  kvGetSecretCell,
  kvGetSecretScoped,
  kvSetSecretScoped,
  kvUpdateSecretScoped,
} from '../local';

const STATES: SecretCellState[] = ['absent', 'plain', 'unreadable'];

const LOCAL = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
const MODULE = fs.readFileSync(path.join(__dirname, '..', 'secretUpdate.ts'), 'utf8');
const CHAT = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'), 'utf8');
const GROUPS = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
const NOTE = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'chat',
    'ChatContactInfoModal.tsx'), 'utf8');

beforeEach(() => {
  mockRows.clear();
  mockDecryptFails = false;
  mockWriteFails = false;
});

describe('решение о записи поверх секрета', () => {
  it('непрочитанное не переписывается ни при каких значениях', () => {
    expect(decideSecretUpdate('unreadable', null, 'новое')).toBe('refuse-unreadable');
    expect(decideSecretUpdate('unreadable', null, null)).toBe('refuse-unreadable');
    expect(decideSecretUpdate('unreadable', 'старое', 'старое')).toBe('refuse-unreadable');
  });

  it('запрет ровно один из трёх состояний', () => {
    expect(STATES.filter((s) => !isReadableSecret(s))).toEqual(['unreadable']);
  });

  it('пусто и «нет записи» — законные начала, писать можно', () => {
    expect(decideSecretUpdate('absent', null, '[]')).toBe('write');
    expect(decideSecretUpdate('plain', '', '[]')).toBe('write');
  });

  it('совпало со старым — писать нечего', () => {
    expect(decideSecretUpdate('plain', '[1]', '[1]')).toBe('skip-unchanged');
  });

  it('вызывающий передумал — тоже нечего', () => {
    expect(decideSecretUpdate('plain', '[1]', null)).toBe('skip-unchanged');
  });

  it('текст отказа не обещает, что позже получится', () => {
    expect(SECRET_UNREADABLE_TEXT).toContain('не открывается');
    expect(SECRET_UNREADABLE_TEXT).not.toMatch(/позж|повтор/i);
  });
});

describe('поведение секретного kv', () => {
  it('обычный круг: записали, прочитали, дополнили', async () => {
    expect(await kvUpdateSecretScoped(1, 'trash', () => '["a"]')).toBe('written');
    expect(await kvGetSecretScoped(1, 'trash')).toBe('["a"]');
    expect(await kvUpdateSecretScoped(1, 'trash', (cur) => `${cur}+b`)).toBe('written');
    expect(await kvGetSecretScoped(1, 'trash')).toBe('["a"]+b');
  });

  it('не открылось — запись отклонена, шифртекст на месте', async () => {
    await kvSetSecretScoped(1, 'trash', '["важное"]');
    const before = new Map(mockRows);
    mockDecryptFails = true;

    expect(await kvUpdateSecretScoped(1, 'trash', () => '["одно новое"]')).toBe('unreadable');
    expect(mockRows).toEqual(before);

    // И убеждаемся, что терялось именно содержимое: с прежним ключом оно на месте.
    mockDecryptFails = false;
    expect(await kvGetSecretScoped(1, 'trash')).toBe('["важное"]');
  });

  it('дополняющей функции не дают решать судьбу непрочитанного', async () => {
    await kvSetSecretScoped(1, 'trash', '["важное"]');
    mockDecryptFails = true;
    const update = jest.fn(() => '["пусто"]');
    expect(await kvUpdateSecretScoped(1, 'trash', update)).toBe('unreadable');
    expect(update).not.toHaveBeenCalled();
  });

  it('не открылось — чтение отвечает null, а не пустой строкой', async () => {
    await kvSetSecretScoped(1, 'trash', '["важное"]');
    mockDecryptFails = true;
    expect(await kvGetSecretScoped(1, 'trash')).toBeNull();
    expect((await kvGetSecretCell('p1:trash')).state).toBe('unreadable');
  });

  it('перенос из общей области не ложится поверх своей непрочитанной записи', async () => {
    await kvSetSecretScoped(2, 'note', 'своя заметка');
    // Общая (доprofile) запись того же ключа.
    mockRows.set('note', 'enc2:чужая заметка');
    const own = mockRows.get('p2:note');
    mockDecryptFails = true;

    expect(await kvGetSecretScoped(2, 'note')).toBeNull();
    expect(mockRows.get('p2:note')).toBe(own);
    expect(mockRows.get('note')).toBe('enc2:чужая заметка');
  });

  it('пустая запись переносу и записи не мешает', async () => {
    mockRows.set('note', 'enc2:старая общая');
    expect(await kvGetSecretScoped(3, 'note')).toBe('старая общая');
    expect(mockRows.get('p3:note')).toBe('enc2:старая общая');
  });

  it('провал записи не выдаётся за успех', async () => {
    mockWriteFails = true;
    expect(await kvUpdateSecretScoped(1, 'trash', () => '["a"]')).toBe('failed');
  });

  it('нечего менять — базу не трогаем', async () => {
    await kvSetSecretScoped(1, 'trash', '["a"]');
    const before = new Map(mockRows);
    expect(await kvUpdateSecretScoped(1, 'trash', () => '["a"]')).toBe('unchanged');
    expect(await kvUpdateSecretScoped(1, 'trash', () => null)).toBe('unchanged');
    expect(mockRows).toEqual(before);
  });

  it('проверка не пустая: тот же стенд читает секрет и без профиля', async () => {
    await kvSetSecretScoped(1, 'trash', 'x');
    expect(await kvGetSecret('p1:trash')).toBe('x');
  });
});

describe('форма исходников', () => {
  it('модуль решения без импортов', () => {
    expect(MODULE).not.toMatch(/^import\s/m);
    expect(MODULE).not.toMatch(/\brequire\(/);
  });

  it('kvGetSecret отвечает через ячейку, а не через decryptAtRestString', () => {
    expect(LOCAL).toContain('return cellTextOrNull(await kvGetSecretCell(key));');
    expect(LOCAL).not.toContain("  const stored = await kvGet(key);\n  if (stored == null) return null;\n  try {\n    const dek = await getOrCreateDataEncryptionKey();\n    return decryptAtRestString(stored, dek);");
  });

  it('перенос из общей области спрашивает про отсутствие, а не про пустоту', () => {
    expect(LOCAL).toContain("if (own.state !== 'absent') return own;");
    expect(LOCAL).not.toContain('const own = await kvGetSecret(scoped);\n  if (own != null) return own;');
  });

  it('обе корзины и заметка идут через один безопасный путь', () => {
    expect(CHAT).toContain('kvUpdateSecretScoped(activeProfileId, recentlyDeletedKey(peerB64)');
    expect(GROUPS.match(/kvUpdateSecretScoped\(pid, recentlyDeletedGroupKey\(group\.id\)/g))
      .toHaveLength(2);
    expect(NOTE).toContain('m.kvUpdateSecretScoped(');
  });

  it('ни один из четырёх не читает и не пишет корзину врозь', () => {
    expect(CHAT).not.toContain('kvGetSecretScoped: kg, kvSetSecretScoped: ks');
    expect(GROUPS).not.toContain('kvGetSecretScoped: kg, kvSetSecretScoped: ks');
    expect(NOTE).not.toContain('m.kvSetSecretScoped(activeProfileId, m.contactNoteKey(peerB64)');
  });

  it('о сохранении заметки сообщается после записи, а не до', () => {
    expect(NOTE).toContain("if (res === 'unreadable') { showError(SECRET_UNREADABLE_TEXT); return; }");
    expect(NOTE).toContain("showSuccess('Заметка сохранена');");
    expect(NOTE).not.toContain("setNoteEditVisible(false);\n                showSuccess('Заметка сохранена');");
  });
});
