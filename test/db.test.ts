import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate, readSchemaVersion, type Migration } from "../src/worker/db";

const createA: Migration = (sql) => sql.exec("CREATE TABLE a (id TEXT PRIMARY KEY)");
const createB: Migration = (sql) => sql.exec("CREATE TABLE b (id TEXT PRIMARY KEY)");
const failing: Migration = (sql) => {
  sql.exec("CREATE TABLE c (id TEXT PRIMARY KEY)");
  throw new Error("boom");
};

function tables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a', 'b', 'c') ORDER BY name")
    .toArray()
    .map((row) => row.name);
}

// Each test uses its own object; its constructor has already applied the real Workspace
// migrations, so reset the stored version to test migrate() from scratch.
function freshObject() {
  return env.WORKSPACE.get(env.WORKSPACE.newUniqueId());
}

function resetVersion(storage: DurableObjectStorage) {
  storage.sql.exec("DELETE FROM schema_version");
}

describe("migrate", () => {
  it("applies pending migrations in order and is idempotent", async () => {
    await runInDurableObject(freshObject(), (_instance, state) => {
      resetVersion(state.storage);
      expect(migrate(state.storage, [createA, createB])).toBe(2);
      expect(readSchemaVersion(state.storage.sql)).toBe(2);
      expect(tables(state.storage.sql)).toEqual(["a", "b"]);

      expect(migrate(state.storage, [createA, createB])).toBe(2);
    });
  });

  it("resumes from the stored version", async () => {
    await runInDurableObject(freshObject(), (_instance, state) => {
      resetVersion(state.storage);
      migrate(state.storage, [createA]);
      expect(migrate(state.storage, [createA, createB])).toBe(2);
      expect(tables(state.storage.sql)).toEqual(["a", "b"]);
    });
  });

  it("rolls back a failing migration and keeps earlier ones", async () => {
    await runInDurableObject(freshObject(), (_instance, state) => {
      resetVersion(state.storage);
      expect(() => migrate(state.storage, [createA, failing])).toThrow("boom");
      expect(readSchemaVersion(state.storage.sql)).toBe(1);
      expect(tables(state.storage.sql)).toEqual(["a"]);
    });
  });

  it("reports the stored version when code is older than the schema (rollback)", async () => {
    await runInDurableObject(freshObject(), (_instance, state) => {
      resetVersion(state.storage);
      migrate(state.storage, [createA, createB]);
      expect(migrate(state.storage, [createA])).toBe(2);
    });
  });
});
