/**
 * Исход отправки не воскрешает удалённое и не откатывает правку (v4.32.833).
 *
 * Дефект. Отправка кладёт свою строку в переписку ДО сети, а по исходу
 * переписывала её целиком — тем же `upsertChatMessageChecked` и снимком
 * `pending`, снятым до сети. Снимок хранит текст, время и цитату. Между ним и
 * записью проходит вся отправка: публикация с повторами, затем объявление
 * ссылки по каналам; на плохой сети это десятки секунд, и всё это время
 * сообщение лежит в переписке со своим обычным меню.
 *
 * Цена. Удалили его за эти секунды — перезапись вставляет строку заново:
 * «удалить у всех» ушло, у собеседника пусто, а у себя сообщение вернулось
 * живым и «доставлено». Исправили текст — перезапись возвращает прежний, а
 * `edited_at` в списке DO UPDATE нет (это проверено соседним
 * chatMessageUpsert), и подпись «изменено» остаётся: в пузыре прежний текст с
 * пометкой о правке. Убранные из сообщения адрес или сумма встают на место
 * сами.
 *
 * Проверка поведенческая: оба оператора берутся прямо из local.ts и
 * выполняются на настоящем SQLite (node:sqlite) поверх схемы chat_messages.
 * Сторож на текст тут бесполезен — вопрос ровно в том, что SQLite делает со
 * строкой, которой уже нет, и с колонкой, которую оператор не назвал.
 */
import { readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'local.ts'), 'utf8');
const MESSAGING = (): string =>
  readFileSync(join(__dirname, '..', '..', 'social', 'messaging.ts'), 'utf8');

/** Оператор из тела названной функции: от заголовка до закрывающей кавычки. */
function statementIn(fn: string, head: string): string {
  const at = SRC.indexOf(`export async function ${fn}(`);
  expect(at).toBeGreaterThanOrEqual(0);
  const q = SRC.indexOf(head, at);
  expect(q).toBeGreaterThanOrEqual(0);
  const quote = SRC[q];
  const end = SRC.indexOf(quote, q + 1);
  expect(end).toBeGreaterThan(q);
  return SRC.slice(q + 1, end);
}

const DELIVERY = (): string =>
  statementIn('markChatMessageDeliveredChecked', '`UPDATE chat_messages SET cid = ?');
const UPSERT = (): string => statementIn('upsertChatMessageChecked', '`INSERT INTO chat_messages');

const SCHEMA = `
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
  )`;

const INSERT_ROW = `
  INSERT INTO chat_messages
    (id, contact_pub_b64, cid, text, direction, status, media_cids, created_at,
     owner_profile_id, reply_to_id, reply_to_preview, edited_at, reactions,
     forwarded_from, starred, transport)
  VALUES (?, ?, NULL, ?, 'out', ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL)`;

/** База со схемой и строкой, которую отправка положила ДО сети. */
function freshDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.prepare(SCHEMA).run();
  d.prepare(INSERT_ROW).run('m1', 'peerA', 'счёт 1234 5678', 'sending', 1000, 1);
  return d;
}

type Row = {
  text: string; status: string; cid: string | null; transport: string | null;
  edited_at: number | null; reactions: string | null; starred: number;
};

const readRow = (d: DatabaseSync, pid = 1): Row | undefined =>
  d.prepare('SELECT * FROM chat_messages WHERE id = ? AND owner_profile_id = ?').get('m1', pid) as
    | unknown as Row | undefined;

