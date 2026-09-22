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

/** The workspace a member signed in to. */
export interface WorkspaceRef {
  slug: string;
  name: string;
}

/** Body of `GET /api/me`. */
export interface MeResponse {
  member: Member;
  workspace: WorkspaceRef;
}

export interface ApiError {
  error: string;
  message?: string;
}

/** `POST /api/auth/login` (M9): a member signs in to one workspace with a password. */
export interface LoginRequest {
  workspace: string;
  email: string;
  password: string;
}
/** `POST /api/auth/password`: a member changes their own password. */
export interface ChangePasswordRequest {
  current: string;
  next: string;
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Lower-case letters, digits and hyphens; starts with a letter or digit. */
export const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;

export const SESSION_COOKIE = "__Host-colo_session";
export const ADMIN_COOKIE = "__Host-colo_admin";

// ---- owner dashboard (M9) ---------------------------------------------------------

/** Returned by both passkey `options` endpoints; `options` is WebAuthn options JSON. */
export interface CeremonyOptionsResponse<T> {
  challengeId: string;
  options: T;
}
/** `POST /api/admin/enroll/options` */
export interface EnrollOptionsRequest {
  token: string;
}
/** `POST /api/admin/enroll/verify` */
export interface EnrollVerifyRequest {
  token: string;
  challengeId: string;
  response: unknown;
}
/** `POST /api/admin/login/verify` */
export interface AdminLoginVerifyRequest {
  challengeId: string;
  response: unknown;
}
/** `POST /api/admin/enroll-token` (bearer ADMIN_TOKEN) */
export interface EnrollTokenResponse {
  url: string;
  expiresAt: string;
}

export interface AdminWorkspace {
  slug: string;
  name: string;
  maxMembers: number;
  disabledAt: string | null;
  createdAt: string;
  /** Members who can sign in (not disabled). */
  members: number;
  documents: number;
}
/** `GET /api/admin/workspaces` */
export interface AdminWorkspacesResponse {
  workspaces: AdminWorkspace[];
}
/** `POST /api/admin/workspaces` */
export interface CreateWorkspaceRequest {
  slug: string;
  name: string;
  maxMembers?: number;
}
/** `PATCH /api/admin/workspaces/:slug` */
export interface UpdateWorkspaceRequest {
  slug?: string;
  name?: string;
  maxMembers?: number;
  disabled?: boolean;
}

export interface AdminMember {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  disabledAt: string | null;
  /** False for a member restored from a backup or carried over from invites, until one is set. */
  hasPassword: boolean;
  lastLoginAt: string | null;
}
/** `GET /api/admin/workspaces/:slug/members` */
export interface AdminMembersResponse {
  members: AdminMember[];
}
/** `POST /api/admin/workspaces/:slug/members`; a password is generated when none is given. */
export interface AddMemberRequest {
  email: string;
  name: string;
  password?: string;
}
/** `PATCH /api/admin/workspaces/:slug/members/:id` */
export interface UpdateMemberRequest {
  name?: string;
  disabled?: boolean;
  /** A new password; `true` generates one. */
  password?: string | true;
}
/** A member change; `password` is present only when one was set, and is never shown again. */
export interface MemberChangeResponse {
  member: AdminMember;
  password?: string;
}

export const DEFAULT_MAX_MEMBERS = 10;
export const MAX_MEMBERS_LIMIT = 100;

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

// ---- backup (M8) --------------------------------------------------------------------

/**
 * The backup format written by `GET /api/export` and read by `POST /api/admin/restore`
 * (plan §8.5): NDJSON, one record per line, so neither side holds a whole workspace in memory.
 * Bumped whenever a record changes shape; a restore refuses a version it does not know.
 */
export const BACKUP_VERSION = 1;

/** Largest NDJSON body one restore request may carry; one record always fits. */
export const BACKUP_BATCH_BYTES = 4_000_000;

/** The first line of a backup, naming the format and the schema versions it came from. */
export interface BackupHeader {
  type: "colo-backup";
  version: number;
  createdAt: string;
  origin: string;
  schema: { workspace: number; document: number };
}

/** Passwords, passkeys and sessions are deliberately absent: credential material. */
export interface BackupMember {
  type: "member";
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  disabledAt: string | null;
}

/** One `documents` row, soft-deleted ones included (D8). */
export interface BackupDocument {
  type: "document";
  id: string;
  title: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt: string | null;
}

/** One `doc_state` row: the Yjs state keeps the chunking it is stored with (≤ 1.9 MB). */
export interface BackupState {
  type: "state";
  doc: string;
  seq: number;
  /** base64 of the chunk. */
  data: string;
}

export interface BackupImage {
  type: "image";
  doc: string;
  id: string;
  mime: ImageType;
  bytes: number;
  createdAt: string;
  createdBy: string;
  /** base64 of the image. */
  data: string;
}

/**
 * Written by the restore side, never by an export: every row of `doc` is in, so the document
 * object can make them live. `chunks` is how many `doc_state` rows the backup held, so a
 * restore over an existing document drops the ones beyond it.
 */
export interface BackupCommit {
  type: "commit";
  doc: string;
  chunks: number;
}

/** The last line of a backup. A file without it was truncated: the export failed part-way. */
export interface BackupEnd {
  type: "end";
  documents: number;
}

export type BackupRecord =
  | BackupHeader
  | BackupMember
  | BackupDocument
  | BackupState
  | BackupImage
  | BackupCommit
  | BackupEnd;

/**
 * `POST /api/admin/restore` (NDJSON body). `documents` counts the index rows this batch wrote,
 * not the documents it made live — a document's `commit` usually lands in a later batch than its
 * index row. Each document has exactly one index row in a backup, so the totals across a whole
 * restore still add up to the number of documents in the file.
 */
export interface RestoreBackupResponse {
  applied: number;
  members: number;
  documents: number;
}

/** Server → client control events, sent as y-partyserver custom string messages. */
export type ControlEvent =
  | { type: "saved"; at: string }
  | { type: "session-expired" }
  | { type: "document-deleted" }
  /** Someone restored a restore point; `by` is their display name. */
  | { type: "restored"; by: string; at: string }
  | { type: "limit"; code: "MESSAGE_TOO_LARGE" | "RATE_LIMITED" | "DOCUMENT_TOO_LARGE" | "DOCUMENT_UNREADABLE" };

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
