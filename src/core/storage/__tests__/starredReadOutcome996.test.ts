/**
 * v4.32.996: «Нет избранных сообщений» говорилось и тогда, когда избранное
 * не смогли прочитать.
 *
 * Дефект. `listStarredMessages` делает три запроса — личные сообщения,
 * групповые и названия групп — и следом берёт ключ данных. Всё это стояло в
 * одном `try`, а `catch` писал строчку в журнал и возвращал `[]`. Пустой
 * список приходил на четыре экрана, и каждый отвечал на него утверждением:
 * «Нет избранных сообщений» в окне чата, в окне группы и в листе профиля,
 * «Здесь пусто. Отмеченные звёздочкой сообщения собираются сюда» — на панели
 * профиля.
 *
 * Цена. Избранное собирают годами и держат вместо закладок: договорённости,
 * адреса, пароль от домофона. Ничего из этого человек не восстановит по
 * памяти — он не помнит, какие сообщения отмечал, а значит и не заметит, что
 * список неполон. Сносить отметки экраны не предлагают, поэтому диск цел; ложь
 * здесь ровно про то, ради чего он сюда и зашёл.
 *
 * Правка. Появился `listStarredMessagesRead`: список либо `null`. Прежнее имя
 * осталось обёрткой `?? []` — оно нужно тем, кому список достаточен. Все
 * четыре экрана перешли на новую и под пустым списком говорят «Избранное не
 * удалось прочитать. Отметки на месте — откройте список заново».
 *
 * Границы. Прочитанное пустое избранное по-прежнему отвечает «Нет избранных
 * сообщений»: это правда, и она не изменилась.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Отмеченные личные сообщения, какими их видит запрос. */