const countRows = (d: DatabaseSync): number =>
  (d.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n;

const drop = (d: DatabaseSync): void => {
  d.prepare('DELETE FROM chat_messages WHERE id = ? AND owner_profile_id = ?').run('m1', 1);
};

const edit = (d: DatabaseSync): void => {
  d.prepare('UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ? AND owner_profile_id = ?')
    .run('счёт пришлю позже', 1500, 'm1', 1);
};

/** Ровно тот вызов, что стоял на месте исхода до v4.32.833: снимок + исход. */
const oldWay = (d: DatabaseSync): void => {
  d.prepare(UPSERT()).run(
    'm1', 'peerA', 'bafy-real', 'счёт 1234 5678', 'out', 'delivered', null, 1000, 1, null, null, 'ipfs',
  );
};

describe('исход отправки приходит на строку, которой уже нет', () => {
  it('удалённое сообщение не возвращается', () => {
    const d = freshDb();
    // Пока шла сеть, человек нажал «Удалить у всех».
    drop(d);
    const res = d.prepare(DELIVERY()).run('bafy-real', 'delivered', 'ipfs', 'm1', 1);
    expect(countRows(d)).toBe(0);
    // И это видно словом: «ни одной строки не подошло».
    expect(Number(res.changes)).toBe(0);
    d.close();
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прежняя форма ту же строку воскрешала', () => {
    const d = freshDb();
    drop(d);
    oldWay(d);
    expect(countRows(d)).toBe(1);
    expect(readRow(d)?.text).toBe('счёт 1234 5678');
    expect(readRow(d)?.status).toBe('delivered');
    d.close();
  });
});

describe('исход отправки приходит на уже прочитанное сообщение', () => {
  const asRead = (d: DatabaseSync): void => {
    d.prepare('UPDATE chat_messages SET status = ? WHERE id = ? AND owner_profile_id = ?')
      .run('read', 'm1', 1);
  };

  it('синяя галочка не отматывается назад в «доставлено»', () => {
    const d = freshDb();
    // Собеседник получил сообщение из общей темы и прочитал его, пока
    // announceCid ещё шёл по каналам.
    asRead(d);
    d.prepare(DELIVERY()).run('bafy-real', 'delivered', 'ipfs', 'm1', 1);
    expect(readRow(d)?.status).toBe('read');
    d.close();
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прежняя форма её затирала, и навсегда', () => {
    const d = freshDb();
    asRead(d);
    oldWay(d);
    // Второй отметки по тому же сообщению собеседник не шлёт.
    expect(readRow(d)?.status).toBe('delivered');
    d.close();
  });
});

describe('исход отправки приходит на строку, которую успели поправить', () => {
  it('текст правки остаётся, подпись «изменено» с текстом не расходится', () => {
    const d = freshDb();
    // Пока шла сеть, человек убрал из сообщения номер счёта.
    edit(d);
    d.prepare(DELIVERY()).run('bafy-real', 'delivered', 'ipfs', 'm1', 1);
    const row = readRow(d);
    expect(row?.text).toBe('счёт пришлю позже');
    expect(row?.edited_at).toBe(1500);
    d.close();
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прежняя форма возвращала текст, оставляя подпись', () => {
    const d = freshDb();
    edit(d);
    oldWay(d);
    const row = readRow(d);
    // Текст откатился…
    expect(row?.text).toBe('счёт 1234 5678');
    // …а подпись о правке осталась: её в списке DO UPDATE нет.
    expect(row?.edited_at).toBe(1500);
    d.close();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: на живой строке исход по-прежнему проставляется', () => {
  it('ссылка, состояние и маршрут записываются', () => {
    const d = freshDb();
    const res = d.prepare(DELIVERY()).run('bafy-real', 'delivered', 'ipfs', 'm1', 1);
    expect(Number(res.changes)).toBe(1);
    const row = readRow(d);
    expect(row?.cid).toBe('bafy-real');
    expect(row?.status).toBe('delivered');
    expect(row?.transport).toBe('ipfs');
    d.close();
  });

  it('«не отправлено» тоже проставляется — у строки появляется «Повторить»', () => {
    const d = freshDb();
    d.prepare(DELIVERY()).run(null, 'failed', null, 'm1', 1);
    expect(readRow(d)?.status).toBe('failed');
    d.close();
  });

  it('текста, реакций и «Избранного» исход не касается вовсе', () => {
    const d = freshDb();
    d.prepare('UPDATE chat_messages SET reactions = ?, starred = 1 WHERE id = ?')
      .run('{"👍":["did:key:zB"]}', 'm1');
    d.prepare(DELIVERY()).run('bafy-real', 'sent', 'ipfs', 'm1', 1);
    const row = readRow(d);
    expect(row?.text).toBe('счёт 1234 5678');
    expect(row?.reactions).toBe('{"👍":["did:key:zB"]}');
    expect(row?.starred).toBe(1);
    d.close();
  });

  it('строка другого профиля под тем же номером не задета', () => {
    const d = freshDb();
    d.prepare(INSERT_ROW).run('m1', 'peerA', 'второй профиль', 'sending', 2000, 2);
    d.prepare(DELIVERY()).run('bafy-real', 'delivered', 'ipfs', 'm1', 1);
    const other = readRow(d, 2);
    expect(other?.status).toBe('sending');
    expect(other?.cid).toBe(null);
    expect(other?.text).toBe('второй профиль');
    d.close();
  });
});

describe('форма исходников', () => {
  it('отправка спрашивает исход, а не перезаписывает строку снимком', () => {
    const msg = MESSAGING();
    expect(msg).toContain('markChatMessageDeliveredChecked(messageId, ownerPid, delivery)');
    expect(msg).toContain("await markDelivered({ cid, status: 'sent', transport: 'ipfs' });");
    expect(msg).toContain("await markDelivered({ cid, status: 'delivered', transport: 'ipfs' });");
    expect(msg).toContain(
      "await markDelivered({ cid: fallbackRef, status: 'delivered', transport: fallbackVia });",
    );
    expect(msg).toContain(
      "if ((await markDelivered({ cid: null, status: 'failed', transport: null })) === 'failed') {",
    );
    // Снимок `pending` после сети не пишется больше нигде.
    expect(msg.split('...pending').length - 1).toBe(0);
  });

  it('исход не проходит мимо служебного конверта и живой геолокации', () => {
    const msg = MESSAGING();
    const at = msg.indexOf('const markDelivered = async (delivery: {');
    expect(at).toBeGreaterThan(0);
    const body = msg.slice(at, at + 400);
    expect(body).toContain("if (control || callerOwnsRow) return 'skipped';");
  });

  it('запись отвечает исходом словом, а не булевым', () => {
    expect(SRC).toContain(
      "export type ChatDeliveryWrite = 'updated' | 'missing' | 'overtaken' | 'failed';",
    );
    expect(DELIVERY()).toContain("AND status != 'read'");
  });

  it('«прочитано» ставит только входящая отметка — отправка его не пишет', () => {
    const msg = MESSAGING();
    expect(msg).toContain("await updateChatMessageStatusChecked(msgId, 'read', ownerPid);");
    // И приходит она отдельным путём, а не внутри своей же отправки.
    const at = msg.indexOf('const markDelivered = async (delivery: {');
    const end = msg.indexOf('const touchConv', at);
    expect(msg.slice(at, end)).not.toContain("'read'");
  });
});
