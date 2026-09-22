import { DurableObject } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  ADMIN_COOKIE,
  DEFAULT_MAX_MEMBERS,
  MAX_MEMBERS_LIMIT,
  WORKSPACE_SLUG,
  type AddMemberRequest,
  type AdminLoginVerifyRequest,
  type AdminMembersResponse,
  type AdminWorkspace,
  type AdminWorkspacesResponse,
  type CreateWorkspaceRequest,
  type EnrollOptionsRequest,
  type EnrollTokenResponse,
  type EnrollVerifyRequest,
  type MemberChangeResponse,
  type UpdateMemberRequest,
  type UpdateWorkspaceRequest,
} from "../shared/protocol";
import { ADMIN_MIGRATIONS, migrate } from "./db";
import type { RpcResult } from "./workspace";
import {
  DAY,
  HOUR,
  HttpError,
  MINUTE,
  errorResponse,
  isoIn,
  isoNow,
  json,
  parseCookies,
  randomToken,
  readJson,
  safeEqual,
  sha256Hex,
  ulid,
} from "./http";

const ENROLL_TTL = DAY;
const CHALLENGE_TTL = 5 * MINUTE;
/** The owner's session: short and never extended, since it can change every workspace. */
const SESSION_TTL = 12 * HOUR;
const RP_NAME = "Colo";
/** ES256 and RS256 (Windows Hello). */
const ALGORITHMS = [-7, -257];
/** The WebAuthn user handle for the owner; there is exactly one owner. */
const OWNER_ID = "colo-owner";

type WorkspaceRow = {
  slug: string;
  do_name: string;
  name: string;
  max_members: number;
  disabled_at: string | null;
  created_at: string;
  synced: number;
};

/** Throws a Workspace RPC's failure again as the HttpError it was. */
function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new HttpError(result.status, result.error, result.message);
  return result.value;
}

