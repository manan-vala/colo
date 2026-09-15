import { DurableObject } from "cloudflare:workers";
import type {
  CreateDocumentRequest,
  CreateInviteRequest,
  HealthResponse,
  ListDocumentsResponse,
  LoginVerifyRequest,
  MeResponse,
  RegisterOptionsRequest,
  RegisterVerifyRequest,
  RenameDocumentRequest,
} from "../shared/protocol";
import { Auth, clearedSessionCookie, type Session } from "./auth";
import { WORKSPACE_MIGRATIONS, migrate } from "./db";
import { Documents, type DocumentIdentity, type DocumentMeta } from "./documents";
import { HttpError, errorResponse, json, readJson, safeEqual } from "./http";

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
    try {
      return await this.route(request);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    const route = `${method} ${pathname}`;

    switch (route) {
      case "GET /api/health": {
        const body: HealthResponse = { ok: true, schemaVersion: this.schemaVersion, colo: await this.lookupColo() };
        return json(body);
      }

      case "GET /api/me": {
        const session = await this.auth.authenticate(request.headers.get("Cookie"));
        if (!session) throw new HttpError(401, "UNAUTHORIZED");
        const body: MeResponse = { member: session.member };
        return json(body, session.setCookie ? { headers: { "Set-Cookie": session.setCookie } } : {});
      }

      case "POST /api/admin/invites": {
        await this.requireAdmin(request);
        return json(await this.auth.createInvite(await readJson<CreateInviteRequest>(request)), { status: 201 });
      }

      case "POST /api/auth/register/options":
        return json(await this.auth.registrationOptions(await readJson<RegisterOptionsRequest>(request)));

      case "POST /api/auth/register/verify": {
        const { member, cookie } = await this.auth.verifyRegistration(await readJson<RegisterVerifyRequest>(request));
        return json({ member } satisfies MeResponse, { headers: { "Set-Cookie": cookie } });
      }

      case "POST /api/auth/login/options":
        return json(await this.auth.loginOptions());

      case "POST /api/auth/login/verify": {
        const { member, cookie } = await this.auth.verifyLogin(await readJson<LoginVerifyRequest>(request));
        return json({ member } satisfies MeResponse, { headers: { "Set-Cookie": cookie } });
      }

      case "POST /api/auth/logout": {
        const sessionHash = await this.auth.logout(request.headers.get("Cookie"));
        if (sessionHash) await this.documents.closeSession(sessionHash);
        return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
      }

      case "GET /api/docs": {
        await this.requireSession(request);
        return json({ documents: this.documents.list() } satisfies ListDocumentsResponse);
      }

      case "POST /api/docs": {
        const session = await this.requireSession(request);
        const body = await readJson<CreateDocumentRequest>(request);
        return json(await this.documents.create(session.member, body.title), { status: 201 });
      }
    }

    const docRoute = /^\/api\/docs\/([^/]+)$/.exec(pathname);
    if (docRoute) {
      const session = await this.requireSession(request);
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

    if (pathname === "/api/health" || pathname.startsWith("/api/auth/") || pathname === "/api/me" || pathname === "/api/docs") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    }
    throw new HttpError(404, "NOT_FOUND");
  }

  private async requireSession(request: Request): Promise<Session> {
    const session = await this.auth.authenticate(request.headers.get("Cookie"));
    if (!session) throw new HttpError(401, "UNAUTHORIZED");
    return session;
  }

  // ---- RPC ---------------------------------------------------------------------

  /** Called by the Worker before forwarding a document WebSocket (plan §2.3). */
  async authorizeDocument(
    cookieHeader: string | null,
    docId: string,
  ): Promise<{ ok: true; identity: DocumentIdentity } | { ok: false; status: number; error: string }> {
    try {
      const session = await this.auth.authenticate(cookieHeader);
      if (!session) return { ok: false, status: 401, error: "UNAUTHORIZED" };
      return { ok: true, identity: this.documents.authorize(session.member, session.idHash, session.expiresAt, docId) };
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
