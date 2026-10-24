import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ts from 'typescript';
import { finishDatabaseBootstrap, createLocalIndexes } from '../localBootstrap';

// Execute the actual production migration functions against SQLite, rather
// than mocking PRAGMA results or asserting that SQL text merely exists.
const source = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
const ast = ts.createSourceFile('local.ts', source, ts.ScriptTarget.Latest, true);
const names = ['initSchema', 'ensureChatMessagesOwnerProfileColumn', 'ensureReplyToColumns'];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && node.name && names.includes(node.name.text)).map(node => node.getText(ast)).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const migrations = new Function('log', `${compiled}; return {${names.join(',')}};`)({ warn: jest.fn() }) as Record<string, (db: Db) => Promise<void>>;
const python = `import sqlite3,json,sys
r=json.load(sys.stdin)
c=sqlite3.connect(r['path'])
c.row_factory=sqlite3.Row
try:
 if r['read']: print(json.dumps([dict(row) for row in c.execute(r['sql'])]))
 else: c.executescript(r['sql']); c.commit(); print('null')
finally: c.close()
`;
let directory: string;
let filename: string;
class Db {
  closeAsync = jest.fn(async () => {});
  failOn: string | null = null;
  async execAsync(sql: string): Promise<void> {
    if (this.failOn && sql.includes(this.failOn)) throw new Error('SQLITE_FULL');
    this.query(sql, false);
  }
  async getAllAsync(sql: string): Promise<Array<Record<string, unknown>>> { return this.query(sql, true); }
  query(sql: string, read: boolean): Array<Record<string, unknown>> {
    const result = spawnSync('python3', ['-c', python], {
      input: JSON.stringify({ path: filename, sql, read }), encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  }
}
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-schema-')); filename = path.join(directory, 'fixture.db'); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
const boot = (db: Db) => finishDatabaseBootstrap(db, async () => {
  await migrations.initSchema(db);
  await migrations.ensureChatMessagesOwnerProfileColumn(db);
  await migrations.ensureReplyToColumns(db);
  await createLocalIndexes(db);
});

test('pre-profile database preserves messages and opens idempotently', async () => {
  const db = new Db();
  await db.execAsync(`CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY, contact_pub_b64 TEXT NOT NULL, cid TEXT,
    text TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL,
    media_cids TEXT, created_at INTEGER NOT NULL
  ); INSERT INTO chat_messages VALUES ('m','peer',NULL,'kept','in','read',NULL,1);`);
  await boot(db);
  await boot(db);
  expect(await db.getAllAsync('SELECT id,text,owner_profile_id FROM chat_messages')).toEqual([{ id: 'm', text: 'kept', owner_profile_id: 1 }]);
  expect(await db.getAllAsync("SELECT name FROM sqlite_master WHERE name='idx_chat_contact_profile'")).toHaveLength(1);
});

test('fresh schema also opens twice without failures', async () => {
  const db = new Db();
  await boot(db);
  await boot(db);
  expect(db.closeAsync).not.toHaveBeenCalled();
});

test('failed required ALTER closes the handle, exposes no database, and retries without losing rows', async () => {
  const db = new Db();
  await db.execAsync(`CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY, contact_pub_b64 TEXT NOT NULL, cid TEXT,
    text TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL,
    media_cids TEXT, created_at INTEGER NOT NULL
  ); INSERT INTO chat_messages VALUES ('m','peer',NULL,'kept','in','read',NULL,1);`);
  db.failOn = 'ADD COLUMN reply_to_preview';
  await expect(boot(db)).rejects.toThrow('SQLITE_FULL');
  expect(db.closeAsync).toHaveBeenCalledTimes(1);
  expect(await db.getAllAsync('SELECT text FROM chat_messages')).toEqual([{ text: 'kept' }]);
  db.failOn = null;
  await expect(boot(db)).resolves.toBe(db);
  expect((await db.getAllAsync('PRAGMA table_info(chat_messages)')).map(c => c.name)).toContain('reply_to_preview');
});
