/**
 * Restores a backup file into a local instance (plan §8.5).
 *
 *   npm run restore -- --file colo-backup-2026-09-20.ndjson
 *
 * Unlike `npm run invite`, this defaults to the local Worker: a restore writes over documents,
 * and the safe target is the one on your own machine. Pointing it anywhere else needs --url, and
 * a non-localhost URL needs --force as well.
 *
 * It is only ever reachable where ADMIN_TOKEN is set. Production deletes that secret once both
 * passkeys are enrolled (§8.2), so there the endpoint does not exist. The token is read from
 * COLO_ADMIN_TOKEN, then ADMIN_TOKEN in .dev.vars, then ~/.colo/admin-token.
 *
 * Nothing is ever deleted: rows in the backup win, rows not in it are left alone. Running the
 * same file twice is a no-op, so a failed run can simply be repeated.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKUP_BATCH_BYTES, type BackupRecord } from "../src/shared/protocol.ts";

const LOCAL_URL = "http://localhost:5173";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    url: { type: "string" },
    overwrite: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

/** Thrown rather than exiting: this module ends in a top-level await, and calling process.exit()
 *  while that is pending aborts the process on Windows instead of printing the message. */
class Fail extends Error {}
function fail(message: string): never {
  throw new Fail(message);
}

function adminToken(): string {
  if (process.env.COLO_ADMIN_TOKEN) return process.env.COLO_ADMIN_TOKEN.trim();
  const match = existsSync(".dev.vars") ? /^ADMIN_TOKEN="?([^"\n]+)"?$/m.exec(readFileSync(".dev.vars", "utf8")) : null;
  if (match) return match[1];
  const file = join(homedir(), ".colo", "admin-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return fail(`No ADMIN_TOKEN in .dev.vars; set COLO_ADMIN_TOKEN or create ${file}`);
}

async function failure(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.message ?? body?.error ?? response.statusText;
}

function read(file: string): BackupRecord[] {
  if (!existsSync(file)) fail(`No such file: ${file}`);
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) fail("The backup is empty.");

  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line) as BackupRecord;
    } catch {
      return fail(`Line ${index + 1} of the backup is not JSON.`);
    }
  });
  // Without its last line the export stopped part-way, and NDJSON gives no other way to tell.
  if (records.at(-1)?.type !== "end") fail("This backup is truncated: it has no `end` record. Take a fresh one.");
  return records;
}

async function main(): Promise<void> {
  if (!values.file) fail("Usage: npm run restore -- --file <backup.ndjson> [--overwrite] [--url <url> --force]");

  const base = values.url ?? LOCAL_URL;
  if (!base.startsWith("http://localhost") && !values.force) {
    fail(`Refusing to restore into ${base} without --force. A restore writes over documents.`);
  }

  const records = read(values.file);
  const token = adminToken();
  const url = `${base}/api/admin/restore${values.overwrite ? "?overwrite=1" : ""}`;

  const send = async (batch: BackupRecord[]): Promise<void> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson", Authorization: `Bearer ${token}` },
      body: `${batch.map((record) => JSON.stringify(record)).join("\n")}\n`,
    });
    if (response.status === 404) {
      fail("Restore is disabled: ADMIN_TOKEN is not set on this Worker (which is expected in production).");
    }
    if (response.status === 409 && !values.overwrite) {
      fail(`${await failure(response)}\nRe-run with --overwrite to write the backup over what is there.`);
    }
    if (!response.ok) fail(`Restore failed (${response.status}): ${await failure(response)}`);
  };

  const documents = records.filter((record) => record.type === "document").length;
  console.log(`Restoring ${documents} document(s) from ${values.file} into ${base}`);
  console.log("Do not open the app until this finishes.");

  // Batched by size, never splitting a document's records away from the `commit` that follows
  // them: a document is only made live once every one of its chunks has landed.
  let batch: BackupRecord[] = [];
  let bytes = 0;
  let done = 0;

  for (const record of records) {
    const size = JSON.stringify(record).length + 1;
    if (batch.length > 0 && bytes + size > BACKUP_BATCH_BYTES) {
      await send(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(record);
    bytes += size;
    if (record.type === "commit") {
      await send(batch);
      batch = [];
      bytes = 0;
      done++;
      console.log(`  ${done}/${documents} restored`);
    }
  }
  if (batch.length > 0) await send(batch);

  console.log(`\nRestored ${done} document(s).`);
  console.log("Passkeys are bound to a device and are never backed up, so enrol a fresh one:");
  console.log(`  npm run invite -- --email <your email> --name "<Your Name>" --local`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Fail ? error.message : error);
  process.exitCode = 1;
}
