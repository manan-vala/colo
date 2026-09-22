import { env, exports } from "cloudflare:workers";
import type { EnrollTokenResponse } from "../../src/shared/protocol";
import type { RpcResult } from "../../src/worker/workspace";
import { createSoftAuthenticator, type SoftAuthenticator } from "./authenticator";

/** Must match the bindings in vitest.config.ts. */
export const ORIGIN = "https://colo.example";
export const ADMIN_TOKEN = "test-admin-token";

export interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  /** Defaults to ORIGIN for non-GET requests; null sends no Origin header. */
  origin?: string | null;
  headers?: Record<string, string>;
}

export function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.cookie) headers.Cookie = options.cookie;
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  if (options.origin !== null && method !== "GET") headers.Origin = options.origin ?? ORIGIN;
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export function cookieFrom(response: Response): string {
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0];
}

export const PASSWORD = "correct horse battery staple";

/** A Workspace RPC's value, or the failure it carried back (see `RpcResult`). */
export function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.status} ${result.error}: ${result.message}`);
  return result.value;
}

export interface Enrolled {
  cookie: string;
  memberId: string;
  email: string;
  password: string;
}

/**
 * Adds a member to a workspace object and signs them in. It calls the workspace directly, not
 * the owner's API, so that a test file's many members never meet a member cap; the owner's API
 * has its own tests in `admin.test.ts`.
 */
export async function enroll(
  email = `m${crypto.randomUUID().slice(0, 8)}@example.com`,
  name = "Test Member",
  { workspace = "main", object = "default" }: { workspace?: string; object?: string } = {},
): Promise<Enrolled> {
  const { member } = unwrap(
    await env.WORKSPACE.getByName(object).addMember({ email, name, password: PASSWORD }, Number.MAX_SAFE_INTEGER),
  );
  const response = await signIn(email, PASSWORD, workspace);
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return { cookie: cookieFrom(response), memberId: member.id, email, password: PASSWORD };
}

export function signIn(email: string, password = PASSWORD, workspace = "main"): Promise<Response> {
  return call("/api/auth/login", { body: { workspace, email, password } });
}

/** Enrolls a software passkey as the owner and returns the owner's dashboard cookie. */
export async function ownerSession(authenticator?: SoftAuthenticator): Promise<{ cookie: string; authenticator: SoftAuthenticator }> {
  const tokenResponse = await call("/api/admin/enroll-token", {
    body: {},
    origin: null,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (tokenResponse.status !== 201) throw new Error(`enroll token failed: ${tokenResponse.status}`);
  const token = (await tokenResponse.json<EnrollTokenResponse>()).url.split("#")[1];
  const owner = authenticator ?? (await createSoftAuthenticator());
  const { challengeId, options } = await (await call("/api/admin/enroll/options", { body: { token } })).json<{
    challengeId: string;
    options: any;
  }>();
  const response = await call("/api/admin/enroll/verify", {
    body: { token, challengeId, response: await owner.register(options, ORIGIN) },
  });
  if (response.status !== 200) throw new Error(`owner enroll failed: ${response.status} ${await response.text()}`);
  return { cookie: cookieFrom(response), authenticator: owner };
}
