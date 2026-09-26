/**
 * v4.32.998: отказ чтения шаблонов выдавался за «Нет быстрых ответов».
 *
 * Дефект. `listQuickReplies` ловила любой отказ — и запроса, и
 * `getOrCreateDataEncryptionKey` — и отдавала пустой список. Признак
 * `unreadable` у строки (v4.32.582) здесь не помогал: он про столбец, который
 * приехал и не открылся, а тут не приезжало ничего.
 *
 * Цена. Четыре места печатали приговор и звали завести шаблон заново:
 * вкладка «Ответ» во вложениях и два окна быстрых ответов — «Нет быстрых
 * ответов. Создайте их в Настройках → Быстрые ответы.» и «Нет шаблонов.
 * Добавьте в Настройки → Быстрые ответы.», — а сам редактор в настройках
 * открывался пустым с полем «Новый шаблон…». Человек писал второй такой же
 * поверх целого; когда чтение поправится, в списке будет два одинаковых
 * шаблона, и какой из них правили последним — уже не узнать.
 *
 * Правка. `listQuickRepliesRead` отвечает `null` на отказ, прежнее имя
 * осталось обёрткой `?? []`, а все четыре места отличают пустоту от отказа.
 *
 * Границы. Прочитанный пустой список остаётся пустым: «Нет быстрых ответов»
 * — правда, когда шаблонов и правда нет, и эта надпись не тронута. Пометка
 * про непрочитанный столбец (`UNREADABLE_TEMPLATE_TEXT`) тоже осталась на
 * своём месте — она про другое.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Строки quick_replies, какими их видит запрос. */
