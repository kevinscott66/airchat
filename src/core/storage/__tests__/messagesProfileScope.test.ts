/**
 * v4.32.519 — рэтчет: сообщение принадлежит аккаунту, а не установке.
 *
 * Дефект: у chat_messages и group_messages первичным ключом был один `id`.
 * Идентификатор сообщения назначает отправитель — он уникален у него, а не на
 * нашем телефоне. Профили одной установки при этом разные люди с разными
 * ключами, и общий канал, общая группа или одна резервная копия, развёрнутая
 * в оба аккаунта, приводили к столкновению идентификаторов. Наружу это
 * выходило так:
 *  - `INSERT OR IGNORE` во втором профиле молча не делал ничего — сообщения в
 *    переписке просто не было, без ошибки и без строки в журнале;
 *  - `INSERT OR REPLACE` сносил строку первого профиля целиком, вместе со
 *    статусом доставки, звёздочкой и реакциями;
 *  - `ON CONFLICT (id)` в синхронизации переписывал соседскую строку и менял
 *    ей `owner_profile_id` — сообщение переезжало в чужой аккаунт;
 *  - отсев повторов на приёме спрашивал про весь телефон, поэтому конверт,
 *    уже сохранённый первым аккаунтом, для второго считался повтором и
 *    отбрасывался до расшифровки.
 *
 * Составной ключ чинит первые три случая сам собой. Четвёртый и всё, что
 * адресует строку одним id (удаление, разовые проходы по базе, уборка
 * служебных конвертов), приходится чинить руками — за этим здесь и следим.
 */
import * as fs from 'fs';
import * as path from 'path';

const LOCAL = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
const MESSAGING = fs.readFileSync(
  path.join(__dirname, '..', '..', 'social', 'messaging.ts'),
  'utf8',
);
const LIVE_SYNC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'sync', 'liveAccountSync.ts'),
  'utf8',
);

