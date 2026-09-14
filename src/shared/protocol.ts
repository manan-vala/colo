/**
 * Contract shared by the SPA and the Worker. WebSocket message types (§4.2)
 * are added in M2.
 */

/** Body of `GET /api/health` (§4.1). */
export interface HealthResponse {
  ok: true;
  /** Schema version of the Workspace Durable Object's SQLite database. */
  schemaVersion: number;
  /** Cloudflare data centre (IATA code) the Workspace object runs in, if known. */
  colo: string | null;
}
