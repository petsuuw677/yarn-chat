CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  about TEXT DEFAULT '',
  avatar_key TEXT,
  seen_privacy TEXT DEFAULT 'everyone',
  public_key TEXT,
  enc_priv TEXT,
  pw_v INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  device TEXT,
  last_active INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  is_group INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  dm_key TEXT UNIQUE,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  last_msg_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  typing_until INTEGER NOT NULL DEFAULT 0,
  delivered_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  body TEXT,
  media_key TEXT,
  reply_to INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS media (
  key TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deletions (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_deletions_chat ON deletions(chat_id, at);
CREATE TABLE IF NOT EXISTS padis (owner_id INTEGER NOT NULL, padi_id INTEGER NOT NULL, nickname TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, padi_id));
CREATE INDEX IF NOT EXISTS idx_padis_padi ON padis(padi_id);
CREATE TABLE IF NOT EXISTS blocks (blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id));
CREATE TABLE IF NOT EXISTS vibes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, body TEXT, bg TEXT, media_key TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_vibes_user ON vibes(user_id, expires_at);
CREATE TABLE IF NOT EXISTS vibe_views (vibe_id INTEGER NOT NULL, viewer_id INTEGER NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY (vibe_id, viewer_id));
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL, p256dh TEXT, auth TEXT, created_at INTEGER NOT NULL, token TEXT);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_blobs_owner ON blobs(owner_id, created_at);
CREATE TABLE IF NOT EXISTS blob_chunks (key TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (key, n));