function adminCookie(token: string, maxAge = SESSION_TTL / 1000): string {
  return `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function requireSlug(value: unknown): string {
  if (typeof value !== "string" || !WORKSPACE_SLUG.test(value)) {
    throw new HttpError(
      400,
      "INVALID",
      "A workspace ID is 2 to 40 lower-case letters, digits and hyphens, starting with a letter or digit",
    );
  }
  return value;
}

function requireName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 80) {
    throw new HttpError(400, "INVALID", "A workspace name of 1 to 80 characters is required");
  }
  return value.trim().replace(/\s+/g, " ");
}

function requireMaxMembers(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_MEMBERS_LIMIT) {
    throw new HttpError(400, "INVALID", `Maximum members must be a whole number from 1 to ${MAX_MEMBERS_LIMIT}`);
  }
  return value;
}

/**
 * The owner's dashboard (M9, ADR 0006): one Durable Object named "admin" holding the workspace
 * registry — slug, object name, member cap — and the owner's passkeys and sessions. It is off
 * the path of every ordinary request: session cookies name their workspace object, so only
 * sign-in asks this object to turn a slug into a workspace.
 */
export class Admin extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, ADMIN_MIGRATIONS);
    });
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // ---- RPC -----------------------------------------------------------------------

  /** The workspace object for a slug, or null if there is none or it is disabled. */
  async resolve(slug: string): Promise<string | null> {
    const row = this.sql
      .exec<WorkspaceRow>("SELECT * FROM workspaces WHERE slug = ?", typeof slug === "string" ? slug.trim().toLowerCase() : "")
      .toArray()[0];
    if (!row || row.disabled_at) return null;
    await this.sync(row);
    return row.do_name;
  }

  // ---- HTTP ----------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    switch (route) {
      case "POST /api/admin/enroll-token":
        await this.requireToken(request);
        return json(await this.createEnrollToken(), { status: 201 });

      case "POST /api/admin/enroll/options":
        return json(await this.enrollOptions(await readJson<EnrollOptionsRequest>(request)));

      case "POST /api/admin/enroll/verify": {
        const cookie = await this.verifyEnroll(await readJson<EnrollVerifyRequest>(request));
        return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
      }

      case "POST /api/admin/login/options":
        return json(await this.loginOptions());

      case "POST /api/admin/login/verify": {
        const cookie = await this.verifyLogin(await readJson<AdminLoginVerifyRequest>(request));
        return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
      }

      case "POST /api/admin/logout": {
        const token = parseCookies(request.headers.get("Cookie")).get(ADMIN_COOKIE);
        if (token) this.sql.exec("DELETE FROM sessions WHERE id_hash = ?", await sha256Hex(token));
        return json({ ok: true }, { headers: { "Set-Cookie": adminCookie("", 0) } });
      }

      case "GET /api/admin/me":
        await this.requireOwner(request);
        return json({ ok: true });

      case "GET /api/admin/workspaces":
        await this.requireOwner(request);
        return json({ workspaces: await this.listWorkspaces() } satisfies AdminWorkspacesResponse);

      case "POST /api/admin/workspaces":
        await this.requireOwner(request);
        return json(await this.createWorkspace(await readJson<CreateWorkspaceRequest>(request)), { status: 201 });

      // A backup is restored into one workspace, named in the query (§8.5).
      case "POST /api/admin/restore": {
        await this.requireToken(request);
        const slug = url.searchParams.get("workspace");
        if (!slug) throw new HttpError(400, "INVALID", "Name the workspace to restore into: ?workspace=<id>");
        const row = this.workspace(slug);
        await this.sync(row);
        return this.env.WORKSPACE.getByName(row.do_name, { locationHint: "apac" }).fetch(request);
      }
    }

    const members = /^\/api\/admin\/workspaces\/([^/]+)\/members(?:\/([^/]+))?$/.exec(url.pathname);
    if (members) {
      await this.requireOwner(request);
      const row = this.workspace(members[1]);
      const stub = this.env.WORKSPACE.getByName(row.do_name, { locationHint: "apac" });
      await this.sync(row);
      if (!members[2] && request.method === "GET") {
        return json({ members: await stub.listMembers() } satisfies AdminMembersResponse);
      }
      if (!members[2] && request.method === "POST") {
        const body = await readJson<AddMemberRequest>(request);
        return json(unwrap(await stub.addMember(body, row.max_members)) satisfies MemberChangeResponse, { status: 201 });
      }
      if (members[2] && request.method === "PATCH") {
        const body = await readJson<UpdateMemberRequest>(request);
        return json(unwrap(await stub.updateMember(members[2], body, row.max_members)) satisfies MemberChangeResponse);
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    }

    const workspace = /^\/api\/admin\/workspaces\/([^/]+)$/.exec(url.pathname);
    if (workspace) {
      await this.requireOwner(request);
      if (request.method !== "PATCH") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      return json(await this.updateWorkspace(workspace[1], await readJson<UpdateWorkspaceRequest>(request)));
    }

    throw new HttpError(404, "NOT_FOUND");
  }

  // ---- workspaces ----------------------------------------------------------------

  private workspace(slug: string): WorkspaceRow {
    const row = this.sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE slug = ?", slug).toArray()[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such workspace");
    return row;
  }

  /**
   * Sends a workspace its slug, name and state. Done on every change and, for the workspace that
   * existed before M9 (`synced = 0`), before it is first used.
   */
  private async sync(row: WorkspaceRow, force = false): Promise<void> {
    if (row.synced && !force) return;
    await this.env.WORKSPACE.getByName(row.do_name, { locationHint: "apac" }).configure({
      slug: row.slug,
      name: row.name,
      disabledAt: row.disabled_at,
    });
    if (!row.synced) this.sql.exec("UPDATE workspaces SET synced = 1 WHERE do_name = ?", row.do_name);
    row.synced = 1;
  }

  private async summary(row: WorkspaceRow): Promise<AdminWorkspace> {
    await this.sync(row);
    const stats = await this.env.WORKSPACE.getByName(row.do_name, { locationHint: "apac" }).stats();
    return {
      slug: row.slug,
      name: row.name,
      maxMembers: row.max_members,
      disabledAt: row.disabled_at,
      createdAt: row.created_at,
      members: stats.members,
      documents: stats.documents,
    };
  }

  /** One Workspace request each: fine for the handful of workspaces one Free account can carry. */
  private async listWorkspaces(): Promise<AdminWorkspace[]> {
    const rows = this.sql.exec<WorkspaceRow>("SELECT * FROM workspaces ORDER BY created_at, slug").toArray();
    return Promise.all(rows.map((row) => this.summary(row)));
  }

  private async createWorkspace(body: CreateWorkspaceRequest): Promise<AdminWorkspace> {
    const slug = requireSlug(body.slug);
    const name = requireName(body.name);
    const maxMembers = body.maxMembers === undefined ? DEFAULT_MAX_MEMBERS : requireMaxMembers(body.maxMembers);
    if (this.sql.exec("SELECT 1 FROM workspaces WHERE slug = ?", slug).toArray().length > 0) {
      throw new HttpError(409, "SLUG_TAKEN", `A workspace with the ID ${slug} already exists`);
    }
    // The object name never changes, so renaming the slug leaves sessions and documents alone.
    const row: WorkspaceRow = {
      slug,
      do_name: `ws-${ulid()}`,
      name,
      max_members: maxMembers,
      disabled_at: null,
      created_at: isoNow(),
      synced: 0,
    };
    this.sql.exec(
      "INSERT INTO workspaces (slug, do_name, name, max_members, created_at) VALUES (?, ?, ?, ?, ?)",
      row.slug,
      row.do_name,
      row.name,
      row.max_members,
      row.created_at,
    );
    return this.summary(row);
  }

  private async updateWorkspace(slug: string, body: UpdateWorkspaceRequest): Promise<AdminWorkspace> {
    const row = this.workspace(slug);
    const next = { ...row };
    if (body.slug !== undefined && body.slug !== row.slug) {
      next.slug = requireSlug(body.slug);
      if (this.sql.exec("SELECT 1 FROM workspaces WHERE slug = ?", next.slug).toArray().length > 0) {
        throw new HttpError(409, "SLUG_TAKEN", `A workspace with the ID ${next.slug} already exists`);
      }
    }
    if (body.name !== undefined) next.name = requireName(body.name);
    if (body.maxMembers !== undefined) {
      next.max_members = requireMaxMembers(body.maxMembers);
      const { members } = await this.env.WORKSPACE.getByName(row.do_name, { locationHint: "apac" }).stats();
      if (next.max_members < members) {
        throw new HttpError(
          409,
          "BELOW_MEMBER_COUNT",
          `This workspace has ${members} members; disable some before lowering the maximum`,
        );
      }
    }
    if (body.disabled !== undefined) next.disabled_at = body.disabled ? (row.disabled_at ?? isoNow()) : null;

    this.sql.exec(
      "UPDATE workspaces SET slug = ?, name = ?, max_members = ?, disabled_at = ? WHERE do_name = ?",
      next.slug,
      next.name,
      next.max_members,
      next.disabled_at,
      row.do_name,
    );
    await this.sync(next, true);
    return this.summary(next);
  }

  // ---- owner passkeys ------------------------------------------------------------

  /** `Authorization: Bearer <ADMIN_TOKEN>`; the route does not exist while the secret is unset. */
  private async requireToken(request: Request) {
    const expected = this.env.ADMIN_TOKEN;
    if (!expected) throw new HttpError(404, "NOT_FOUND");
    const header = request.headers.get("Authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!(await safeEqual(provided, expected))) throw new HttpError(401, "UNAUTHORIZED");
  }

  private async requireOwner(request: Request) {
    const token = parseCookies(request.headers.get("Cookie")).get(ADMIN_COOKIE);
    if (!token || token.length > 128) throw new HttpError(401, "UNAUTHORIZED");
    const now = isoNow();
    const found = this.sql
      .exec("SELECT 1 FROM sessions WHERE id_hash = ? AND expires_at > ?", await sha256Hex(token), now)
      .toArray();
    if (found.length === 0) throw new HttpError(401, "UNAUTHORIZED");
  }

  /** A one-time link that lets a device add an owner passkey (`npm run admin:enroll`). */
  private async createEnrollToken(): Promise<EnrollTokenResponse> {
    const token = randomToken();
    const expiresAt = isoIn(ENROLL_TTL);
    this.sql.exec("INSERT INTO enroll_tokens (token_hash, expires_at) VALUES (?, ?)", await sha256Hex(token), expiresAt);
    return { url: `${this.env.ORIGIN}/admin/enroll#${token}`, expiresAt };
  }

  private async requireEnrollToken(token: unknown): Promise<string> {
    const hash = await sha256Hex(typeof token === "string" ? token.slice(0, 128) : "");
    const row = this.sql
      .exec<{ expires_at: string; used_at: string | null }>(
        "SELECT expires_at, used_at FROM enroll_tokens WHERE token_hash = ?",
        hash,
      )
      .toArray()[0];
    if (!row || row.used_at || row.expires_at <= isoNow()) {
      throw new HttpError(400, "ENROLL_INVALID", "This enrollment link is invalid, used or expired");
    }
    return hash;
  }

  private storeChallenge(challenge: string, purpose: "enroll" | "login"): string {
    const id = ulid();
    this.sql.exec("DELETE FROM challenges WHERE expires_at <= ?", isoNow());
    this.sql.exec(
      "INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?)",
      id,
      challenge,
      purpose,
      isoIn(CHALLENGE_TTL),
    );
    return id;
  }

  /** Deletes and returns a challenge so it can be used at most once. */
  private consumeChallenge(id: unknown, purpose: "enroll" | "login"): string {
    const row = this.sql
      .exec<{ challenge: string; purpose: string; expires_at: string }>(
        "DELETE FROM challenges WHERE id = ? RETURNING challenge, purpose, expires_at",
        typeof id === "string" ? id : "",
      )
      .toArray()[0];
    if (!row || row.purpose !== purpose || row.expires_at <= isoNow()) {
      throw new HttpError(400, "CHALLENGE_INVALID", "The sign-in attempt expired; try again");
    }
    return row.challenge;
  }

  private async enrollOptions(body: EnrollOptionsRequest) {
    await this.requireEnrollToken(body.token);
    const existing = this.sql
      .exec<{ credential_id: string; transports: string | null }>("SELECT credential_id, transports FROM passkeys")
      .toArray();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.env.RP_ID,
      userName: "Colo owner",
      userDisplayName: "Colo owner",
      userID: new Uint8Array(new TextEncoder().encode(OWNER_ID)),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.credential_id,
        transports: p.transports ? (JSON.parse(p.transports) as AuthenticatorTransport[]) : undefined,
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    return { challengeId: this.storeChallenge(options.challenge, "enroll"), options };
  }

  private async verifyEnroll(body: EnrollVerifyRequest): Promise<string> {
    const tokenHash = await this.requireEnrollToken(body.token);
    const challenge = this.consumeChallenge(body.challengeId, "enroll");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.env.ORIGIN,
        expectedRPID: this.env.RP_ID,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch (error) {
      throw new HttpError(400, "VERIFICATION_FAILED", error instanceof Error ? error.message : undefined);
    }
    if (!verification.verified) throw new HttpError(400, "VERIFICATION_FAILED");

    const { credential } = verification.registrationInfo;
    const token = randomToken();
    const idHash = await sha256Hex(token);
    const now = isoNow();
    this.ctx.storage.transactionSync(() => {
      // Re-check inside the transaction: another request may have used the token meanwhile.
      const used = this.sql.exec(
        "UPDATE enroll_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
        now,
        tokenHash,
        now,
      );
      if (used.rowsWritten === 0) throw new HttpError(400, "ENROLL_INVALID", "This enrollment link was already used");
      this.sql.exec(
        "INSERT INTO passkeys (credential_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)",
        credential.id,
        credential.publicKey,
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        now,
      );
      this.insertSession(idHash, now);
    });
    return adminCookie(token);
  }

  private async loginOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.env.RP_ID, userVerification: "required" });
    return { challengeId: this.storeChallenge(options.challenge, "login"), options };
  }

  private async verifyLogin(body: AdminLoginVerifyRequest): Promise<string> {
    const challenge = this.consumeChallenge(body.challengeId, "login");
    const response = body.response as AuthenticationResponseJSON;
    const passkey = this.sql
      .exec<{ credential_id: string; public_key: ArrayBuffer; counter: number; transports: string | null }>(
        "SELECT credential_id, public_key, counter, transports FROM passkeys WHERE credential_id = ?",
        typeof response?.id === "string" ? response.id : "",
      )
      .toArray()[0];
    if (!passkey) throw new HttpError(401, "UNKNOWN_PASSKEY", "This passkey is not the owner's");

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.env.ORIGIN,
        expectedRPID: this.env.RP_ID,
        requireUserVerification: true,
        credential: {
          id: passkey.credential_id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: passkey.counter,
          transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
        },
      });
    } catch (error) {
      throw new HttpError(401, "VERIFICATION_FAILED", error instanceof Error ? error.message : undefined);
    }
    if (!verification.verified) throw new HttpError(401, "VERIFICATION_FAILED");

    const token = randomToken();
    const idHash = await sha256Hex(token);
    const now = isoNow();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?",
        verification.authenticationInfo.newCounter,
        now,
        passkey.credential_id,
      );
      this.insertSession(idHash, now);
    });
    return adminCookie(token);
  }

  private insertSession(idHash: string, now: string) {
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.sql.exec("INSERT INTO sessions (id_hash, expires_at) VALUES (?, ?)", idHash, isoIn(SESSION_TTL));
  }
}
