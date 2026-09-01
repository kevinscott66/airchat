-- Опциональные таблицы для будущей персистентной очереди bypass (не подключены к приложению).

CREATE TABLE IF NOT EXISTS outbox_bypass (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_did TEXT NOT NULL,
  data BLOB NOT NULL,
  attempts INTEGER DEFAULT 0,
  last_attempt INTEGER,
  status TEXT DEFAULT 'pending',
  last_channel TEXT,
  timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS channel_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  success INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dns_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  target_did TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  received INTEGER DEFAULT 0,
  timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS sms_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_number TEXT NOT NULL,
  body TEXT NOT NULL,
  processed INTEGER DEFAULT 0,
  timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_bypass_target ON outbox_bypass(target_did, status);
CREATE INDEX IF NOT EXISTS idx_outbox_bypass_timestamp ON outbox_bypass(timestamp);
CREATE INDEX IF NOT EXISTS idx_channel_stats_timestamp ON channel_stats(timestamp);
CREATE INDEX IF NOT EXISTS idx_dns_messages_target ON dns_messages(target_did, received);
CREATE INDEX IF NOT EXISTS idx_sms_inbox_processed ON sms_inbox(processed);
