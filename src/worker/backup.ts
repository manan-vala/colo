/**
 * Backup and restore (plan §8.5).
 *
 * `GET /api/export` streams the whole workspace as NDJSON: a header, every member, the document
 * index including soft-deleted rows (D8), and then, from each Document object, the Yjs state and
 * the images. One record per line, so neither object ever holds a workspace in memory — the Yjs
 * state keeps the 1.9 MB chunking it is already stored with (`storage.ts`).
 *
 * `POST /api/admin/restore` reads the same file back. It exists only where `ADMIN_TOKEN` is set,
 * which production deletes after enrolment (§8.2), so the destructive route is absent in
 * production by construction.
 *
 * **Passkeys and sessions are never exported.** They are device-bound credential material, useless
 * on another instance, and a liability in a file that lands in someone's Downloads folder. A
 * restored instance gets its passkeys from a fresh invite.
 *
 * Document ids are preserved on restore: an image's `src` embeds the document id
 * (`imagePath`), so reminting ids would break every image in every document.
 */
import {
  BACKUP_VERSION,
  LIMITS,
  isImageType,
  isUlid,
  type BackupDocument,
  type BackupImage,
  type BackupMember,
  type BackupRecord,
  type BackupState,
} from "../shared/protocol";
import { HttpError, fromBase64, isoNow, toBase64 } from "./http";
import { sniffImageType } from "./images";
import { STATE_CHUNK_BYTES } from "./storage";

export const NDJSON_TYPE = "application/x-ndjson";

const encoder = new TextEncoder();

export const encodeRecord = (record: BackupRecord): Uint8Array => encoder.encode(`${JSON.stringify(record)}\n`);

/** Parses an NDJSON body; blank lines are ignored so a trailing newline is fine. */
export function parseRecords(text: string): BackupRecord[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as BackupRecord;
      } catch {
        throw new HttpError(400, "INVALID_BACKUP", `Line ${index + 1} is not JSON`);
      }
    });
}

/** Serves an async record source as a streaming NDJSON response. */
export function ndjsonResponse(source: AsyncGenerator<Uint8Array>, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await source.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await source.return?.(reason);
    },
  });
  return new Response(stream, { headers: { "Content-Type": NDJSON_TYPE, ...headers } });
}

// ---- export ------------------------------------------------------------------------------

type MemberRow = { id: string; email: string; display_name: string; created_at: string; disabled_at: string | null };
type IndexRow = {
  id: string;
  title: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
};

/**
 * The Workspace half of a backup: header, members, the document index, then each document's own
 * records piped straight from its object. Soft-deleted documents are included and keep their
 * `deletedAt`, so a restore brings back the same trash (D8).
 */
