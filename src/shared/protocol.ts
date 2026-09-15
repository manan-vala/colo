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

// ---- documents (M2) ----------------------------------------------------------

export interface PersonRef {
  id: string;
  displayName: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: string;
  createdBy: PersonRef;
  updatedAt: string;
  updatedBy: PersonRef;
}

/** `GET /api/docs` */
export interface ListDocumentsResponse {
  documents: DocumentSummary[];
}
/** `POST /api/docs` */
export interface CreateDocumentRequest {
  title?: string;
}
/** `PATCH /api/docs/:id` */
export interface RenameDocumentRequest {
  title: string;
}

/** Limits enforced by the Document Durable Object (plan §4.3). */
export const LIMITS = {
  titleLength: 200,
  messageBytes: 1_000_000,
  /** Token bucket: sustained rate and burst size for incoming WebSocket messages. */
  messagesPerSecond: 30,
  messageBurst: 600,
  docStateBytes: 25_000_000,
} as const;

/** Server → client control events, sent as y-partyserver custom string messages. */
export type ControlEvent =
  | { type: "saved"; at: string }
  | { type: "session-expired" }
  | { type: "document-deleted" }
  | { type: "limit"; code: "MESSAGE_TOO_LARGE" | "RATE_LIMITED" | "DOCUMENT_TOO_LARGE" };

/** WebSocket close codes used by the Document object. */
export const CLOSE_CODES = {
  sessionExpired: 4001,
  unauthorized: 4003,
  documentDeleted: 4004,
  rateLimited: 4008,
  messageTooLarge: 1009,
} as const;

const DOC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isDocumentId = (value: string) => DOC_ID.test(value);

/** Stable cursor colour for a member. */
export function memberColor(memberId: string): string {
  const palette = ["#1a73e8", "#e8710a", "#188038", "#d93025", "#9334e6", "#007b83", "#b06000", "#c5221f"];
  let hash = 0;
  for (const char of memberId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}
