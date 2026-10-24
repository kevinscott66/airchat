/** Legacy clients can render this identity, but cannot act as a real group member. */
export const ANONYMOUS_GROUP_SENDER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Add only after legacy table rebuilds; retry safely after interrupted migration. */
export async function ensureGroupAnonymousColumns(database: {
  getAllAsync<T>(sql: string): Promise<T[]>;
  execAsync(sql: string): Promise<void>;
}): Promise<void> {
  for (const [table, columns] of [
    ['group_members', [['anonymous_grant', 'TEXT'], ['anonymous_revision', 'INTEGER NOT NULL DEFAULT 0']]],
    ['group_messages', [['author_as_group', 'INTEGER NOT NULL DEFAULT 0']]],
  ] as const) {
    const existing = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
    for (const [name, definition] of columns) {
      if (!existing.some((column) => column.name === name)) {
        await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }
  // Durable marker makes this a one-time conversion even if an old device
  // later syncs its obsolete group-wide toggle back to this database.
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS local_schema_migrations (name TEXT PRIMARY KEY);
    BEGIN IMMEDIATE;
    UPDATE group_messages SET author_as_group = 1
      WHERE NOT EXISTS (SELECT 1 FROM local_schema_migrations WHERE name = 'group_anonymous_authors_v1')
        AND EXISTS (SELECT 1 FROM groups g WHERE g.id = group_messages.group_id
          AND g.owner_profile_id = group_messages.owner_profile_id
          AND g.type = 'group' AND g.anonymous_posting = 1);
    UPDATE groups SET anonymous_posting = 0
      WHERE type = 'group' AND anonymous_posting = 1
        AND NOT EXISTS (SELECT 1 FROM local_schema_migrations WHERE name = 'group_anonymous_authors_v1');
    INSERT OR IGNORE INTO local_schema_migrations (name) VALUES ('group_anonymous_authors_v1');
    COMMIT;
  `).catch(async (error: unknown) => {
    await database.execAsync('ROLLBACK;').catch(() => {});
    throw error;
  });

}
