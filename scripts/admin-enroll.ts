/**
 * Creates a one-time link that adds an owner passkey for the dashboard at /admin (plan §8.2, M9).
 *
 *   npm run admin:enroll
 *   npm run admin:enroll -- --local
 *
 * Open the link on the device that should hold the passkey; it works once and expires in a day.
 * The admin token is read from COLO_ADMIN_TOKEN, then ~/.colo/admin-token
 * (or ADMIN_TOKEN in .dev.vars with --local).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PRODUCTION_URL = "https://colo.manan-vala.workers.dev";
const LOCAL_URL = "http://localhost:5173";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    local: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function adminToken(local: boolean): string {
  if (process.env.COLO_ADMIN_TOKEN) return process.env.COLO_ADMIN_TOKEN.trim();
  if (local) {
    const match = existsSync(".dev.vars") ? /^ADMIN_TOKEN="?([^"\n]+)"?$/m.exec(readFileSync(".dev.vars", "utf8")) : null;
    if (match) return match[1];
    fail("No ADMIN_TOKEN in .dev.vars");
  }
  const file = join(homedir(), ".colo", "admin-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  fail(`Set COLO_ADMIN_TOKEN or create ${file}`);
}

const base = values.url ?? (values.local ? LOCAL_URL : PRODUCTION_URL);
const response = await fetch(`${base}/api/admin/enroll-token`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken(values.local)}` },
  body: "{}",
});

if (response.status === 404) fail("Owner enrollment is disabled: ADMIN_TOKEN is not set on the Worker.");
if (!response.ok) fail(`Enrollment link failed (${response.status}): ${await response.text()}`);

const link = (await response.json()) as { url: string; expiresAt: string };
console.log("Owner passkey enrollment link:");
console.log(link.url);
console.log(`Single use; expires ${new Date(link.expiresAt).toLocaleString()}. Open it on your own device.`);
