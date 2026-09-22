import { DurableObject } from "cloudflare:workers";
import {
  BACKUP_BATCH_BYTES,
  type AddMemberRequest,
  type AdminMember,
  type ChangePasswordRequest,
  type CreateDocumentRequest,
  type HealthResponse,
  type ListDocumentsResponse,
  type LoginRequest,
  type MeResponse,
  type RenameDocumentRequest,
  type RestoreBackupResponse,
  type UpdateMemberRequest,
  type WorkspaceRef,
} from "../shared/protocol";
import { Auth, clearedSessionCookie, toMember, type MemberRow, type Session } from "./auth";
import { applyRecords, ndjsonResponse, parseRecords, workspaceBackup } from "./backup";
import { DOCUMENT_MIGRATIONS, WORKSPACE_MIGRATIONS, migrate } from "./db";
import { Documents, type DocumentIdentity, type DocumentMeta } from "./documents";
import { HttpError, errorResponse, isoNow, json, readJson, safeEqual, ulid } from "./http";
import { generatePassword, validatePassword } from "./passwords";

/** The cookie to re-issue when a request extended its session. */
type RenewedCookie = { value: string | null };

/**
 * What an RPC the Admin object calls hands back. Workers RPC keeps an exception's message but not
 * its class, so an HttpError would arrive as a plain Error and turn into a 500; this carries its
 * status and code across instead, and `unwrap` in the Admin object throws it again.
 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; message: string };

async function asResult<T>(run: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, status: error.status, error: error.code, message: error.message };
    throw error;
  }
}

/** What the Admin object tells a workspace about itself (M9). */
export interface WorkspaceInfo {
  slug: string;
  name: string;
  disabledAt: string | null;
}

type AdminMemberRow = MemberRow & {
  created_at: string;
  password_hash: string | null;
  last_login_at: string | null;
};

const ADMIN_MEMBER_SELECT = `
  SELECT id, email, display_name, created_at, disabled_at, password_hash, last_login_at FROM members`;

const toAdminMember = (row: AdminMemberRow): AdminMember => ({
  ...toMember(row),
  createdAt: row.created_at,
  disabledAt: row.disabled_at,
  hasPassword: row.password_hash !== null,
  lastLoginAt: row.last_login_at,
});

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new HttpError(400, "INVALID", `${field} is required`);
  }
  return value.trim().replace(/\s+/g, " ");
}

/**
 * One Workspace Durable Object per workspace (M9): its members, their passwords and sessions,
 * and its document index (plan §2.1). The workspace from before M9 is the object "default";
 * later ones are `ws-` and a ULID. The Admin object keeps the registry of slugs.
 */