/** Тело функции: от строки объявления до первой закрывающей `}` в 0-й колонке. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const lines = source.slice(start).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i > 0 && lines[i] === '}') break;
  }
  return out.join('\n');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function slice(from: string, to: string): string {
  const a = LOCAL.indexOf(from);
  const b = LOCAL.indexOf(to);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return LOCAL.slice(a, b);
}

const MIGRATION = bodyOf(LOCAL, 'async function ensureMessageTableCompositeKey(');

describe('проверка не пустая', () => {
  it('bodyOf вырезает именно одну функцию', () => {
    expect(MIGRATION).toContain('ensureMessageTableCompositeKey');
    expect(MIGRATION).not.toContain('async function ensureGroupMemberNamesEncrypted(');
    expect(MIGRATION.trimEnd().endsWith('}')).toBe(true);
  });
});

describe('схема: ключ сообщения — пара с профилем', () => {
  const chat = slice(
    'CREATE TABLE IF NOT EXISTS chat_messages (',
    'CREATE TABLE IF NOT EXISTS conversations (',
  );
  const group = slice(
    'CREATE TABLE IF NOT EXISTS group_messages (',
    'CREATE TABLE IF NOT EXISTS stories (',
  );

  it('таблицы найдены целиком', () => {
    expect(chat).toContain('contact_pub_b64 TEXT NOT NULL');
    expect(chat).toContain('reply_to_preview TEXT');
    expect(group).toContain('sender_pub_b64 TEXT NOT NULL');
    expect(group).toContain('created_at INTEGER NOT NULL');
  });

  it('id сам по себе больше не первичный ключ', () => {
    expect(chat).toContain('id TEXT NOT NULL,');
    expect(chat).not.toContain('id TEXT PRIMARY KEY');
    expect(group).toContain('id TEXT NOT NULL,');
    expect(group).not.toContain('id TEXT PRIMARY KEY');
  });

  it('ключ обеих таблиц — (id, owner_profile_id)', () => {
    expect(chat).toContain('PRIMARY KEY (id, owner_profile_id)');
    expect(group).toContain('PRIMARY KEY (id, owner_profile_id)');
  });

  it('WITHOUT ROWID не появился: по rowid ходят перешифровка и уборка', () => {
    expect(chat).not.toContain('WITHOUT ROWID');
    expect(group).not.toContain('WITHOUT ROWID');
    expect(LOCAL).toContain('UPDATE ${spec.table} SET ${sets.join(\', \')} WHERE rowid = ?');
  });
});

describe('индекс переписки знает про профиль', () => {
  it('в индексе есть owner_profile_id, и он стоит до created_at', () => {
    for (const idx of [
      'ON chat_messages (contact_pub_b64, owner_profile_id, created_at DESC)',
      'ON group_messages (group_id, owner_profile_id, created_at DESC)',
    ]) {
      expect(LOCAL).toContain(idx);
    }
  });

  it('старые индексы убираются явно: IF NOT EXISTS их бы не переопределил', () => {
    expect(LOCAL).toContain('DROP INDEX IF EXISTS idx_chat_contact;');
    expect(LOCAL).toContain('DROP INDEX IF EXISTS idx_grp_msg;');
    expect(LOCAL).not.toContain('ON chat_messages (contact_pub_b64, created_at DESC)');
    expect(LOCAL).not.toContain('ON group_messages (group_id, created_at DESC)');
  });
});

describe('миграция: четыре состояния диска после обрыва', () => {
  it('уже переехали — выходим, ничего не трогая', () => {
    expect(MIGRATION).toContain('PRAGMA table_info(${table})');
    expect(MIGRATION).toContain("if (pkCols.includes('owner_profile_id')) return;");
  });

  it('обрыв между DROP и RENAME — доименовываем, а не теряем переписку', () => {
    expect(MIGRATION).toContain('ALTER TABLE ${tmp} RENAME TO ${table};');
    expect(MIGRATION).toContain('messages_migrate_recovered_from_rename_gap');
  });

  it('после доименования индекс восстанавливается: он ушёл вместе с таблицей', () => {
    const gap = MIGRATION.slice(
      MIGRATION.indexOf('ALTER TABLE ${tmp} RENAME TO ${table};'),
      MIGRATION.indexOf('messages_migrate_recovered_from_rename_gap'),
    );
    expect(gap).toContain('await database.execAsync(index);');
  });

  it('чистая установка — выходим молча', () => {
    expect(MIGRATION).toContain('return; // чистая установка');
  });

  it('пересборка целиком в одной транзакции и в правильном порядке', () => {
    const begin = MIGRATION.indexOf('BEGIN IMMEDIATE;');
    const commit = MIGRATION.indexOf('COMMIT;');
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(begin);
    const tx = MIGRATION.slice(begin, commit);
    const steps = [
      'CREATE TABLE IF NOT EXISTS ${tmp} (',
      'INSERT INTO ${tmp} (${names}) SELECT ${names} FROM ${table};',
      'DROP TABLE ${table};',
      'ALTER TABLE ${tmp} RENAME TO ${table};',
      '${index}',
    ];
    const at = steps.map((step) => tx.indexOf(step));
    expect(at.filter((i) => i < 0)).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('ошибка внутри — откат, а не полутаблица', () => {
    expect(MIGRATION).toContain('ROLLBACK;');
    expect(MIGRATION).toContain('messages_migrate_failed');
  });

  it('перелив без OR IGNORE: потерянное сообщение не должно быть тихим', () => {
    expect(MIGRATION).toContain('INSERT INTO ${tmp}');
    expect(MIGRATION).not.toContain('INSERT OR IGNORE INTO ${tmp}');
  });

  it('список колонок берётся у базы, а не пишется руками', () => {
    expect(MIGRATION).toContain('getAllAsync<ColumnInfo>(`PRAGMA table_info(${table})`)');
    expect(MIGRATION).toContain('rebuildColumns(cols');
    // Колонки, добавленные поздними ALTER TABLE. Появление любой из них здесь
    // означало бы, что перечень снова переписан руками — и следующая колонка
    // при переезде потеряется.
    for (const late of ['edited_at', 'starred', 'view_count', 'seen_by', 'reply_to_preview']) {
      expect(MIGRATION).not.toContain(late);
    }
  });
});

describe('одна пересборка на две таблицы', () => {
  it('обе обёртки зовут общее тело', () => {
    expect(count(LOCAL, 'await ensureMessageTableCompositeKey(database, {')).toBe(2);
    for (const t of ["table: 'chat_messages',", "table: 'group_messages',"]) {
      expect(LOCAL).toContain(t);
    }
  });

  it('каждая вызывается ровно один раз при открытии базы', () => {
    expect(count(LOCAL, 'await ensureChatMessagesProfileScopedKey(database);')).toBe(1);
    expect(count(LOCAL, 'await ensureGroupMessagesProfileScopedKey(database);')).toBe(1);
  });

  it('до разового шифрования реакций: тот правит строки по ключу', () => {
    const chain = LOCAL.slice(LOCAL.indexOf('await ensureGroupMembersProfileScoped(database);'));
    const keyAt = chain.indexOf('await ensureChatMessagesProfileScopedKey(database);');
    const socialAt = chain.indexOf('await ensureMessageSocialColumnsEncrypted(database);');
    expect(keyAt).toBeGreaterThan(-1);
    expect(socialAt).toBeGreaterThan(keyAt);
  });
});

describe('отсев повторов спрашивает про свой аккаунт', () => {
  const body = bodyOf(LOCAL, 'export async function chatMessageExists(');

  it('профиль в подписи обязателен', () => {
    expect(LOCAL).toContain(
      'export async function chatMessageExists(id: string, ownerProfileId: number)',
    );
  });

  it('и попадает в сам запрос', () => {
    expect(body).toContain('WHERE id = ? AND owner_profile_id = ? LIMIT 1');
    expect(body).not.toContain('WHERE id = ? LIMIT 1');
  });

  it('приём конвертов передаёт свой профиль', () => {
    expect(MESSAGING).toContain(
      'if (await chatMessageExists(em.messageId, await this.ownerProfileId())) return;',
    );
    expect(MESSAGING).not.toContain('chatMessageExists(em.messageId)');
  });
});

describe('удаление сообщения — только своя строка', () => {
  const body = bodyOf(LOCAL, 'export async function deleteChatMessage(');

  it('профиль стал обязательным аргументом', () => {
    expect(LOCAL).toContain(
      'export async function deleteChatMessage(id: string, ownerProfileId: number)',
    );
    expect(LOCAL).not.toContain('deleteChatMessage(id: string, ownerProfileId?: number)');
  });

  it('ветки «по одному id» больше нет', () => {
    expect(body).not.toContain("'DELETE FROM chat_messages WHERE id = ?'");
    expect(body).not.toContain('ownerProfileId === undefined');
  });

  it('и вложения ищутся тоже в своём профиле', () => {
    expect(body).toContain(
      "'SELECT text, media_cids FROM chat_messages WHERE id = ? AND owner_profile_id = ?'",
    );
  });
});

describe('синхронизация группового сообщения', () => {
  const body = bodyOf(LOCAL, 'export async function applySyncGroupMessage(');

  it('столкновение разрешается по паре, а не по id', () => {
    expect(body).toContain('ON CONFLICT (id, owner_profile_id) DO UPDATE SET');
    expect(body).not.toContain('ON CONFLICT (id) DO UPDATE SET');
  });

  it('владелец строки не переписывается: он теперь часть ключа', () => {
    expect(body).not.toContain('owner_profile_id = excluded.owner_profile_id');
  });
});

describe('импорт строк переписки знает, чьи они', () => {
  it('профиль можно назвать явно', () => {
    expect(LOCAL).toContain('export async function importRawChatMessageRows(\n  input: unknown,\n  ownerProfileId?: number,\n)');
    expect(LOCAL).toContain('const expectedPid = ownerProfileId');
  });

  it('живая синхронизация его и называет — как соседние ветки того же switch', () => {
    expect(LIVE_SYNC).toContain('mutation.ownerProfileId,\n      )) !== 1) {');
    expect(LIVE_SYNC).not.toContain('importRawChatMessageRows([entity.value as RawChatMessageRow])');
  });
});

describe('разовые проходы адресуют строку однозначно', () => {
  it('перевод переписки в шифртекст идёт по rowid', () => {
    const body = bodyOf(LOCAL, 'async function ensureLocalCryptoMigration(');
    expect(body).toContain("'SELECT rowid, text, media_cids FROM chat_messages'");
    expect(body).toContain("'UPDATE chat_messages SET text = ?, media_cids = ? WHERE rowid = ?'");
    expect(body).not.toContain("SET text = ?, media_cids = ? WHERE id = ?");
  });

  it('шифрование реакций переписки ключуется парой — как у групповых', () => {
    const body = bodyOf(LOCAL, 'function ensureMessageSocialColumnsEncrypted(');
    expect(body).toContain(
      "{ table: 'chat_messages', column: 'reactions', keys: ['id', 'owner_profile_id'] },",
    );
    expect(body).not.toContain("keys: ['id'] }");
  });
});

describe('уборка служебных конвертов не задевает соседний аккаунт', () => {
  const body = bodyOf(LOCAL, 'export async function purgeControlEnvelopeMessages(');

  it('строки помечаются rowid, а не id', () => {
    expect(body).toContain('const doomed: number[] = [];');
    expect(body).toContain('doomed.push(r.rowid);');
    expect(body).not.toContain('doomed.push(r.id);');
  });

  it('и удаляются по rowid', () => {
    expect(body).toContain('DELETE FROM chat_messages WHERE rowid IN (${marks})');
    expect(body).not.toContain('DELETE FROM chat_messages WHERE id IN (${marks})');
  });

  it('пакет по-прежнему читается по всем профилям — это уборка на весь телефон', () => {
    expect(body).toContain('FROM chat_messages WHERE rowid > ? ORDER BY rowid LIMIT 500');
  });
});

describe('намеренно общие запросы остались общими', () => {
  it('сброс зависших «отправляется» — на весь телефон', () => {
    expect(LOCAL).toContain(
      "UPDATE chat_messages SET status = 'failed' WHERE status = 'sending' AND created_at < ?",
    );
  });

  it('живые ссылки на вложения собираются по всем профилям: кэш один на установку', () => {
    expect(LOCAL).toContain("'SELECT text, media_cids FROM chat_messages',");
    expect(LOCAL).toContain("'SELECT text, media_cids FROM group_messages',");
  });
});
