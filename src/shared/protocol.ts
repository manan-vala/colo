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
  /** One image after compression in the browser (plan §2.3). */
  imageBytes: 1_000_000,
  /** Longest side the browser scales images down to. */
  imageMaxSide: 2048,
  /** All images of one document together. */
  documentImageBytes: 200_000_000,
  /** Restore points kept per document; the oldest automatic ones are dropped first. */
  restorePoints: 50,
  restorePointLabelLength: 100,
} as const;

// ---- images (M6) ----------------------------------------------------------------

/** Image types the Document object stores; SVG is refused (it can carry script). */
export const IMAGE_TYPES = ["image/webp", "image/png", "image/jpeg", "image/gif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const isImageType = (value: string): value is ImageType => (IMAGE_TYPES as readonly string[]).includes(value);

/** Where an uploaded image is served; also the `src` stored in the document. */
export const imagePath = (docId: string, imageId: string) => `/api/docs/${docId}/images/${imageId}`;

/** Matches `imagePath`, for accepting only Colo's own images in pasted content. */
export const IMAGE_PATH = /^\/api\/docs\/[0-9A-HJKMNP-TV-Z]{26}\/images\/[0-9A-HJKMNP-TV-Z]{26}$/;

// ---- restore points (M6) ------------------------------------------------------------

/**
 * `auto`: taken before a stretch of editing; `named`: saved by someone; `pre-restore`: the
 * document just before a restore; `import`: the document before a DOCX import (M7).
 */
export type RestorePointKind = "auto" | "named" | "pre-restore" | "import";

export interface RestorePoint {
  id: string;
  kind: RestorePointKind;
  label: string | null;
  createdAt: string;
  /** Null for automatic points. */
  createdBy: PersonRef | null;
  /** Size of the saved Yjs state. */
  bytes: number;
}

/** `GET /api/docs/:id/restore-points`, newest first */
export interface ListRestorePointsResponse {
  points: RestorePoint[];
}
/** `POST /api/docs/:id/restore-points` */
export interface CreateRestorePointRequest {
  label: string;
  /** "import": saved before a file replaces the document. Named by default. */
  kind?: "named" | "import";
}
/** `POST /api/docs/:id/restore-points/:pointId/restore` */
export interface RestoreResponse {
  restored: RestorePoint;
  /** The `pre-restore` point holding the document as it was just before. */
  saved: RestorePoint;
}

/** `POST /api/docs/:id/images` (raw image body) */
export interface UploadImageResponse {
  id: string;
  url: string;
}

/** Server → client control events, sent as y-partyserver custom string messages. */
export type ControlEvent =
  | { type: "saved"; at: string }
  | { type: "session-expired" }
  | { type: "document-deleted" }
  /** Someone restored a restore point; `by` is their display name. */
  | { type: "restored"; by: string; at: string }
  | { type: "limit"; code: "MESSAGE_TOO_LARGE" | "RATE_LIMITED" | "DOCUMENT_TOO_LARGE" };

/** WebSocket close codes used by the Document object. */
export const CLOSE_CODES = {
  sessionExpired: 4001,
  unauthorized: 4003,
  documentDeleted: 4004,
  rateLimited: 4008,
  messageTooLarge: 1009,
} as const;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Document, image and restore point IDs are ULIDs. */
export const isUlid = (value: string) => ULID.test(value);
export const isDocumentId = isUlid;

/** Stable cursor colour for a member. */
export function memberColor(memberId: string): string {
  const palette = ["#1a73e8", "#e8710a", "#188038", "#d93025", "#9334e6", "#007b83", "#b06000", "#c5221f"];
  let hash = 0;
  for (const char of memberId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}