export async function* workspaceBackup(
  sql: SqlStorage,
  options: {
    origin: string;
    schema: { workspace: number; document: number };
    fetchDocument: (docId: string) => Promise<Response>;
  },
): AsyncGenerator<Uint8Array> {
  yield encodeRecord({
    type: "colo-backup",
    version: BACKUP_VERSION,
    createdAt: isoNow(),
    origin: options.origin,
    schema: options.schema,
  });

  for (const row of sql
    .exec<MemberRow>("SELECT id, email, display_name, created_at, disabled_at FROM members ORDER BY created_at, id")
    .toArray()) {
    yield encodeRecord({
      type: "member",
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      disabledAt: row.disabled_at,
    } satisfies BackupMember);
  }

  const documents = sql
    .exec<IndexRow>(
      `SELECT id, title, created_at, created_by, updated_at, updated_by, deleted_at
         FROM documents ORDER BY created_at, id`,
    )
    .toArray();

  for (const row of documents) {
    yield encodeRecord({
      type: "document",
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      deletedAt: row.deleted_at,
    } satisfies BackupDocument);
  }

  // Each document's state and images come from its own object, already encoded. A document that
  // fails errors the stream rather than being skipped: a silently short backup is worse than none.
  for (const row of documents) {
    const response = await options.fetchDocument(row.id);
    if (!response.ok || !response.body) {
      throw new Error(`Document ${row.id} export failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  }

  yield encodeRecord({ type: "end", documents: documents.length });
}

type ImageRow = { id: string; mime: string; bytes: number; created_at: string; created_by: string };

/**
 * The Document half: its saved state, chunk by chunk, then its images. Read straight from SQLite
 * one row at a time — the live Yjs document is never loaded, so exporting does not wake a
 * hibernating object. Edits saved on the debounce (at most 10 s old) are therefore not included.
 */
export async function* documentBackup(sql: SqlStorage, docId: string): AsyncGenerator<Uint8Array> {
  const chunks = sql.exec<{ seq: number }>("SELECT seq FROM doc_state ORDER BY seq").toArray();
  for (const { seq } of chunks) {
    const row = sql.exec<{ data: ArrayBuffer }>("SELECT data FROM doc_state WHERE seq = ?", seq).toArray()[0];
    if (!row) continue;
    yield encodeRecord({
      type: "state",
      doc: docId,
      seq,
      data: toBase64(new Uint8Array(row.data)),
    } satisfies BackupState);
  }

  const images = sql
    .exec<ImageRow>("SELECT id, mime, bytes, created_at, created_by FROM images ORDER BY id")
    .toArray();
  for (const image of images) {
    const row = sql.exec<{ data: ArrayBuffer }>("SELECT data FROM images WHERE id = ?", image.id).toArray()[0];
    if (!row) continue;
    yield encodeRecord({
      type: "image",
      doc: docId,
      id: image.id,
      mime: image.mime as BackupImage["mime"],
      bytes: image.bytes,
      createdAt: image.created_at,
      createdBy: image.created_by,
      data: toBase64(new Uint8Array(row.data)),
    } satisfies BackupImage);
  }

  // The restore side needs to know how many chunks there were to drop any beyond them.
  yield encodeRecord({ type: "commit", doc: docId, chunks: chunks.length });
}

// ---- restore -----------------------------------------------------------------------------

export interface RestoreContext {
  storage: DurableObjectStorage;
  /** This workspace's schema version; a backup from a newer schema cannot be read. */
  schemaVersion: number;
  /** Whether a restore may write over a workspace that already holds documents. */
  overwrite: boolean;
  /** Forwards a record to the document's own object. */
  toDocument: (docId: string, action: string, body: unknown) => Promise<void>;
}

const str = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "INVALID_BACKUP", `${field} is missing`);
  return value;
};

const nullable = (value: unknown, field: string): string | null => (value === null ? null : str(value, field));

const docId = (value: unknown): string => {
  const id = str(value, "doc");
  if (!isUlid(id)) throw new HttpError(400, "INVALID_BACKUP", "doc is not an id");
  return id;
};

/**
 * Applies one batch of records in file order. Idempotent: every write is an upsert keyed on the
 * id from the backup, so re-running the same file produces the same workspace.
 */
export async function applyRecords(records: BackupRecord[], ctx: RestoreContext) {
  const { sql } = ctx.storage;
  let members = 0;
  let documents = 0;

  for (const record of records) {
    switch (record.type) {
      case "colo-backup": {
        if (record.version !== BACKUP_VERSION) {
          throw new HttpError(400, "UNSUPPORTED_BACKUP", `Backup version ${record.version} cannot be read`);
        }
        // Migrations are forward-only and additive, so an older backup reads into a newer
        // workspace; the other way round would need columns this code does not have.
        if ((record.schema?.workspace ?? 0) > ctx.schemaVersion) {
          throw new HttpError(409, "SCHEMA_TOO_NEW", "This backup comes from a newer version of Colo");
        }
        const existing = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM documents").one().n;
        if (existing > 0 && !ctx.overwrite) {
          throw new HttpError(409, "WORKSPACE_NOT_EMPTY", "This workspace already has documents");
        }
        break;
      }

      case "member": {
        // `email` is unique, so the same address under a different id would fail as a raw
        // constraint error. Say what is wrong instead.
        const email = str(record.email, "member.email").toLowerCase();
        const clash = sql
          .exec<{ id: string }>("SELECT id FROM members WHERE email = ? AND id <> ?", email, str(record.id, "member.id"))
          .toArray()[0];
        if (clash) throw new HttpError(409, "EMAIL_TAKEN", `${email} already belongs to another member here`);
        sql.exec(
          `INSERT INTO members (id, email, display_name, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name,
               created_at = excluded.created_at, disabled_at = excluded.disabled_at`,
          str(record.id, "member.id"),
          email,
          str(record.displayName, "member.displayName"),
          str(record.createdAt, "member.createdAt"),
          nullable(record.disabledAt, "member.disabledAt"),
        );
        members++;
        break;
      }

      case "document":
        sql.exec(
          `INSERT INTO documents (id, title, created_at, created_by, updated_at, updated_by, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET title = excluded.title, created_at = excluded.created_at,
               created_by = excluded.created_by, updated_at = excluded.updated_at,
               updated_by = excluded.updated_by, deleted_at = excluded.deleted_at`,
          docId(record.id),
          str(record.title, "document.title"),
          str(record.createdAt, "document.createdAt"),
          str(record.createdBy, "document.createdBy"),
          str(record.updatedAt, "document.updatedAt"),
          str(record.updatedBy, "document.updatedBy"),
          nullable(record.deletedAt, "document.deletedAt"),
        );
        documents++;
        break;

      case "state":
        await ctx.toDocument(docId(record.doc), "restore-state", {
          seq: record.seq,
          data: str(record.data, "state.data"),
        });
        break;

      case "image":
        if (!isImageType(record.mime)) throw new HttpError(400, "INVALID_BACKUP", "image.mime is not a stored type");
        await ctx.toDocument(docId(record.doc), "restore-image", record);
        break;

      case "commit":
        await ctx.toDocument(docId(record.doc), "restore-commit", { chunks: record.chunks });
        break;

      case "end":
        break;

      default:
        throw new HttpError(400, "INVALID_BACKUP", "Unknown record type");
    }
  }

  return { applied: records.length, members, documents };
}

// ---- restore, inside the Document object --------------------------------------------------

/** Writes one `doc_state` row exactly as the backup held it. */
export function restoreStateChunk(sql: SqlStorage, body: Record<string, unknown>): void {
  const seq = body.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    throw new HttpError(400, "INVALID_BACKUP", "state.seq is not an index");
  }
  const data = fromBase64(str(body.data, "state.data"));
  if (data.byteLength > STATE_CHUNK_BYTES) throw new HttpError(413, "TOO_LARGE", "A state chunk is over the row limit");
  sql.exec(
    "INSERT INTO doc_state (seq, data) VALUES (?, ?) ON CONFLICT (seq) DO UPDATE SET data = excluded.data",
    seq,
    data.buffer,
  );
}

export function restoreImage(sql: SqlStorage, body: Partial<BackupImage>): void {
  const id = str(body.id, "image.id");
  if (!isUlid(id)) throw new HttpError(400, "INVALID_BACKUP", "image.id is not an id");
  if (!body.mime || !isImageType(body.mime)) throw new HttpError(400, "INVALID_BACKUP", "image.mime is not a stored type");
  const data = fromBase64(str(body.data, "image.data"));
  // A backup is a file off someone's disk, so it gets the checks an upload gets: the bytes must
  // really be the type they claim (SVG and anything else that can carry script stays out), and
  // the size limits still apply.
  if (sniffImageType(data) !== body.mime) throw new HttpError(415, "UNSUPPORTED_TYPE", "image.data is not its type");
  if (data.byteLength > LIMITS.imageBytes) throw new HttpError(413, "IMAGE_TOO_LARGE");
  sql.exec(
    `INSERT INTO images (id, mime, bytes, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, data = excluded.data,
         created_at = excluded.created_at, created_by = excluded.created_by`,
    id,
    body.mime,
    data.byteLength,
    data.buffer,
    str(body.createdAt, "image.createdAt"),
    str(body.createdBy, "image.createdBy"),
  );
}

/** Drops any state rows beyond what the backup held, so a restore leaves nothing of the old one. */
export function trimStateChunks(sql: SqlStorage, chunks: unknown): void {
  if (typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 0) {
    throw new HttpError(400, "INVALID_BACKUP", "commit.chunks is not a count");
  }
  sql.exec("DELETE FROM doc_state WHERE seq >= ?", chunks);
}
