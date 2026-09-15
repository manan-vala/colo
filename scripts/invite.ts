/**
 * Creates a one-time invite link (plan §8.2).
 *
 *   npm run invite -- --email you@example.com --name "Your Name"
 *   npm run invite -- --email you@example.com --name "Your Name" --local
 *
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
    email: { type: "string" },
    name: { type: "string" },
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

if (!values.email || !values.name) fail('Usage: npm run invite -- --email <email> --name "<name>" [--local]');

const base = values.url ?? (values.local ? LOCAL_URL : PRODUCTION_URL);
const response = await fetch(`${base}/api/admin/invites`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken(values.local)}` },
  body: JSON.stringify({ email: values.email, name: values.name }),
});

if (response.status === 404) fail("Invites are disabled: ADMIN_TOKEN is not set on the Worker.");
if (!response.ok) fail(`Invite failed (${response.status}): ${await response.text()}`);

const invite = (await response.json()) as { url: string; expiresAt: string };
console.log(`Invite for ${values.name} <${values.email}>`);
console.log(invite.url);
console.log(`Single use; expires ${new Date(invite.expiresAt).toLocaleString()}. Send it privately.`);
