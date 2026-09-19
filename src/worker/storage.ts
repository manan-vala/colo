/**
 * SQLite storage for the Document Durable Object (plan §3.2): the chunked Yjs state and the
 * metadata update that is waiting for its throttle window. Restore points reuse the chunking.
 */

/** SQLite rows are limited to 2 MB; keep a margin. */
export const STATE_CHUNK_BYTES = 1_900_000;

/** Reads the saved Yjs state; null for a document that was never saved. */
export function readState(sql: SqlStorage): Uint8Array | null {
  const chunks = sql
    .exec<{ data: ArrayBuffer }>("SELECT data FROM doc_state ORDER BY seq")
    .toArray()
    .map((row) => new Uint8Array(row.data));
  return chunks.length === 0 ? null : concat(chunks);
}

/** Splits a state into row-sized chunks; always at least one, so an empty state is still saved. */
export function splitChunks(state: Uint8Array): Uint8Array[] {
  const count = Math.max(1, Math.ceil(state.byteLength / STATE_CHUNK_BYTES));
  return Array.from({ length: count }, (_, seq) => state.slice(seq * STATE_CHUNK_BYTES, (seq + 1) * STATE_CHUNK_BYTES));
}

/**
 * Replaces the saved state in one transaction: upserts each chunk and deletes chunks beyond the
 * new count. A document under 1.9 MB costs exactly one row written.
 */
export function writeState(storage: DurableObjectStorage, state: Uint8Array): void {
  const { sql } = storage;
  const chunks = splitChunks(state);
  storage.transactionSync(() => {
    chunks.forEach((chunk, seq) =>
      sql.exec(
        "INSERT INTO doc_state (seq, data) VALUES (?, ?) ON CONFLICT (seq) DO UPDATE SET data = excluded.data",
        seq,
        chunk.buffer,
      ),
    );
    sql.exec("DELETE FROM doc_state WHERE seq >= ?", chunks.length);
  });
}

/** A document-list update deferred by the once-a-minute throttle (plan §9.3). */
export interface PendingMeta {
  updatedAt: string;
  updatedBy: string | null;
}

export function readPendingMeta(sql: SqlStorage): PendingMeta | null {
  const row = sql
    .exec<{ updated_at: string; updated_by: string | null }>("SELECT updated_at, updated_by FROM pending_meta WHERE id = 1")
    .toArray()[0];
  return row ? { updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
}

export function writePendingMeta(sql: SqlStorage, meta: PendingMeta): void {
  sql.exec(
    `INSERT INTO pending_meta (id, updated_at, updated_by) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    meta.updatedAt,
    meta.updatedBy,
  );
}

export function clearPendingMeta(sql: SqlStorage): void {
  sql.exec("DELETE FROM pending_meta WHERE id = 1");
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
