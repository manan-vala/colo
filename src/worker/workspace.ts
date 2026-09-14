import { DurableObject } from "cloudflare:workers";
import type { HealthResponse } from "../shared/protocol";
import { migrate } from "./db";

/**
 * The single Workspace Durable Object (named "default"). Holds all Colo data in
 * its embedded SQLite database; auth, notes and WebSockets arrive in M1–M3.
 */
export class Workspace extends DurableObject<Env> {
  private schemaVersion = 0;
  private colo: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = migrate(ctx.storage);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { Allow: "GET" } });
      }
      const body: HealthResponse = {
        ok: true,
        schemaVersion: this.schemaVersion,
        colo: await this.lookupColo(),
      };
      return Response.json(body);
    }

    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  /**
   * The runtime does not expose where a Durable Object runs, so ask Cloudflare's
   * trace endpoint which data centre this object's subrequests leave from.
   * Cached for the life of the instance; null if the lookup fails.
   */
  private async lookupColo(): Promise<string | null> {
    if (this.colo) return this.colo;
    try {
      const response = await fetch("https://cloudflare.com/cdn-cgi/trace", {
        signal: AbortSignal.timeout(1500),
      });
      const match = /^colo=(\w+)$/m.exec(await response.text());
      if (match) this.colo = match[1];
      return this.colo ?? null;
    } catch {
      return null;
    }
  }
}
