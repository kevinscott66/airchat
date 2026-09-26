/**
 * Список групп, который не прочитался, — не отсутствие групп (v4.32.995).
 *
 * Дефект. `listGroups` и `listArchivedGroups` ловили любой отказ и отвечали
 * пустым массивом. Отказ здесь не выдуманный: это и сбой самой базы, и
 * `getOrCreateDataEncryptionKey`, который не открыл ключ данных, — строки на
 * диске при этом целы.
 *
 * Цена. Вкладка групп рисовала на пустом списке «Нет групп» и подсказку
 * «Создайте группу или канал, нажав «+»». Человеку с двумя десятками групп это
 * читается как пропажа всех разговоров разом, а подсказка зовёт сделать ровно
 * то, чего делать нельзя: завести вторую группу с новой ссылкой при целой
 * первой. Новую ссылку придётся разослать всем, а прежняя группа продолжит
 * жить у остальных участников — разговор расходится надвое.
 *
 * Правка. Те же три исхода, что у диалогов с v4.32.650: строки, пусто, сбой
 * чтения. Разбор строки остался один (`rowToGroup`), различия — в параметрах.
 * Экран на сбое оставляет показанное как было и говорит, что группы на месте.
 *
 * Границы. Старые имена сохранены и по-прежнему сводят сбой к пустому списку:
 * пересылка, «Поделиться» и карточка профиля выбирают из списка, и третий
 * исход им пока не нужен. Прочитанная пустота остаётся пустотой: у нового
 * аккаунта групп правда нет, и «Нет групп» там — правда.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Строки groups, какими их видит запрос: ключ — значение столбца archived. */
let mockRows: Record<number, Array<Record<string, unknown>>> = { 0: [], 1: [] };
/** Отвечает ли база на запрос вообще. */
let mockSelectFails = false;
/** Открывается ли ключ данных. */
let mockDekFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    // Сверка идёт по полному условию запроса: открытие базы гоняет свои
    // запросы к той же таблице, и без этого сюда попадал бы разбор миграций.
    getAllAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      if (!/FROM groups WHERE owner_profile_id = \? AND archived = \?/i.test(sql)) return [];
      if (mockSelectFails) throw new Error('database disk image is malformed');
      return mockRows[Number((params ?? [])[1])] ?? [];
    }),
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

