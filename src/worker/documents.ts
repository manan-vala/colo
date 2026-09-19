import {
  LIMITS,
  isDocumentId,
  memberColor,
  type DocumentSummary,
  type Member,
} from "../shared/protocol";
import { DEFAULT_TITLE } from "../shared/doc-schema";
import { HttpError, base64url, isoNow, ulid } from "./http";

/** Document index and access control, run inside the Workspace Durable Object (plan §2.1). */

/** Identity the Worker attaches to an authorised document connection. */
export interface DocumentIdentity {
  memberId: string;
  displayName: string;
  color: string;
  sessionHash: string;
  sessionExpiresAt: string;
}

/** Header carrying DocumentIdentity from the Worker to the Document object. Clients cannot set it. */
export const IDENTITY_HEADER = "x-colo-identity";

export function encodeIdentity(identity: DocumentIdentity): string {
  return base64url(new TextEncoder().encode(JSON.stringify(identity)));
}

export function decodeIdentity(value: string | null): DocumentIdentity | null {
  if (!value) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    const identity = JSON.parse(json) as DocumentIdentity;
    return typeof identity.memberId === "string" && typeof identity.sessionHash === "string" ? identity : null;
  } catch {
    return null;
  }
}

/** Hostname for Workspace → Document internal requests; never produced by the public router. */
export const INTERNAL_HOST = "document.internal";

export interface DocumentMeta {
  title: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

type SummaryRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  created_by_name: string;
  updated_by: string;
  updated_by_name: string;
};

const SUMMARY_SELECT = `
  SELECT d.id, d.title, d.created_at, d.updated_at,
         d.created_by, cb.display_name AS created_by_name,
         d.updated_by, ub.display_name AS updated_by_name
    FROM documents d
    JOIN members cb ON cb.id = d.created_by
    JOIN members ub ON ub.id = d.updated_by`;

const toSummary = (row: SummaryRow): DocumentSummary => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  createdBy: { id: row.created_by, displayName: row.created_by_name },
  updatedAt: row.updated_at,
  updatedBy: { id: row.updated_by, displayName: row.updated_by_name },
});

export function normalizeTitle(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new HttpError(400, "INVALID", "title must be a string");
  const title = value.trim().replace(/\s+/g, " ");
  if (title.length > LIMITS.titleLength) throw new HttpError(400, "INVALID", "title is too long");
  return title || (fallback ?? DEFAULT_TITLE);
}

export class Documents {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Env,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  list(): DocumentSummary[] {
    return this.sql
      .exec<SummaryRow>(`${SUMMARY_SELECT} WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 500`)
      .toArray()
      .map(toSummary);
  }

  get(id: string): DocumentSummary {
    const row = isDocumentId(id)
      ? this.sql.exec<SummaryRow>(`${SUMMARY_SELECT} WHERE d.id = ? AND d.deleted_at IS NULL`, id).toArray()[0]
      : undefined;
    if (!row) throw new HttpError(404, "NOT_FOUND", "Document not found");
    return toSummary(row);
  }

  async create(member: Member, title: unknown): Promise<DocumentSummary> {
    const id = ulid();
    const now = isoNow();
    const normalized = normalizeTitle(title, DEFAULT_TITLE);
    // Seed the title into the Yjs document first: if that fails, no index row points at a
    // document that never got its title.
    await this.internal(id, "title", { title: normalized });
    this.sql.exec(
      "INSERT INTO documents (id, title, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      normalized,
      now,
      member.id,
      now,
      member.id,
    );
    return this.get(id);
  }

  async rename(member: Member, id: string, title: unknown): Promise<DocumentSummary> {
    const normalized = normalizeTitle(title);
    this.get(id);
    // The Yjs document is the source of truth for titles; update it before the index.
    await this.internal(id, "title", { title: normalized });
    this.sql.exec(
      "UPDATE documents SET title = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL",
      normalized,
      isoNow(),
      member.id,
      id,
    );
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    const now = isoNow();
    this.storage.transactionSync(() => {
      this.sql.exec("UPDATE documents SET deleted_at = ? WHERE id = ?", now, id);
      this.sql.exec("DELETE FROM document_sessions WHERE doc_id = ?", id);
    });
    await this.internal(id, "delete", {});
  }

  /** Checks that a document may be opened and records the session for revocation. */
  authorize(member: Member, sessionHash: string, sessionExpiresAt: string, id: string): DocumentIdentity {
    this.get(id);
    this.sql.exec(
      "INSERT INTO document_sessions (session_hash, doc_id, connected_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      sessionHash,
      id,
      isoNow(),
    );
    return {
      memberId: member.id,
      displayName: member.displayName,
      color: memberColor(member.id),
      sessionHash,
      sessionExpiresAt,
    };
  }

  /** Called (throttled) by Document objects after saves. */
  updateMeta(id: string, meta: DocumentMeta): void {
    const title = meta.title === null ? null : normalizeTitle(meta.title);
    this.sql.exec(
      `UPDATE documents
          SET title = COALESCE(?, title), updated_at = ?, updated_by = COALESCE(?, updated_by)
        WHERE id = ? AND deleted_at IS NULL`,
      title,
      meta.updatedAt,
      meta.updatedBy,
      id,
    );
  }

  /** Closes the session's sockets in every document it opened. */
  async closeSession(sessionHash: string): Promise<void> {
    const docs = this.sql
      .exec<{ doc_id: string }>(
        "DELETE FROM document_sessions WHERE session_hash = ? RETURNING doc_id",
        sessionHash,
      )
      .toArray();
    await Promise.all(docs.map((row) => this.internal(row.doc_id, "close-session", { sessionHash })));
  }

  /** Forgets documents opened by sessions that no longer exist (expired or deleted). */
  pruneSessions(): void {
    this.sql.exec("DELETE FROM document_sessions WHERE session_hash NOT IN (SELECT id_hash FROM sessions)");
  }

  private async internal(id: string, action: string, body: unknown): Promise<void> {
    const stub = this.env.DOCUMENT.getByName(id, { locationHint: "apac" });
    const response = await stub.fetch(`https://${INTERNAL_HOST}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Document ${id} ${action} failed: ${response.status}`);
  }
}