export class Workspace extends DurableObject<Env> {
  private schemaVersion = 0;
  private colo: string | undefined;
  /** This object's name: session cookies carry it, and documents send their metadata to it. */
  private readonly name: string;
  private readonly auth: Auth;
  private readonly documents: Documents;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.name = ctx.id.name ?? "default";
    this.auth = new Auth(ctx.storage, this.name);
    this.documents = new Documents(ctx.storage, env, this.name);
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
        return json({ member: session.member, workspace: this.info() } satisfies MeResponse);
      }

      // The Worker has already turned the body's workspace slug into this object.
      case "POST /api/auth/login": {
        const { member, cookie } = await this.auth.login(await readJson<LoginRequest>(request));
        this.documents.pruneSessions();
        return json({ member, workspace: this.info() } satisfies MeResponse, { headers: { "Set-Cookie": cookie } });
      }

      case "POST /api/auth/password": {
        const session = await this.requireSession(request, renewed);
        const ended = await this.auth.changePassword(session, await readJson<ChangePasswordRequest>(request));
        await this.closeSessions(ended);
        return json({ ok: true });
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

  /** The slug and name for `/api/me`; the object's own name until the Admin object configures it. */
  private info(): WorkspaceRef {
    const row = this.ctx.storage.sql
      .exec<{ slug: string; name: string }>("SELECT slug, name FROM workspace_info WHERE id = 1")
      .toArray()[0];
    return row ? { slug: row.slug, name: row.name } : { slug: this.name, name: this.name };
  }

  private async closeSessions(hashes: string[]): Promise<void> {
    await Promise.all(hashes.map((hash) => this.documents.closeSession(hash)));
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

  // ---- members, called by the Admin object (M9) ----------------------------------

  /** Records the slug and name the Admin object holds; disabling signs everyone out. */
  async configure(info: WorkspaceInfo): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO workspace_info (id, slug, name, disabled_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, name = excluded.name, disabled_at = excluded.disabled_at`,
      info.slug,
      info.name,
      info.disabledAt,
    );
    if (info.disabledAt) await this.closeSessions(this.auth.endAllSessions());
  }

  /** Members who can sign in, and live documents. */
  async stats(): Promise<{ members: number; documents: number }> {
    const { sql } = this.ctx.storage;
    return {
      members: this.activeMembers(),
      documents: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL").one().n,
    };
  }

  async listMembers(): Promise<AdminMember[]> {
    return this.ctx.storage.sql
      .exec<AdminMemberRow>(`${ADMIN_MEMBER_SELECT} ORDER BY created_at, id`)
      .toArray()
      .map(toAdminMember);
  }

  /** Adds a member with a password — generated when none is given, and returned only here. */
  async addMember(input: AddMemberRequest, maxMembers: number): Promise<RpcResult<{ member: AdminMember; password: string }>> {
    return asResult(() => this.insertMember(input, maxMembers));
  }

  private async insertMember(input: AddMemberRequest, maxMembers: number): Promise<{ member: AdminMember; password: string }> {
    const email = requireText(input.email, "email", 320).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "INVALID", "email is invalid");
    const name = requireText(input.name, "name", 80);
    const password = input.password ? validatePassword(input.password) : generatePassword();
    const { sql } = this.ctx.storage;
    if (sql.exec("SELECT 1 FROM members WHERE email = ?", email).toArray().length > 0) {
      throw new HttpError(409, "EMAIL_TAKEN", `${email} is already a member of this workspace`);
    }
    this.requireSeat(maxMembers);
    const id = ulid();
    sql.exec("INSERT INTO members (id, email, display_name, created_at) VALUES (?, ?, ?, ?)", id, email, name, isoNow());
    try {
      await this.auth.setPassword(id, password);
    } catch (error) {
      // A refused password must not leave behind a member nobody can sign in as.
      sql.exec("DELETE FROM members WHERE id = ?", id);
      throw error;
    }
    return { member: this.member(id), password };
  }

  /**
   * Renames, disables or re-enables a member, or sets a new password. Disabling and a new
   * password sign the member out everywhere; re-enabling takes a seat, so it checks the cap.
   */
  async updateMember(
    id: string,
    change: UpdateMemberRequest,
    maxMembers: number,
  ): Promise<RpcResult<{ member: AdminMember; password?: string }>> {
    return asResult(() => this.changeMember(id, change, maxMembers));
  }

  private async changeMember(
    id: string,
    change: UpdateMemberRequest,
    maxMembers: number,
  ): Promise<{ member: AdminMember; password?: string }> {
    const before = this.member(id);
    const { sql } = this.ctx.storage;
    // Everything is checked before anything is written, so a bad field changes nothing.
    const name = change.name === undefined ? undefined : requireText(change.name, "name", 80);
    if (change.disabled === false && before.disabledAt) this.requireSeat(maxMembers);
    let password: string | undefined;
    if (change.password !== undefined) {
      password = change.password === true ? generatePassword() : change.password;
      await this.auth.setPassword(id, password);
    }
    if (name !== undefined) sql.exec("UPDATE members SET display_name = ? WHERE id = ?", name, id);
    if (change.disabled === false && before.disabledAt) sql.exec("UPDATE members SET disabled_at = NULL WHERE id = ?", id);
    if (change.disabled === true && !before.disabledAt) {
      sql.exec("UPDATE members SET disabled_at = ? WHERE id = ?", isoNow(), id);
    }
    if (password !== undefined || change.disabled === true) await this.closeSessions(this.auth.endSessions(id));
    return { member: this.member(id), password };
  }

  private member(id: string): AdminMember {
    const row = this.ctx.storage.sql.exec<AdminMemberRow>(`${ADMIN_MEMBER_SELECT} WHERE id = ?`, id).toArray()[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such member");
    return toAdminMember(row);
  }

  private activeMembers(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE disabled_at IS NULL").one().n;
  }

  private requireSeat(maxMembers: number) {
    if (this.activeMembers() >= maxMembers) {
      throw new HttpError(409, "WORKSPACE_FULL", `This workspace already has its maximum of ${maxMembers} members`);
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
