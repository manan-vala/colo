import * as Y from "yjs";
import { CONTENT_FIELD, ROOT_TYPES } from "../shared/doc-schema";
import { LIMITS, type RestorePoint, type RestorePointKind } from "../shared/protocol";
import { MINUTE, isoNow, ulid } from "./http";
import { concat, splitChunks } from "./storage";

/**
 * Restore points (plan F9): copies of a document's whole Yjs state in its own SQLite, chunked
 * like the live state. Comments and page settings live in the Yjs document, so a restore point
 * brings them back with the text.
 */

/** At most one automatic point per 30 minutes of editing (plan §9.3). */
export const AUTO_POINT_INTERVAL = 30 * MINUTE;

type PointRow = {
  id: string;
  kind: RestorePointKind;
  label: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  state_bytes: number;
};

const toPoint = (row: PointRow): RestorePoint => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  createdAt: row.created_at,
  createdBy: row.created_by ? { id: row.created_by, displayName: row.created_by_name ?? "" } : null,
  bytes: row.state_bytes,
});

export interface NewPoint {
  kind: RestorePointKind;
  label?: string | null;
  state: Uint8Array;
  createdBy?: { id: string; displayName: string } | null;
}

/** Saves a point, then drops the oldest beyond the limit. Costs one row plus one per 1.9 MB. */
export function createPoint(storage: DurableObjectStorage, point: NewPoint): RestorePoint {
  const { sql } = storage;
  const row: PointRow = {
    id: ulid(),
    kind: point.kind,
    label: point.label ?? null,
    created_at: isoNow(),
    created_by: point.createdBy?.id ?? null,
    created_by_name: point.createdBy?.displayName ?? null,
    state_bytes: point.state.byteLength,
  };
  storage.transactionSync(() => {
    sql.exec(
      `INSERT INTO restore_points (id, kind, label, created_at, created_by, created_by_name, state_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.kind,
      row.label,
      row.created_at,
      row.created_by,
      row.created_by_name,
      row.state_bytes,
    );
    splitChunks(point.state).forEach((chunk, seq) =>
      sql.exec("INSERT INTO restore_point_chunks (point_id, seq, data) VALUES (?, ?, ?)", row.id, seq, chunk.buffer),
    );
    prunePoints(sql, LIMITS.restorePoints, row.id);
  });
  return toPoint(row);
}

/** Newest first. */
export function listPoints(sql: SqlStorage): RestorePoint[] {
  return sql.exec<PointRow>("SELECT * FROM restore_points ORDER BY created_at DESC, id DESC").toArray().map(toPoint);
}

export function getPoint(sql: SqlStorage, id: string): RestorePoint | null {
  const row = sql.exec<PointRow>("SELECT * FROM restore_points WHERE id = ?", id).toArray()[0];
  return row ? toPoint(row) : null;
}

export function readPointState(sql: SqlStorage, id: string): Uint8Array | null {
  const chunks = sql
    .exec<{ data: ArrayBuffer }>("SELECT data FROM restore_point_chunks WHERE point_id = ? ORDER BY seq", id)
    .toArray()
    .map((row) => new Uint8Array(row.data));
  return chunks.length === 0 ? null : concat(chunks);
}

/** When the newest point was taken, in milliseconds; 0 when there is none. */
export function latestPointAt(sql: SqlStorage): number {
  const row = sql.exec<{ at: string | null }>("SELECT MAX(created_at) AS at FROM restore_points").one();
  return row.at ? Date.parse(row.at) : 0;
}

/**
 * Keeps the newest `keep` points, dropping automatic and pre-restore points before named ones.
 * The point just created (`newest`) always stays, even when the others are all named: it may be
 * the pre-restore copy that makes a restore reversible.
 */
export function prunePoints(sql: SqlStorage, keep: number, newest: string): void {
  const doomed = sql
    .exec<{ id: string }>(
      `SELECT id FROM restore_points
        ORDER BY id = ? DESC, kind = 'named' DESC, created_at DESC, id DESC
        LIMIT -1 OFFSET ?`,
      newest,
      keep,
    )
    .toArray();
  for (const { id } of doomed) {
    sql.exec("DELETE FROM restore_point_chunks WHERE point_id = ?", id);
    sql.exec("DELETE FROM restore_points WHERE id = ?", id);
  }
}

/** True when a saved state has no document content (a new, empty document). */
export function isEmptyState(state: Uint8Array): boolean {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getXmlFragment(CONTENT_FIELD).length === 0;
}

const RESTORE_ORIGIN = Symbol("restore");

/**
 * Turns `doc` back into the state saved in `snapshot`, as an ordinary Yjs change that every
 * client merges: the edits made since the snapshot are undone rather than the document being
 * swapped, so both people stay connected and in sync.
 *
 * This is y-partyserver's `unstable_replaceDocument` approach (an UndoManager over a copy of the
 * snapshot, undoing the later changes) with one fix: it covers every root in `ROOT_TYPES`, with
 * its real type, rather than only the roots the snapshot already had, so comments or settings
 * created after the snapshot are removed too.
 */
export function replaceState(doc: Y.Doc, snapshot: Uint8Array): void {
  const past = new Y.Doc();
  Y.applyUpdate(past, snapshot, RESTORE_ORIGIN);
  const current = Y.encodeStateVector(doc);
  const since = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(past));

  const roots = Object.entries(ROOT_TYPES).map(([name, type]) =>
    type === "XmlFragment" ? past.getXmlFragment(name) : past.getMap(name),
  );
  const undo = new Y.UndoManager(roots, { trackedOrigins: new Set([RESTORE_ORIGIN]), captureTimeout: 0 });
  Y.applyUpdate(past, since, RESTORE_ORIGIN);
  undo.undo();
  undo.destroy();

  Y.applyUpdate(doc, Y.encodeStateAsUpdate(past, current), RESTORE_ORIGIN);
  past.destroy();
}
