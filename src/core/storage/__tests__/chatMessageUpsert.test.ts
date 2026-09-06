/**
 * Сохранение сообщения не должно стирать то, чего нет в списке колонок.
 *
 * Проверка поведенческая: оператор берётся прямо из local.ts и выполняется на
 * настоящем SQLite (node:sqlite) поверх схемы chat_messages со всеми колонками,
 * которые доросли до неё миграциями. Сторож на текст здесь бесполезен — вопрос
 * ровно в том, что SQLite делает с колонкой, которую оператор не назвал.
 */
import { readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'local.ts'), 'utf8');

/** Оператор из тела названной функции: от `INSERT` до закрывающей обратной кавычки. */
function statementIn(fn: string): string {
  const at = SRC.indexOf(`export async function ${fn}(`);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = SRC.indexOf('`INSERT INTO chat_messages', at);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf('`', start + 1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start + 1, end);
}

/** Схема таблицы вместе с колонками, добавленными миграциями 490/514/517/587/610. */
function freshDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE chat_messages (
      id TEXT NOT NULL,
      contact_pub_b64 TEXT NOT NULL,
      cid TEXT,
      text TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      media_cids TEXT,
      created_at INTEGER NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      reply_to_id TEXT,
      reply_to_preview TEXT,
      edited_at INTEGER,
      reactions TEXT,
      forwarded_from TEXT,
      starred INTEGER NOT NULL DEFAULT 0,
      transport TEXT,
      PRIMARY KEY (id, owner_profile_id)
    );
  `);
  d.exec(`
    INSERT INTO chat_messages
      (id, contact_pub_b64, cid, text, direction, status, media_cids, created_at,
       owner_profile_id, reply_to_id, reply_to_preview, edited_at, reactions,
       forwarded_from, starred, transport)
    VALUES ('m1', 'peerA', 'cid-old', 'правленый текст', 'out', 'sent', NULL, 1000,
            1, NULL, NULL, 1500, '{"👍":["did:key:zB"]}', 'did:key:zC', 1, 'lan');
  `);
  return d;
}

type Row = {
  text: string; status: string; transport: string | null;
  reactions: string | null; edited_at: number | null;
  starred: number; forwarded_from: string | null;
};

function readRow(d: DatabaseSync): Row {
  return d.prepare('SELECT * FROM chat_messages WHERE id = ? AND owner_profile_id = ?').get('m1', 1) as unknown as Row;
}

describe('повторное сохранение сообщения', () => {
  it('upsertChatMessage не трогает реакции, «Избранное», метку правки и пересылку', () => {
    const d = freshDb();
    d.prepare(statementIn('upsertChatMessage')).run(
      'm1', 'peerA', 'cid-new', 'текст из очереди', 'out', 'delivered', null, 1000, 1, null, null, 'internet',
    );
    const row = readRow(d);
    // Перечисленное — обновилось.
    expect(row.status).toBe('delivered');
    expect(row.text).toBe('текст из очереди');
    expect(row.transport).toBe('internet');
    // Неперечисленное — уцелело.
    expect(row.reactions).toBe('{"👍":["did:key:zB"]}');
    expect(row.edited_at).toBe(1500);
    expect(row.starred).toBe(1);
    expect(row.forwarded_from).toBe('did:key:zC');
    d.close();
  });

  it('importRawChatMessageRows не трогает их же, включая маршрут', () => {
    const d = freshDb();
    d.prepare(statementIn('importRawChatMessageRows')).run(
      'm1', 'peerA', 'cid-restored', 'текст из копии', 'out', 'sent', null, 1000, 1, null, null,
    );
    const row = readRow(d);
    expect(row.text).toBe('текст из копии');
    expect(row.reactions).toBe('{"👍":["did:key:zB"]}');
    expect(row.edited_at).toBe(1500);
    expect(row.starred).toBe(1);
    expect(row.forwarded_from).toBe('did:key:zC');
    expect(row.transport).toBe('lan');
    d.close();
  });

  it('строка другого профиля остаётся отдельной строкой', () => {
    const d = freshDb();
    d.prepare(statementIn('upsertChatMessage')).run(
      'm1', 'peerA', 'cid-p2', 'сообщение второго профиля', 'in', 'sent', null, 2000, 2, null, null, 'lan',
    );
    expect((d.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n).toBe(2);
    expect(readRow(d).reactions).toBe('{"👍":["did:key:zB"]}');
    d.close();
  });

  it('в chat_messages не осталось ни одного INSERT OR REPLACE', () => {
    // REPLACE — это снос строки: любая колонка, не названная в списке,
    // возвращается к значению по умолчанию.
    expect(SRC).not.toMatch(/INSERT OR REPLACE INTO chat_messages/);
  });
});
