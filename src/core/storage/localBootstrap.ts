/** Required migrations finish before a database is exposed to application writes. */
export async function finishDatabaseBootstrap<T extends { closeAsync(): Promise<void> }>(
  database: T,
  initialize: () => Promise<void>,
): Promise<T> {
  try {
    await initialize();
    return database;
  } catch (error) {
    // Preserve the migration error even if closing also fails. The next open
    // retries idempotent steps against the retained database, never deletes it.
    await database.closeAsync().catch(() => {});
    throw error;
  }
}

/** Indexes may reference newly added columns; run only after required migrations. */
export async function createLocalIndexes(database: { execAsync(sql: string): Promise<void> }): Promise<void> {
  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_sync_entity_heads_profile
      ON sync_entity_heads (owner_profile_id, entity_kind, entity_id);
    CREATE INDEX IF NOT EXISTS idx_chat_contact_profile
      ON chat_messages (contact_pub_b64, owner_profile_id, created_at DESC);
    DROP INDEX IF EXISTS idx_chat_contact;
    CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox (created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_conv_profile ON conversations (owner_profile_id, pinned DESC, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_grp_msg_profile
      ON group_messages (group_id, owner_profile_id, created_at DESC);
    DROP INDEX IF EXISTS idx_grp_msg;
    CREATE INDEX IF NOT EXISTS idx_grp_members ON group_members (group_id, owner_profile_id);
    CREATE INDEX IF NOT EXISTS idx_stories
      ON stories (owner_profile_id, author_pub_b64, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_story_album_items
      ON story_album_items (album_id, owner_profile_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled ON scheduled_messages (send_at ASC);
    CREATE INDEX IF NOT EXISTS idx_quick_replies ON quick_replies (owner_profile_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_grp_join_req ON group_join_requests (group_id, status, created_at DESC);
  `);
}
