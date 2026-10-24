import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ts from 'typescript';
import { ensureGroupAnonymousColumns, ANONYMOUS_GROUP_SENDER } from '../groupAnonymousStorage';
import { decodeAnonymousGroupMessage, encodeAnonymousGroupMessage, sanitizeGroupMessageRows, sanitizeGroupMemberRows, sanitizeGroupRows } from '../groupBackup';

const key = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const python = `import sqlite3,json,sys
r=json.load(sys.stdin); c=sqlite3.connect(r['path']); c.row_factory=sqlite3.Row
try:
 if r['kind']=='exec': c.executescript(r['sql']); result=None
 else:
  cur=c.execute(r['sql'],r.get('args',[]))
  result=[dict(x) for x in cur] if r['kind']=='read' else {'changes':cur.rowcount}
 c.commit(); print(json.dumps(result))
finally: c.close()
`;
let dir: string;
class Db {
  query(sql: string, kind: string, args: unknown[] = []) {
    const r = spawnSync('python3', ['-c', python], { input: JSON.stringify({ path: path.join(dir, 'db'), sql, kind, args }), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  }
  async execAsync(sql: string) { this.query(sql, 'exec'); }
  async getAllAsync<T>(sql: string): Promise<T[]> { return this.query(sql, 'read'); }
  async runAsync(sql: string, args: unknown[]) { return this.query(sql, 'run', args); }
}
const database = new Db();
const src = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');
const ast = ts.createSourceFile('local.ts', src, ts.ScriptTarget.Latest, true);
const names = ['upsertMemberRow', 'updateGroupAnonymousGrant', 'applySyncGroupMessage', 'applySyncGroupMember', 'updateGroupMemberRole', 'clearGroupAnonymousGrant', 'applySyncGroup'];
const funcs = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name && names.includes(n.name.text)).map(n => n.getText(ast)).join('\n');
const compiled = ts.transpileModule(funcs, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const api = new Function('exports', 'db', 'encryptAtRestNullable', 'clampJoinedAt', 'emitChatWrites', 'validSyncProfileId', 'getOrCreateDataEncryptionKey', 'encryptAtRestIfPlain', 'decodeAnonymousGroupMessage', 'ANONYMOUS_GROUP_SENDER', 'sanitizeGroupRows', `${compiled}; return {${names.join(',')}};`)(
  {}, async () => database, (x: unknown) => x, (x: number) => x, () => {}, () => true, async () => new Uint8Array(), (x: unknown) => x, decodeAnonymousGroupMessage, ANONYMOUS_GROUP_SENDER, sanitizeGroupRows,
);
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-anon-'));
  await database.execAsync(`CREATE TABLE groups(id TEXT, owner_profile_id INTEGER, type TEXT, anonymous_posting INTEGER);
    CREATE TABLE group_members(group_id TEXT,peer_pub_b64 TEXT,role TEXT,display_name TEXT,joined_at INTEGER,owner_profile_id INTEGER,PRIMARY KEY(group_id,peer_pub_b64,owner_profile_id));
    CREATE TABLE group_messages(id TEXT,group_id TEXT,sender_pub_b64 TEXT NOT NULL,sender_name TEXT,text TEXT NOT NULL,media_cids TEXT,reply_to_id TEXT,reply_to_preview TEXT,reactions TEXT,created_at INTEGER,owner_profile_id INTEGER,edited_at INTEGER,starred INTEGER,view_count INTEGER,seen_by TEXT,PRIMARY KEY(id,owner_profile_id));`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('migrates old rows idempotently with safe defaults', async () => {
  await database.runAsync('INSERT INTO group_members VALUES (?,?,?,?,?,?)', ['g', key, 'admin', 'name', 1, 1]);
  await ensureGroupAnonymousColumns(database);
  await ensureGroupAnonymousColumns(database);
  expect(database.query('SELECT anonymous_grant,anonymous_revision FROM group_members', 'read')).toEqual([{ anonymous_grant: null, anonymous_revision: 0 }]);
});
it('converts only historical hidden regular-group rows once; future rows remain personal', async () => {
  await database.runAsync('INSERT INTO groups VALUES (?,?,?,?)', ['g', 1, 'group', 1]);
  await database.runAsync('INSERT INTO group_messages(id,group_id,sender_pub_b64,text,owner_profile_id) VALUES(?,?,?,?,?)', ['old', 'g', key, 'old', 1]);
  await ensureGroupAnonymousColumns(database);
  expect(database.query('SELECT author_as_group FROM group_messages', 'read')[0].author_as_group).toBe(1);
  expect(database.query('SELECT anonymous_posting FROM groups', 'read')[0].anonymous_posting).toBe(0);
  await database.runAsync('INSERT INTO group_messages(id,group_id,sender_pub_b64,text,owner_profile_id) VALUES(?,?,?,?,?)', ['new', 'g', key, 'new', 1]);
  // An obsolete device reintroducing its toggle must not rewrite newer history.
  await database.execAsync('UPDATE groups SET anonymous_posting=1');
  await ensureGroupAnonymousColumns(database);
  expect(database.query("SELECT author_as_group FROM group_messages WHERE id='new'", 'read')[0].author_as_group).toBe(0);
});
it('preserves grants on name updates, revokes on demotion, rejects stale grant and isolates profiles', async () => {
  await ensureGroupAnonymousColumns(database);
  const member = { groupId: 'g', peerPubB64: key, role: 'admin', displayName: 'name', joinedAt: 1, ownerProfileId: 1 };
  await api.upsertMemberRow(database, new Uint8Array(), member);
  expect(await api.updateGroupAnonymousGrant('g', 1, key, 'signed', 5)).toBe(true);
  await api.upsertMemberRow(database, new Uint8Array(), { ...member, displayName: 'new' });
  expect(database.query('SELECT anonymous_grant,anonymous_revision FROM group_members', 'read')[0]).toEqual({ anonymous_grant: 'signed', anonymous_revision: 5 });
  await api.applySyncGroupMember({ group_id: 'g', peer_pub_b64: key, role: 'admin', display_name: 'old', joined_at: 1 }, 1);
  expect(database.query('SELECT anonymous_grant,anonymous_revision FROM group_members', 'read')[0]).toEqual({ anonymous_grant: 'signed', anonymous_revision: 5 });
  expect(await api.updateGroupAnonymousGrant('g', 2, key, 'other', 6)).toBe(false);
  await api.updateGroupMemberRole('g', key, 'member', 1);
  expect(await api.updateGroupAnonymousGrant('g', 1, key, 'signed', 6)).toBe(false);
  await api.upsertMemberRow(database, new Uint8Array(), member);
  expect(await api.updateGroupAnonymousGrant('g', 1, key, 'signed', 5)).toBe(false);
  expect(database.query('SELECT anonymous_grant,anonymous_revision FROM group_members', 'read')[0]).toEqual({ anonymous_grant: null, anonymous_revision: 5 });
});
const message = { id: 'm', group_id: 'g', sender_pub_b64: key, sender_name: 'enc2:person', text: 'enc2:hello', media_cids: null, reply_to_id: null, reply_to_preview: null, reactions: null, created_at: 1, edited_at: null, starred: 0, view_count: 0, seen_by: null, author_as_group: 1 };
it('legacy projection stays anonymous and cannot overwrite authenticated sender on return sync', async () => {
  await ensureGroupAnonymousColumns(database);
  const wire = encodeAnonymousGroupMessage(message, 'enc2:Group');
  expect(wire.sender_pub_b64).toBe(ANONYMOUS_GROUP_SENDER);
  expect(wire.sender_name).toBe('enc2:Group');
  expect(encodeAnonymousGroupMessage({ ...message, author_as_group: 0 }, 'enc2:Channel', true)).toMatchObject({ sender_pub_b64: ANONYMOUS_GROUP_SENDER, sender_name: 'enc2:Channel', author_as_group: 1 });
  expect(sanitizeGroupMessageRows([wire], new Set(['g'])).rows[0]).toMatchObject({ sender_pub_b64: key, author_as_group: 1 });
  await api.applySyncGroupMessage(wire, 1);
  const { author_format: _format, authenticated_sender_pub_b64: _key, authenticated_sender_name: _name, author_as_group: _flag, ...legacy } = wire;
  await api.applySyncGroupMessage(legacy, 1);
  expect(database.query('SELECT sender_pub_b64,sender_name,author_as_group FROM group_messages', 'read')[0]).toEqual({ sender_pub_b64: key, sender_name: 'enc2:person', author_as_group: 1 });
  await api.applySyncGroupMessage(legacy, 2);
  expect(database.query('SELECT sender_pub_b64,author_as_group FROM group_messages WHERE owner_profile_id=2', 'read')[0]).toEqual({ sender_pub_b64: ANONYMOUS_GROUP_SENDER, author_as_group: 1 });
});
it('old backups default to personal messages/no grant; malformed metadata is rejected', () => {
  expect(sanitizeGroupMemberRows([{ group_id: 'g', peer_pub_b64: key, role: 'admin', display_name: null, joined_at: 1 }], new Set(['g'])).rows[0]).toMatchObject({ anonymous_grant: null, anonymous_revision: 0 });
  expect(sanitizeGroupMessageRows([{ ...message, author_as_group: undefined }], new Set(['g'])).rows[0].author_as_group).toBe(0);
  expect(sanitizeGroupMessageRows([{ ...message, author_format: 'anonymous:v2' }], new Set(['g'])).dropped).toBe(1);
  expect(sanitizeGroupMemberRows([{ group_id: 'g', peer_pub_b64: key, role: 'admin', anonymous_revision: -1 }], new Set(['g'])).dropped).toBe(1);
});

it('fresh owner revocation clears equal revision but never a newer local grant', async () => {
  await ensureGroupAnonymousColumns(database);
  await api.upsertMemberRow(database, new Uint8Array(), { groupId: 'g', peerPubB64: key, role: 'admin', displayName: null, joinedAt: 1, ownerProfileId: 1 });
  await api.updateGroupAnonymousGrant('g', 1, key, 'signed', 5);
  expect(await api.clearGroupAnonymousGrant('g', 1, key, 5)).toBe(true);
  expect(database.query('SELECT anonymous_grant,anonymous_revision FROM group_members', 'read')[0]).toEqual({ anonymous_grant: null, anonymous_revision: 5 });
  await api.updateGroupAnonymousGrant('g', 1, key, 'new', 6);
  expect(await api.clearGroupAnonymousGrant('g', 1, key, 5)).toBe(false);
  expect(await api.clearGroupAnonymousGrant('g', 2, key, 6)).toBe(false);
  expect(database.query('SELECT anonymous_grant,anonymous_revision FROM group_members', 'read')[0]).toEqual({ anonymous_grant: 'new', anonymous_revision: 6 });
});
it('sync from an old client cannot restore the retired group-wide toggle', async () => {
  const write = jest.spyOn(database, 'runAsync').mockResolvedValue({ changes: 1 });
  try {
    await api.applySyncGroup({ id: 'g', name: 'Group', type: 'group', anonymous_posting: 1, created_at: 1, is_admin: 0, muted: 0, pinned: 0, archived: 0, admin_only_posting: 0, require_approval: 0, member_count: 0, unread_count: 0, mention_count: 0, slow_mode_seconds: 0 }, 1);
    const [sql, values] = write.mock.calls[0];
    const columns = sql.match(/INSERT INTO groups\s*\(([^)]+)\)/)![1].split(',').map((c: string) => c.trim());
    expect(values[columns.indexOf('anonymous_posting')]).toBe(0);
  } finally { write.mockRestore(); }
});