jest.mock('../localEncryption', () => {
  const { classifyAtRestCell } = jest.requireActual('../atRestCell');
  const decode = (v: string): string | null => (v.startsWith('enc2:') ? v.slice('enc2:'.length) : v);
  return {
    AT_REST_PREFIX: 'enc2:',
    AT_REST_COLUMNS: [],
    DEK_KEY: 'dek',
    getOrCreateDataEncryptionKey: jest.fn(async () => {
      if (mockDekFails) throw new Error('keystore unavailable');
      return new Uint8Array(32);
    }),
    encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
    encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
    encryptAtRestIfPlain: jest.fn((v: string | null) => v),
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

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const LOCAL = (): string => read('core', 'storage', 'local.ts');
const TEXTS = (): string => read('core', 'storage', 'unreadableText.ts');
const SCREEN = (): string => read('ui', 'screens', 'GroupsScreen.tsx');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Строки исходника без комментариев: своя же поясняющая цитата не должна ловиться. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Одна строка groups: столько столбцов, сколько спрашивает разбор. */
function groupRow(id: string, name: string): Record<string, unknown> {
  return {
    id,
    owner_profile_id: 1,
    name: `enc2:${name}`,
    type: 'group',
    description: null,
    avatar_cid: null,
    username: null,
    is_admin: 1,
    invite_token: null,
    created_at: 1,
    last_message_at: 2,
    last_message_preview: null,
    draft_text: null,
    pinned: 0,
    archived: 0,
    muted: 0,
    muted_until: null,
    unread_count: 0,
  };
}

beforeEach(() => {
  mockRows = { 0: [], 1: [] };
  mockSelectFails = false;
  mockDekFails = false;
});

describe('отказ чтения списка групп больше не выдаётся за пустоту', () => {
  it('база не ответила — третий исход, а не пустой список', async () => {
    const { listGroupsRead } = await import('../local');
    mockSelectFails = true;
    expect(await listGroupsRead(1)).toBeNull();
  });

  it('то же самое у архива: «в архиве пусто» и «не прочиталось» различимы', async () => {
    const { listArchivedGroupsRead } = await import('../local');
    mockSelectFails = true;
    expect(await listArchivedGroupsRead(1)).toBeNull();
  });

  it('ключ данных не открылся — строки целы, а списка нет', async () => {
    const { listGroupsRead } = await import('../local');
    mockRows = { 0: [groupRow('g1', 'Соседи')], 1: [] };
    mockDekFails = true;
    expect(await listGroupsRead(1)).toBeNull();
  });

  it('групп правда нет — законный пустой список, а не отказ', async () => {
    const { listGroupsRead, listArchivedGroupsRead } = await import('../local');
    expect(await listGroupsRead(1)).toEqual([]);
    expect(await listArchivedGroupsRead(1)).toEqual([]);
  });

  it('строки есть — приходят разобранными, каждая в свой список', async () => {
    const { listGroupsRead, listArchivedGroupsRead } = await import('../local');
    mockRows = { 0: [groupRow('g1', 'Соседи')], 1: [groupRow('g2', 'Дача')] };
    expect((await listGroupsRead(1))?.map((g) => g.name)).toEqual(['Соседи']);
    expect((await listArchivedGroupsRead(1))?.map((g) => g.name)).toEqual(['Дача']);
  });

  it('оба списка читаются одним телом, а не двумя копиями', () => {
    const src = LOCAL();
    expect(src).toContain('async function readGroupRows(');
    // Одно объявление и ровно два вызова: открытый список и архивный.
    expect((src.match(/readGroupRows\(/g) ?? []).length).toBe(3);
    expect(src).toContain("const OPEN_GROUP_ORDER = 'pinned DESC, last_message_at DESC';");
    expect(src).toContain("const ARCHIVED_GROUP_ORDER = 'last_message_at DESC';");
  });

  it('исход берётся у общего правила readResult.ts, а не объявляется свой', () => {
    expect(LOCAL()).toContain('Promise<DbRead<GroupRow>>');
  });

  it('обе метки в журнале сохранены: сбой различим по списку', () => {
    const src = LOCAL();
    expect(src).toContain("'list_groups_failed'");
    expect(src).toContain("'list_archived_groups_failed'");
  });
});

describe('пометка про непрочитанные группы', () => {
  it('своя и не совпадает с остальными пометками каталога', () => {
    const src = TEXTS();
    expect(src).toContain("export const UNREADABLE_GROUPS_TEXT = 'Группы не удалось прочитать'");
    const marks = src.match(/= '([^']*не удалось прочитать)'/g) ?? [];
    expect(new Set(marks).size).toBe(marks.length);
  });
});

describe('вкладка групп: сбой чтения не выдаётся за пустоту', () => {
  it('оба списка читаются вариантом с третьим исходом', () => {
    const body = slice(SCREEN(), 'const loadGroups = useCallback(async () => {', '}, [pid]);');
    expect(body).toContain('listGroupsRead(pid)');
    expect(body).toContain('listArchivedGroupsRead(pid)');
  });

  it('на сбое показанное остаётся как было: списки не трогаем', () => {
    const body = slice(SCREEN(), 'const loadGroups = useCallback(async () => {', '}, [pid]);');
    expect(body).toContain('if (list === null || archived === null) {');
    expect(body).toContain('setGroupsReadFailed(true);');
    // Возврат стоит раньше, чем запись списков.
    expect(body.indexOf('return;')).toBeLessThan(body.indexOf('setGroups(list);'));
    expect(body.indexOf('setGroupsReadFailed(false);')).toBeLessThan(body.indexOf('setGroups(list);'));
  });

  it('пустой экран на сбое говорит правду и не зовёт создавать группу заново', () => {
    const body = slice(SCREEN(), 'groupsReadFailed ? (', ') : (');
    expect(body).toContain('{UNREADABLE_GROUPS_TEXT}');
    expect(codeOnly(body)).not.toContain('Создайте группу или канал');
    expect(codeOnly(body)).not.toContain('Нет групп');
    // Срез — кусок разметки, а не весь файл: иначе «не содержит» ничего не стоит.
    expect(body.length).toBeGreaterThan(50);
    expect(body.length).toBeLessThan(SCREEN().length / 4);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('обычная пустота по-прежнему зовёт создать группу — из-за неё пустой список и был ложью', () => {
    // Не будь этой подсказки, честная ветка выше была бы украшением.
    expect(SCREEN()).toContain('Создайте группу или канал, нажав «+»');
    expect(SCREEN()).toContain("'Нет групп'");
  });

  it('разбор строки группы по-прежнему один на оба списка', () => {
    expect(LOCAL()).toContain('function rowToGroup(r: Record<string, unknown>, dek: Uint8Array): GroupRow');
  });

  it('образец различения уже стоял рядом: одиночная группа читается тремя исходами', () => {
    const body = slice(LOCAL(), 'export async function getGroupRead(', '\n}\n');
    expect(body).toContain('return missingResult();');
    expect(body).toContain('return failedResult();');
  });

  it('старые имена сохранены и сводят отказ к пустому списку, как прежде', async () => {
    const { listGroups, listArchivedGroups } = await import('../local');
    mockSelectFails = true;
    expect(await listGroups(1)).toEqual([]);
    expect(await listArchivedGroups(1)).toEqual([]);
  });

  it('у пересылки и «Поделиться» выбор по-прежнему из простого списка', () => {
    expect(read('ui', 'components', 'modals', 'chat', 'ChatForwardModal.tsx')).toContain('listGroups(pid)');
    expect(read('ui', 'screens', 'FeedScreen.tsx')).toContain('listGroups(pid)');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  // Срез честной ветки проверяется там же, где она сама: до правки его вырезать
  // не из чего, и здесь он был бы обещанием, которое блок не держит.
  it('снятие комментариев не съедает код', () => {
    expect(codeOnly('// Создайте группу или канал\nconst a = 1;')).toBe('const a = 1;');
    expect(codeOnly('const b = 2;')).toBe('const b = 2;');
  });
});
