import { DurableObject } from "cloudflare:workers";
import {
  BACKUP_BATCH_BYTES,
  type CreateDocumentRequest,
  type CreateInviteRequest,
  type HealthResponse,
  type ListDocumentsResponse,
  type LoginVerifyRequest,
  type MeResponse,
  type RegisterOptionsRequest,
  type RegisterVerifyRequest,
  type RenameDocumentRequest,
  type RestoreBackupResponse,
} from "../shared/protocol";
import { Auth, clearedSessionCookie, type Session } from "./auth";
import { applyRecords, ndjsonResponse, parseRecords, workspaceBackup } from "./backup";
import { DOCUMENT_MIGRATIONS, WORKSPACE_MIGRATIONS, migrate } from "./db";
import { Documents, type DocumentIdentity, type DocumentMeta } from "./documents";
import { HttpError, errorResponse, json, readJson, safeEqual } from "./http";

/** The cookie to re-issue when a request extended its session. */
type RenewedCookie = { value: string | null };

/**
 * The single Workspace Durable Object (named "default"): members, passkeys,
 * sessions, invites and the document index (plan §2.1).
 */
export class Workspace extends DurableObject<Env> {
  private schemaVersion = 0;
  private colo: string | undefined;
  private readonly auth: Auth;
  private readonly documents: Documents;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.auth = new Auth(ctx.storage, env);
    this.documents = new Documents(ctx.storage, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = migrate(ctx.storage, WORKSPACE_MIGRATIONS);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const renewed: RenewedCookie = { value: null };
    let response: Response;
    try {
      response = await this.route(request, renewed);
    } catch (error) {
      response = errorResponse(error);
    }
    // A session extended while serving this request re-issues its cookie, whatever the route.
    if (renewed.value && !response.headers.has("Set-Cookie")) response.headers.set("Set-Cookie", renewed.value);
    return response;
  }

  private async route(request: Request, renewed: RenewedCookie): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const route = `${method} ${pathname}`;

    switch (route) {
      case "GET /api/health": {
        const body: HealthResponse = { ok: true, schemaVersion: this.schemaVersion, colo: await this.lookupColo() };
        return json(body);
      }

      case "GET /api/me": {
        const session = await this.requireSession(request, renewed);
        return json({ member: session.member } satisfies MeResponse);
      }

      case "POST /api/admin/invites": {
        await this.requireAdmin(request);
        return json(await this.auth.createInvite(await readJson<CreateInviteRequest>(request)), { status: 201 });
      }

      case "POST /api/auth/register/options":
        return json(await this.auth.registrationOptions(await readJson<RegisterOptionsRequest>(request)));

      case "POST /api/auth/register/verify": {
        const { member, cookie } = await this.auth.verifyRegistration(await readJson<RegisterVerifyRequest>(request));
        this.documents.pruneSessions();
        return json({ member } satisfies MeResponse, { headers: { "Set-Cookie": cookie } });
      }

      case "POST /api/auth/login/options":
        return json(await this.auth.loginOptions());

      case "POST /api/auth/login/verify": {
        const { member, cookie } = await this.auth.verifyLogin(await readJson<LoginVerifyRequest>(request));
        this.documents.pruneSessions();
        return json({ member } satisfies MeResponse, { headers: { "Set-Cookie": cookie } });
      }

      case "POST /api/auth/logout": {
        const sessionHash = await this.auth.logout(request.headers.get("Cookie"));
        if (sessionHash) await this.documents.closeSession(sessionHash);
        return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
      }

      case "GET /api/docs": {
        await this.requireSession(request, renewed);
        return json({ documents: this.documents.list() } satisfies ListDocumentsResponse);
      }

      case "POST /api/docs": {
        const session = await this.requireSession(request, renewed);
        const body = await readJson<CreateDocumentRequest>(request);
        return json(await this.documents.create(session.member, body.title), { status: 201 });
      }

      case "GET /api/export": {
        await this.requireSession(request, renewed);
        return this.exportBackup();
      }

      case "POST /api/admin/restore": {
        await this.requireAdmin(request);
        return json(await this.restoreBackup(request, url.searchParams.get("overwrite") === "1"));
      }
    }

    const docRoute = /^\/api\/docs\/([^/]+)$/.exec(pathname);
    if (docRoute) {
      const session = await this.requireSession(request, renewed);
      const id = docRoute[1];
      switch (method) {
        case "GET":
          return json(this.documents.get(id));
        case "PATCH": {
          const body = await readJson<RenameDocumentRequest>(request);
          return json(await this.documents.rename(session.member, id, body.title));
        }
        case "DELETE":
          await this.documents.remove(id);
          return json({ ok: true });
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    }

    if (
      pathname === "/api/health" ||
      pathname.startsWith("/api/auth/") ||
      pathname === "/api/me" ||
      pathname === "/api/docs" ||
      pathname === "/api/export"
    ) {
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    }
    throw new HttpError(404, "NOT_FOUND");
  }

