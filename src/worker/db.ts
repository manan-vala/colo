/**
 * Schema migrations for the Durable Objects (plan §3.4).
 *
 * migrations[i] upgrades a database from version i to i + 1. Migrations are
 * forward-only and additive (new tables, new nullable columns) so that
 * `wrangler rollback` keeps working against a newer schema.
 *
 * The version lives in a one-row table because Durable Object SQLite does not
 * authorize `PRAGMA user_version` (it fails with SQLITE_AUTH).
 */
export type Migration = (sql: SqlStorage) => void;

export const WORKSPACE_MIGRATIONS: Migration[] = [
  // 1: members, passkeys, invites, sessions, auth challenges (M1)
  (sql) => {
    sql.exec(`
      CREATE TABLE members (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        disabled_at   TEXT
      );
      CREATE TABLE passkeys (
        credential_id TEXT PRIMARY KEY,
        member_id     TEXT NOT NULL REFERENCES members(id),
        public_key    BLOB NOT NULL,
        counter       INTEGER NOT NULL DEFAULT 0,
        transports    TEXT,
        created_at    TEXT NOT NULL,
        last_used_at  TEXT
      );
      CREATE INDEX passkeys_by_member ON passkeys(member_id);
      CREATE TABLE invites (
        token_hash    TEXT PRIMARY KEY,
        member_id     TEXT NOT NULL REFERENCES members(id),
        expires_at    TEXT NOT NULL,
        used_at       TEXT
      );
      CREATE TABLE sessions (
        id_hash       TEXT PRIMARY KEY,
        member_id     TEXT NOT NULL REFERENCES members(id),
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL
      );
      CREATE INDEX sessions_by_member ON sessions(member_id);
      CREATE TABLE auth_challenges (
        id            TEXT PRIMARY KEY,
        challenge     TEXT NOT NULL,
        purpose       TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
        member_id     TEXT,
        expires_at    TEXT NOT NULL
      );
    `);
  },
  // 2: document index and which sessions opened which documents (M2)
  (sql) => {
    sql.exec(`
      CREATE TABLE documents (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        created_by    TEXT NOT NULL REFERENCES members(id),
        updated_at    TEXT NOT NULL,
        updated_by    TEXT NOT NULL REFERENCES members(id),
        deleted_at    TEXT
      );
      CREATE INDEX documents_live_by_updated ON documents(deleted_at, updated_at);
      CREATE TABLE document_sessions (
        doc_id        TEXT NOT NULL,
        session_hash  TEXT NOT NULL,
        connected_at  TEXT NOT NULL,
        PRIMARY KEY (session_hash, doc_id)
      ) WITHOUT ROWID;
    `);
  },
];

export const DOCUMENT_MIGRATIONS: Migration[] = [
  // 1: chunked Yjs state (M2)
  (sql) => {
    sql.exec(`
      CREATE TABLE doc_state (
        seq           INTEGER PRIMARY KEY,
        data          BLOB NOT NULL
      );
    `);
  },
  // 2: a throttled document-list update that must survive eviction until its alarm fires
  (sql) => {
    sql.exec(`
      CREATE TABLE pending_meta (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at    TEXT NOT NULL,
        updated_by    TEXT
      );
    `);
  },
  // 3: images, one row each (an image is at most 1 MB, under the 2 MB row limit) (M6)
  (sql) => {
    sql.exec(`
      CREATE TABLE images (
        id            TEXT PRIMARY KEY,
        mime          TEXT NOT NULL CHECK (mime IN ('image/webp', 'image/png', 'image/jpeg', 'image/gif')),
        bytes         INTEGER NOT NULL,
        data          BLOB NOT NULL,
        created_at    TEXT NOT NULL,
        created_by    TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
  },
];

export function readSchemaVersion(sql: SqlStorage): number {
  const row = sql.exec<{ version: number }>("SELECT version FROM schema_version WHERE id = 1").toArray()[0];
  return row?.version ?? 0;
}

/** Applies pending migrations, each in its own transaction, and returns the resulting version. */
export function migrate(storage: DurableObjectStorage, migrations: Migration[]): number {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  const current = readSchemaVersion(sql);
  for (let version = current; version < migrations.length; version++) {
    storage.transactionSync(() => {
      migrations[version](sql);
      sql.exec(
        "INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version",
        version + 1,
      );
    });
  }
  // After a rollback the stored schema may be newer than this code knows about.
  return Math.max(current, migrations.length);
}
