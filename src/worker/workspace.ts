import { DurableObject } from "cloudflare:workers";
import type {
  CreateInviteRequest,
  HealthResponse,
  LoginVerifyRequest,
  MeResponse,
  RegisterOptionsRequest,
  RegisterVerifyRequest,
} from "../shared/protocol";
import { Auth, clearedSessionCookie } from "./auth";
import { WORKSPACE_MIGRATIONS, migrate } from "./db";
import { HttpError, errorResponse, json, readJson, safeEqual } from "./http";

/**
 * The single Workspace Durable Object (named "default"): members, passkeys,
 * sessions and invites (plan §2.1).
 */
export class Workspace extends DurableObject<Env> {
  private schemaVersion = 0;
  private colo: string | undefined;
  private readonly auth: Auth;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.auth = new Auth(ctx.storage, env);
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
        await this.auth.logout(request.headers.get("Cookie"));
        return json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
      }
    }

    if (pathname === "/api/health" || pathname.startsWith("/api/auth/") || pathname === "/api/me") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    }
    throw new HttpError(404, "NOT_FOUND");
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