  private async requireSession(request: Request, renewed: RenewedCookie): Promise<Session> {
    const session = await this.auth.authenticate(request.headers.get("Cookie"));
    if (!session) throw new HttpError(401, "UNAUTHORIZED");
    if (session.setCookie) renewed.value = session.setCookie;
    return session;
  }

  // ---- backup (plan §8.5) ------------------------------------------------------

  /** Streams the whole workspace as NDJSON; each document's own object adds its records. */
  private exportBackup(): Response {
    const day = new Date().toISOString().slice(0, 10);
    return ndjsonResponse(
      workspaceBackup(this.ctx.storage.sql, {
        origin: this.env.ORIGIN,
        schema: { workspace: this.schemaVersion, document: DOCUMENT_MIGRATIONS.length },
        fetchDocument: (id) => this.documents.request(id, "export"),
      }),
      { "Content-Disposition": `attachment; filename="colo-backup-${day}.ndjson"` },
    );
  }

  /** Applies one NDJSON batch from `scripts/restore.ts`; only ever reachable with ADMIN_TOKEN. */
  private async restoreBackup(request: Request, overwrite: boolean): Promise<RestoreBackupResponse> {
    const text = await request.text();
    if (text.length > BACKUP_BATCH_BYTES) throw new HttpError(413, "TOO_LARGE");
    return applyRecords(parseRecords(text), {
      storage: this.ctx.storage,
      schemaVersion: this.schemaVersion,
      overwrite,
      toDocument: async (id, action, body) => {
        const response = await this.documents.request(id, action, body);
        if (response.ok) return;
        // The document object does the validating, so its own status and code reach the script
        // rather than being flattened into one "something went wrong".
        const failure = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new HttpError(response.status, failure?.error ?? "RESTORE_FAILED", failure?.message);
      },
    });
  }

  // ---- RPC ---------------------------------------------------------------------

  /** Called by the Worker before forwarding a document WebSocket (plan §2.3). */
  async authorizeDocument(
    cookieHeader: string | null,
    docId: string,
  ): Promise<{ ok: true; identity: DocumentIdentity } | { ok: false; status: number; error: string }> {
    try {
      // A WebSocket upgrade cannot re-issue the cookie, so it never extends the session.
      const session = await this.auth.authenticate(cookieHeader, { slide: false });
      if (!session) return { ok: false, status: 401, error: "UNAUTHORIZED" };
      return { ok: true, identity: this.documents.authorize(session.member, session.idHash, session.expiresAt, docId) };
    } catch (error) {
      if (error instanceof HttpError) return { ok: false, status: error.status, error: error.code };
      throw error;
    }
  }

  /**
   * Called by the Worker before forwarding a document HTTP request (images, restore points).
   * Unlike a socket, a request needs no revocation record, so this writes nothing.
   */
  async authorizeRequest(
    cookieHeader: string | null,
    docId: string,
  ): Promise<{ ok: true; identity: DocumentIdentity } | { ok: false; status: number; error: string }> {
    try {
      const session = await this.auth.authenticate(cookieHeader, { slide: false });
      if (!session) return { ok: false, status: 401, error: "UNAUTHORIZED" };
      return { ok: true, identity: this.documents.identify(session.member, session.idHash, session.expiresAt, docId) };
    } catch (error) {
      if (error instanceof HttpError) return { ok: false, status: error.status, error: error.code };
      throw error;
    }
  }

  /** Called by Document objects after saving (throttled to once a minute per document). */
  async updateDocumentMeta(docId: string, meta: DocumentMeta): Promise<void> {
    this.documents.updateMeta(docId, meta);
  }

  /** `Authorization: Bearer <ADMIN_TOKEN>`; the endpoint does not exist while the secret is unset. */
  private async requireAdmin(request: Request) {
    const expected = this.env.ADMIN_TOKEN;
    if (!expected) throw new HttpError(404, "NOT_FOUND");
    const header = request.headers.get("Authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!(await safeEqual(provided, expected))) throw new HttpError(401, "UNAUTHORIZED");
  }

  /**
   * The runtime does not expose where a Durable Object runs, so ask Cloudflare's
   * trace endpoint which data centre this object's subrequests leave from.
   * Cached for the life of the instance; null if the lookup fails.
   */
  private async lookupColo(): Promise<string | null> {
    if (this.colo) return this.colo;
    try {
      const response = await fetch("https://cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(1500) });
      const match = /^colo=(\w+)$/m.exec(await response.text());
      if (match) this.colo = match[1];
      return this.colo ?? null;
    } catch {
      return null;
    }
  }
}