let mockChatRows: Array<Record<string, unknown>> = [];
/** Отмеченные групповые сообщения. */
let mockGroupRows: Array<Record<string, unknown>> = [];
/** Строки groups для карты названий. */
let mockGroupNames: Array<{ id: string; name: string }> = [];
/** Какое из трёх чтений отказывает. */
let mockFailing: 'none' | 'chat' | 'group' | 'names' = 'none';
/** Ключ данных не достаётся. */
let mockDekFails = false;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async (sql: string) => {
      if (/FROM chat_messages WHERE owner_profile_id = \? AND starred = 1/i.test(sql)) {
        if (mockFailing === 'chat') throw new Error('disk i/o error');
        return mockChatRows;
      }
      if (/FROM group_messages WHERE owner_profile_id = \? AND starred = 1/i.test(sql)) {
        if (mockFailing === 'group') throw new Error('disk i/o error');
        return mockGroupRows;
      }
      if (/SELECT id, name FROM groups WHERE owner_profile_id = \?/i.test(sql)) {
        if (mockFailing === 'names') throw new Error('disk i/o error');
        return mockGroupNames;
      }
      return [];
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
  const decode = (v: string): string | null =>
    v.startsWith('enc2:') ? v.slice('enc2:'.length) : v;
  return {
    AT_REST_PREFIX: 'enc2:',
    AT_REST_COLUMNS: [],
    DEK_KEY: 'dek',
    getOrCreateDataEncryptionKey: jest.fn(async () => {
      if (mockDekFails) throw new Error('keychain unavailable');
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

/** Отмеченное личное сообщение. */
function chatRow(id: string, text: string, createdAt: number): Record<string, unknown> {
  return {
    id, contact_pub_b64: 'peerAAAAAAAA', cid: null, text: `enc2:${text}`,
    direction: 'in', status: 'received', media_cids: null, created_at: createdAt,
    owner_profile_id: 1, reply_to_id: null, reply_to_preview: null,
    edited_at: null, reactions: null,
  };
}

/** Отмеченное групповое сообщение. */
function groupRow(id: string, text: string, createdAt: number): Record<string, unknown> {
  return {
    id, group_id: 'grp-12345678', sender_pub_b64: 'senderAAAAAA', sender_name: null,
    text: `enc2:${text}`, media_cids: null, reply_to_id: null, reply_to_preview: null,
    reactions: null, created_at: createdAt, owner_profile_id: 1, edited_at: null,
  };
}

const src = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

/**
 * Только код: закомментированное объяснение не должно закрывать собой пин.
 */
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** Одно место файла — чтобы совпадение не прилетело от соседа. */
function slice(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
}

beforeEach(() => {
  mockChatRows = [];
  mockGroupRows = [];
  mockGroupNames = [];
  mockFailing = 'none';
  mockDekFails = false;
});

describe('отказ чтения избранного больше не выдаётся за пустоту', () => {
  it('личные сообщения не прочитались — список не пустой, а неизвестный', async () => {
    const { listStarredMessagesRead } = await import('../local');
    mockFailing = 'chat';
    expect(await listStarredMessagesRead(1)).toBeNull();
  });

  it('групповые сообщения не прочитались — тоже отказ', async () => {
    const { listStarredMessagesRead } = await import('../local');
    mockFailing = 'group';
    expect(await listStarredMessagesRead(1)).toBeNull();
  });

  it('названия групп не прочитались — отказ, а не избранное без групп', async () => {
    const { listStarredMessagesRead } = await import('../local');
    mockFailing = 'names';
    expect(await listStarredMessagesRead(1)).toBeNull();
  });

  it('ключ данных не достался — отказ, а не пустое избранное', async () => {
    const { listStarredMessagesRead } = await import('../local');
    mockChatRows = [chatRow('m1', 'адрес', 100)];
    mockDekFails = true;
    expect(await listStarredMessagesRead(1)).toBeNull();
  });

  it('звёздочкой и правда ничего не отмечено — это пустой список, а не отказ', async () => {
    const { listStarredMessagesRead } = await import('../local');
    const read = await listStarredMessagesRead(1);
    expect(read).toEqual([]);
    expect(read).not.toBeNull();
  });

  it('отмеченное читается целиком, из обеих таблиц, новое сверху', async () => {
    const { listStarredMessagesRead } = await import('../local');
    mockChatRows = [chatRow('m1', 'код домофона', 100)];
    mockGroupRows = [groupRow('g1', 'адрес дачи', 300)];
    mockGroupNames = [{ id: 'grp-12345678', name: 'enc2:Семья' }];
    const read = await listStarredMessagesRead(1);
    expect(read).not.toBeNull();
    expect(read?.map((e) => e.message.id)).toEqual(['g1', 'm1']);
    expect(read?.[0].contextName).toBe('Семья');
    expect(read?.[1].message.text).toBe('код домофона');
  });
});

describe('пометка про непрочитанное избранное', () => {
  it('текст есть и говорит про избранное, а не про ошибку записи', async () => {
    const { UNREADABLE_STARRED_TEXT } = await import('../unreadableText');
    expect(UNREADABLE_STARRED_TEXT).toBe('Избранное не удалось прочитать');
  });
});

describe('четыре экрана избранного различают пустоту и отказ', () => {
  it('панель профиля: «Здесь пусто» только после удавшегося чтения', () => {
    const pane = codeOnly(src('ui/components/modals/profile/ProfileStarredPane.tsx'));
    expect(pane).toContain('listStarredMessagesRead(ownerProfileId)');
    expect(pane).toContain('if (all === null) {');
    expect(pane).toContain('setReadFailed(true);');
    const empty = slice(pane, '{readFailed', 'Читаем…');
    expect(empty).toContain('UNREADABLE_STARRED_TEXT');
    expect(empty).toContain('Здесь пусто.');
  });

  it('лист профиля: отказ не выдаётся за «Нет избранных сообщений»', () => {
    const screen = codeOnly(src('ui/screens/ProfileScreen.tsx'));
    expect(screen).toContain('listStarredMessagesRead(pid).then((entries) => {');
    expect(screen).toContain('setStarredReadFailed(entries === null);');
    expect(screen).toContain('if (entries !== null) setStarredEntries(entries);');
    const empty = slice(screen, '{starredReadFailed', 'Нет избранных сообщений');
    expect(empty).toContain('UNREADABLE_STARRED_TEXT');
  });

  it('окно чата: признак отказа доезжает до окна', () => {
    const modal = codeOnly(src('ui/components/modals/chat/ChatStarredModal.tsx'));
    expect(modal).toContain('readFailed?: boolean;');
    expect(modal).toContain('readFailed = false');
    const empty = slice(modal, '{readFailed', 'Нет избранных сообщений');
    expect(empty).toContain('UNREADABLE_STARRED_TEXT');

    const chat = codeOnly(src('ui/screens/ChatScreen.tsx'));
    expect(chat).toContain('listStarredMessagesRead,');
    expect(chat).toContain('setStarredReadFailed(entries === null);');
    expect(chat).toContain('readFailed={starredReadFailed}');
    // Три двери в избранное — одно правило на все.
    expect(chat.split('listStarredMessagesRead(activeProfileId)').length - 1).toBe(3);
  });

  it('окно группы: признак отказа доезжает до окна', () => {
    const modal = codeOnly(src('ui/components/modals/groups/GroupStarredModal.tsx'));
    expect(modal).toContain('readFailed?: boolean;');
    expect(modal).toContain('readFailed = false');
    const empty = slice(modal, '{readFailed', 'Нет избранных сообщений');
    expect(empty).toContain('UNREADABLE_STARRED_TEXT');

    const groups = codeOnly(src('ui/screens/GroupsScreen.tsx'));
    expect(groups).toContain('listStarredMessagesRead(pid).then((entries) => {');
    expect(groups).toContain('setStarredReadFailed(entries === null);');
    expect(groups).toContain('readFailed={starredReadFailed}');
  });
});

describe('ГРАНИЦА: короткое имя по-прежнему отдаёт просто список', () => {
  it('listStarredMessages на отказе отвечает пустым списком, как и раньше', async () => {
    const { listStarredMessages } = await import('../local');
    mockFailing = 'chat';
    expect(await listStarredMessages(1)).toEqual([]);
  });

  it('и на удавшемся чтении отдаёт то же, что и раньше', async () => {
    const { listStarredMessages } = await import('../local');
    mockChatRows = [chatRow('m1', 'пароль от вай-фая', 100)];
    const list = await listStarredMessages(1);
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('chat');
    expect(list[0].message.text).toBe('пароль от вай-фая');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('прочитанная пустота по-прежнему называется пустотой на всех четырёх экранах', () => {
    expect(src('ui/components/modals/chat/ChatStarredModal.tsx')).toContain('Нет избранных сообщений');
    expect(src('ui/components/modals/groups/GroupStarredModal.tsx')).toContain('Нет избранных сообщений');
    expect(src('ui/screens/ProfileScreen.tsx')).toContain('Нет избранных сообщений');
    expect(src('ui/components/modals/profile/ProfileStarredPane.tsx'))
      .toContain('Здесь пусто. Отмеченные звёздочкой сообщения собираются сюда.');
  });

  it('три чтения и ключ данных всё так же стоят под одним try — цена промаха не выдумана', () => {
    const local = src('core/storage/local.ts');
    // Срез берётся от заголовка раздела, а не от имени функции: раздел стоял
    // на месте и до правки, и блок обязан держаться на обеих версиях.
    const body = slice(local, '// ─── Starred messages', 'list_starred_messages_failed');
    expect(body).toContain('FROM chat_messages WHERE owner_profile_id = ? AND starred = 1');
    expect(body).toContain('FROM group_messages WHERE owner_profile_id = ? AND starred = 1');
    expect(body).toContain('SELECT id, name FROM groups WHERE owner_profile_id = ?');
    expect(body).toContain('await getOrCreateDataEncryptionKey()');
  });

  it('снимать отметки экраны избранного не предлагают — диск цел, врут только слова', () => {
    const local = src('core/storage/local.ts');
    expect(local).toContain("await d.runAsync('UPDATE chat_messages SET starred = ? WHERE id = ? AND owner_profile_id = ?'");
    expect(local).toContain("await d.runAsync('UPDATE group_messages SET starred = ? WHERE id = ? AND owner_profile_id = ?'");
    expect(codeOnly(src('ui/components/modals/profile/ProfileStarredPane.tsx'))).not.toContain('setMessageStarred');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: мок и правда отвечает на три запроса', () => {
  it('без отказов читаются обе таблицы и карта названий', async () => {
    const { listStarredMessages } = await import('../local');
    mockChatRows = [chatRow('m1', 'раз', 100)];
    mockGroupRows = [groupRow('g1', 'два', 200)];
    mockGroupNames = [{ id: 'grp-12345678', name: 'enc2:Работа' }];
    const list = await listStarredMessages(1);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.kind === 'group')?.contextName).toBe('Работа');
  });

  it('непрочитанное имя группы уходит на короткий id, а не на пустую строку', async () => {
    const { listStarredMessages } = await import('../local');
    mockGroupRows = [groupRow('g1', 'три', 200)];
    mockGroupNames = [{ id: 'grp-12345678', name: 'enc2:' }];
    const list = await listStarredMessages(1);
    expect(list[0].contextName).toBe('grp-1234');
  });
});
