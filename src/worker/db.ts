/**
 * Schema migrations for the Workspace Durable Object (§3.3).
 *
 * MIGRATIONS[i] upgrades the database from version i to i + 1. Migrations are
 * forward-only and additive (new tables, new nullable columns) so that
 * `wrangler rollback` keeps working against a newer schema.
 *
 * The version lives in a one-row table because Durable Object SQLite does not
 * authorize `PRAGMA user_version` (it fails with SQLITE_AUTH).
 */
export type Migration = (sql: SqlStorage) => void;

const MIGRATIONS: Migration[] = [];

export function readSchemaVersion(sql: SqlStorage): number {
  const row = sql.exec<{ version: number }>("SELECT version FROM schema_version WHERE id = 1").toArray()[0];
  return row?.version ?? 0;
}

/** Applies pending migrations, each in its own transaction, and returns the resulting version. */
export function migrate(storage: DurableObjectStorage, migrations: Migration[] = MIGRATIONS): number {
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