let mockRows: Array<{ id: string; text: string; owner_profile_id: number; created_at: number }> = [];
/** Отдаёт ли база строки шаблонов. */
let mockSelectFails = false;
/** Достаётся ли ключ данных. */
let mockDekFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async (sql: string) => {
      if (!/FROM quick_replies WHERE owner_profile_id = \?/i.test(sql)) return [];
      if (mockSelectFails) throw new Error('database is locked');
      return mockRows;
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

import { UNREADABLE_QUICK_REPLIES_TEXT, UNREADABLE_TEMPLATE_TEXT } from '../unreadableText';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Код без комментариев: объяснение рядом не должно закрывать собой проверку. */
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

const row = (id: string, text: string) => ({
  id,
  text: `enc2:${text}`,
  owner_profile_id: 1,
  created_at: 100,
});

beforeEach(() => {
  mockRows = [];
  mockSelectFails = false;
  mockDekFails = false;
});

describe('отказ чтения шаблонов больше не выдаётся за пустоту', () => {
  it('база не отдала строки — это null, а не пустой список', async () => {
    const { listQuickRepliesRead } = await import('../local');
    mockSelectFails = true;
    expect(await listQuickRepliesRead(1)).toBeNull();
  });

  it('ключ данных не достался — тоже отказ, а не пустота', async () => {
    const { listQuickRepliesRead } = await import('../local');
    mockRows = [row('a', 'привет')];
    mockDekFails = true;
    expect(await listQuickRepliesRead(1)).toBeNull();
  });

  it('шаблонов и правда нет — это пустой список, а не отказ', async () => {
    const { listQuickRepliesRead } = await import('../local');
    expect(await listQuickRepliesRead(1)).toEqual([]);
  });

  it('шаблоны на месте — приходят они же', async () => {
    const { listQuickRepliesRead } = await import('../local');
    mockRows = [row('a', 'привет'), row('b', 'буду через 10 минут')];
    const list = await listQuickRepliesRead(1);
    expect(list?.map((r) => r.text)).toEqual(['привет', 'буду через 10 минут']);
  });

  it('прежнее имя осталось и сводит отказ к пустому списку, как раньше', async () => {
    const { listQuickReplies } = await import('../local');
    mockSelectFails = true;
    expect(await listQuickReplies(1)).toEqual([]);
  });
});

describe('пометка про непрочитанный список', () => {
  it('своя строка, не про один столбец', () => {
    expect(UNREADABLE_QUICK_REPLIES_TEXT).toBe('Быстрые ответы не удалось прочитать');
    expect(UNREADABLE_QUICK_REPLIES_TEXT).not.toBe(UNREADABLE_TEMPLATE_TEXT);
  });
});

describe('четыре места шаблонов различают пустоту и отказ', () => {
  it('вкладка «Ответ» во вложениях', () => {
    const src = codeOnly(read('ui/components/AttachSheet.tsx'));
    expect(src).toContain('const list = await listQuickRepliesRead(profileId);');
    expect(src).toContain('if (list === null) setReadFailed(true);');
    expect(src).toContain('${UNREADABLE_QUICK_REPLIES_TEXT}. Шаблоны на месте — откройте вкладку заново.');
  });

  it('окно быстрых ответов в чате', () => {
    const modal = codeOnly(read('ui/components/modals/chat/ChatQuickRepliesModal.tsx'));
    expect(modal).toContain('readFailed?: boolean;');
    expect(modal).toContain('${UNREADABLE_QUICK_REPLIES_TEXT}. Шаблоны на месте — откройте окно заново.');
    const screen = codeOnly(read('ui/screens/ChatScreen.tsx'));
    expect(screen).toContain('void listQuickRepliesRead(activeProfileId).then((list) => {');
    expect(screen).toContain('setQuickRepliesReadFailed(list === null);');
    expect(screen).toContain('readFailed={quickRepliesReadFailed}');
  });

  it('окно быстрых ответов в группе', () => {
    const src = codeOnly(read('ui/components/modals/groups/GroupQuickRepliesModal.tsx'));
    expect(src).toContain('void listQuickRepliesRead(pid).then((list) => {');
    expect(src).toContain('setReadFailed(list === null);');
    expect(src).toContain('${UNREADABLE_QUICK_REPLIES_TEXT}. Шаблоны на месте — откройте окно заново.');
  });

  it('редактор шаблонов в настройках', () => {
    const src = codeOnly(read('ui/screens/SettingsScreen.tsx'));
    expect(src).toContain('void listQuickRepliesRead(profileManager.getActiveProfile()?.id ?? 1).then((list) => {');
    expect(src).toContain('setQuickRepliesReadFailed(list === null);');
    expect(src).toContain('{quickRepliesReadFailed ? (');
    expect(src).toContain('и новый лучше не заводить, пока список не прочитается.');
  });

  it('ни одно из четырёх больше не зовёт гасящий вход', () => {
    for (const rel of ['ui/components/AttachSheet.tsx',
                       'ui/screens/ChatScreen.tsx',
                       'ui/components/modals/groups/GroupQuickRepliesModal.tsx',
                       'ui/screens/SettingsScreen.tsx']) {
      expect(codeOnly(read(rel))).not.toMatch(/[^a-zA-Z]listQuickReplies\(/);
    }
  });
});

describe('ГРАНИЦА: прочитанная пустота называется своими словами', () => {
  it('прежние надписи никуда не делись', () => {
    expect(read('ui/components/AttachSheet.tsx'))
      .toContain('Нет быстрых ответов. Создайте их в Настройках → Быстрые ответы.');
    for (const rel of ['ui/components/modals/chat/ChatQuickRepliesModal.tsx',
                       'ui/components/modals/groups/GroupQuickRepliesModal.tsx']) {
      expect(read(rel)).toContain('Нет шаблонов. Добавьте в Настройки → Быстрые ответы.');
    }
  });

  it('пометка про непрочитанный столбец осталась на своём месте', () => {
    expect(read('ui/screens/SettingsScreen.tsx'))
      .toContain('{templateReadable(qr) ? qr.text : UNREADABLE_TEMPLATE_TEXT}');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('редактор шаблонов и правда предлагает завести новый', () => {
    const src = read('ui/screens/SettingsScreen.tsx');
    expect(src).toContain("placeholder=\"Новый шаблон…\"");
    expect(src).toContain('void addQuickReply(profileManager.getActiveProfile()?.id ?? 1, text)');
  });

  it('счётчик шаблонов в меню исчезает на пустом списке', () => {
    const src = read('ui/screens/SettingsScreen.tsx');
    expect(src).toContain('quickReplies.length > 0');
    expect(src).toContain(': undefined');
  });

  it('признак unreadable у строки — про другое и потому не спасал', () => {
    const local = read('core/storage/local.ts');
    expect(local).toContain('unreadable: unreadableFromCellState(cell.state),');
    expect(local).toContain("log.warn('list_quick_replies_failed'");
  });
});

// Блок зовёт только прежнее имя — оно было и до правки, поэтому проверка
// держится на обеих версиях кода и говорит про мок, а не про правку.
describe('ПРОВЕРКА НЕ ПУСТАЯ: мок и правда отвечает на запрос шаблонов', () => {
  it('без отказов строки доезжают, и счёт совпадает', async () => {
    const { listQuickReplies } = await import('../local');
    mockRows = [row('a', 'один'), row('b', 'два'), row('c', 'три')];
    expect((await listQuickReplies(1)).map((r) => r.text)).toEqual(['один', 'два', 'три']);
  });

  it('отказ подделать нечем: он и правда приходит из запроса', async () => {
    const { listQuickReplies } = await import('../local');
    mockRows = [row('a', 'один')];
    mockSelectFails = true;
    expect(await listQuickReplies(1)).toEqual([]);
    mockSelectFails = false;
    expect((await listQuickReplies(1)).length).toBe(1);
  });

  it('и ключ данных тоже спрашивают по-настоящему', async () => {
    const { listQuickReplies } = await import('../local');
    mockRows = [row('a', 'один')];
    mockDekFails = true;
    expect(await listQuickReplies(1)).toEqual([]);
    mockDekFails = false;
    expect((await listQuickReplies(1)).length).toBe(1);
  });
});
