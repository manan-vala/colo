import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { HealthResponse } from "../src/shared/protocol";
import { WORKSPACE_MIGRATIONS, readSchemaVersion } from "../src/worker/db";

const BASE = "https://colo.example";

describe("GET /api/health", () => {
  it("answers from the Workspace Durable Object", async () => {
    const response = await exports.default.fetch(`${BASE}/api/health`);

    expect(response.status).toBe(200);
    const body = await response.json<HealthResponse>();
    expect(body.ok).toBe(true);
    expect(body.schemaVersion).toBe(WORKSPACE_MIGRATIONS.length);
    expect(body.colo === null || typeof body.colo === "string").toBe(true);
  });

  it("adds security headers to API responses", async () => {
    const response = await exports.default.fetch(`${BASE}/api/health`);

    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects other methods", async () => {
    const response = await exports.default.fetch(`${BASE}/api/health`, { method: "POST", headers: { Origin: BASE } });
    expect(response.status).toBe(405);
  });
});

describe("routing", () => {
  it("returns 404 for unknown API paths", async () => {
    const response = await exports.default.fetch(`${BASE}/api/nope`);
    expect(response.status).toBe(404);
  });
});

describe("Workspace Durable Object", () => {
  it("is SQLite-backed", async () => {
    const stub = env.WORKSPACE.getByName("default");
    await runInDurableObject(stub, (_instance, state) => {
      expect(readSchemaVersion(state.storage.sql)).toBe(WORKSPACE_MIGRATIONS.length);
    });
  });
});
