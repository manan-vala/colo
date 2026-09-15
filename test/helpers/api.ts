import { exports } from "cloudflare:workers";
import type { CreateInviteResponse } from "../../src/shared/protocol";
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

export async function invite(email: string, name: string): Promise<CreateInviteResponse & { token: string }> {
  const response = await call("/api/admin/invites", {
    body: { email, name },
    origin: null,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (response.status !== 201) throw new Error(`invite failed: ${response.status} ${await response.text()}`);
  const body = await response.json<CreateInviteResponse>();
  return { ...body, token: body.url.split("#")[1] };
}

export interface Enrolled {
  cookie: string;
  authenticator: SoftAuthenticator;
  memberId: string;
  inviteToken: string;
}

/** Invites a member and registers a software passkey. */
export async function enroll(
  email = `m${crypto.randomUUID().slice(0, 8)}@example.com`,
  name = "Test Member",
): Promise<Enrolled> {
  const { token, memberId } = await invite(email, name);
  const authenticator = await createSoftAuthenticator();
  const { challengeId, options } = await (
    await call("/api/auth/register/options", { body: { inviteToken: token } })
  ).json<{ challengeId: string; options: any }>();
  const response = await call("/api/auth/register/verify", {
    body: { inviteToken: token, challengeId, response: await authenticator.register(options, ORIGIN) },
  });
  if (response.status !== 200) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  return { cookie: cookieFrom(response), authenticator, memberId, inviteToken: token };
}

export async function signIn(authenticator: SoftAuthenticator): Promise<Response> {
  const { challengeId, options } = await (await call("/api/auth/login/options", { body: {} })).json<{
    challengeId: string;
    options: any;
  }>();
  return call("/api/auth/login/verify", {
    body: { challengeId, response: await authenticator.authenticate(options, ORIGIN) },
  });
}
