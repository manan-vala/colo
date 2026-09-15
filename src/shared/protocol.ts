/** Contract shared by the SPA and the Worker (plan §4). */

/** Body of `GET /api/health`. */
export interface HealthResponse {
  ok: true;
  /** Schema version of the Workspace Durable Object's SQLite database. */
  schemaVersion: number;
  /** Cloudflare data centre (IATA code) the Workspace object runs in, if known. */
  colo: string | null;
}

export interface Member {
  id: string;
  email: string;
  displayName: string;
}

/** Body of `GET /api/me`. */
export interface MeResponse {
  member: Member;
}

export interface ApiError {
  error: string;
  message?: string;
}

/** `POST /api/admin/invites` */
export interface CreateInviteRequest {
  email: string;
  name: string;
}
export interface CreateInviteResponse {
  memberId: string;
  url: string;
  expiresAt: string;
}

/** `POST /api/auth/register/options` */
export interface RegisterOptionsRequest {
  inviteToken: string;
}
/** `POST /api/auth/register/verify` */
export interface RegisterVerifyRequest {
  inviteToken: string;
  challengeId: string;
  response: unknown;
}
/** `POST /api/auth/login/verify` */
export interface LoginVerifyRequest {
  challengeId: string;
  response: unknown;
}
/** Returned by both `options` endpoints; `options` is WebAuthn options JSON. */
export interface CeremonyOptionsResponse<T> {
  challengeId: string;
  options: T;
}

export const SESSION_COOKIE = "__Host-colo_session";
