/**
 * Чужая сторис должна доходить до каждого профиля на телефоне (v4.32.615).
 *
 * Идентификатор чужой сторис — localStoryId(ключ автора, id конверта), он
 * одинаков у всех получателей. Пока ключ таблицы был `id TEXT PRIMARY KEY`,
 * `INSERT OR IGNORE` второго профиля упирался в строку первого и молча
 * возвращался: у второго аккаунта сторис контакта просто не появлялась.
 *
 * Проверка поведенческая: схема и оператор берутся прямо из local.ts и
 * выполняются на настоящем SQLite. Сторож на текст тут бесполезен — вопрос
 * ровно в том, что SQLite делает со вторым INSERT OR IGNORE.
 */
import { readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'local.ts'), 'utf8');

/** Объявление таблицы из схемы local.ts: от CREATE TABLE до закрывающей скобки. */
function createTable(name: string): string {
  const start = SRC.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf('\n    );', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end + '\n    );'.length);
}

/** Оператор из тела названной функции: от `verb` до закрывающей обратной кавычки. */
function statementIn(fn: string, verb: string): string {
  const at = SRC.indexOf(`export async function ${fn}(`);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = SRC.indexOf('`' + verb, at);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf('`', start + 1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start + 1, end);
}

const INSERT_STORY = statementIn('insertStory', 'INSERT OR IGNORE INTO stories');

/** Схема сторис вместе с колонкой, добавленной миграцией 4.32.588. */
function freshDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(createTable('stories'));
  d.exec("ALTER TABLE stories ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'");
  return d;
}

const AUTHOR = 'author-pub-b64';
const STORY_ID = `${AUTHOR}:envelope-1`;

function insert(d: DatabaseSync, id: string, profile: number, text: string): void {
  d.prepare(INSERT_STORY).run(
    id, AUTHOR, 'file:///snap.jpg', 'image', text, 2_000, null, profile, 1_000,
  );
}

describe('составной ключ сторис', () => {
  it('одна и та же чужая сторис ложится в оба профиля', () => {
    const d = freshDb();
    insert(d, STORY_ID, 1, 'первый');
    insert(d, STORY_ID, 2, 'второй');

    const rows = d.prepare(
      'SELECT owner_profile_id AS p, text FROM stories WHERE id = ? ORDER BY p',
    ).all(STORY_ID) as Array<{ p: number; text: string }>;
    expect(rows).toEqual([{ p: 1, text: 'первый' }, { p: 2, text: 'второй' }]);
    d.close();
  });

  it('внутри одного профиля повтор по-прежнему игнорируется', () => {
    const d = freshDb();
    insert(d, STORY_ID, 1, 'настоящая');
    insert(d, STORY_ID, 1, 'подставленная');

    const rows = d.prepare('SELECT text FROM stories WHERE owner_profile_id = 1').all() as Array<{ text: string }>;
    expect(rows).toEqual([{ text: 'настоящая' }]);
    d.close();
  });

  it('чтение профиля не видит строк соседа', () => {
    const d = freshDb();
    insert(d, STORY_ID, 1, 'мой');
    insert(d, STORY_ID, 2, 'соседский');

    const mine = d.prepare(
      'SELECT text FROM stories WHERE owner_profile_id = ? AND expires_at > ?',
    ).all(1, 1_500) as Array<{ text: string }>;
    expect(mine).toEqual([{ text: 'мой' }]);
    d.close();
  });

  it('со старым ключом второй профиль сторис терял', () => {
    // Контрпример: тот же оператор поверх прежней схемы. Показывает, что
    // проверка выше держится на ключе, а не на чём-то ещё.
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE stories (
        id TEXT PRIMARY KEY NOT NULL,
        author_pub_b64 TEXT NOT NULL,
        media_uri TEXT,
        media_type TEXT NOT NULL DEFAULT 'image',
        text TEXT,
        expires_at INTEGER NOT NULL,
        viewed_by TEXT,
        owner_profile_id INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
    insert(d, STORY_ID, 1, 'первый');
    insert(d, STORY_ID, 2, 'второй');

    const rows = d.prepare('SELECT owner_profile_id AS p FROM stories').all() as Array<{ p: number }>;
    expect(rows).toEqual([{ p: 1 }]);
    d.close();
  });
});

describe('схема и миграция на месте', () => {
  it('в объявлении таблицы стоит составной ключ', () => {
    const table = createTable('stories');
    expect(table).toContain('PRIMARY KEY (id, owner_profile_id)');
    expect(table).not.toContain('id TEXT PRIMARY KEY');
  });

  it('индекс сторис в схеме начинается с профиля', () => {
    // Именно в схеме, а не где-нибудь в файле: тот же текст есть и в обёртке
    // пересборки, и проверка по всему local.ts прошла бы мимо подмены схемы.
    const table = createTable('stories');
    const after = SRC.slice(SRC.indexOf(table) + table.length, SRC.indexOf(table) + table.length + 200);
    expect(after).toContain('CREATE INDEX IF NOT EXISTS idx_stories\n      ON stories (owner_profile_id, author_pub_b64, created_at DESC);');
  });

  it('обёртка пересборки просит ту же таблицу и тот же индекс', () => {
    const at = SRC.indexOf('async function ensureStoriesProfileScopedKey(');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = SRC.slice(at, SRC.indexOf('\n}\n', at));
    expect(body).toContain('await ensureTableCompositeKey(database, {');
    expect(body).toContain("table: 'stories',");
    expect(body).toContain('ON stories (owner_profile_id, author_pub_b64, created_at DESC);');
  });
});
