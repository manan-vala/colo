import type { ImportedDocument } from "./model";

/**
 * An import waiting for its new document to open: the list page creates the document and
 * uploads the images, then the document screen applies the content once it has synced. Kept in
 * memory only; reloading the page in between loses the import (the document stays empty).
 */
export interface PendingImport {
  document: ImportedDocument;
  fileName: string;
}

const pending = new Map<string, PendingImport>();

export function setPendingImport(docId: string, value: PendingImport) {
  pending.set(docId, value);
}

/** Returns and forgets the import waiting for this document, if any. */
export function takePendingImport(docId: string): PendingImport | null {
  const value = pending.get(docId) ?? null;
  pending.delete(docId);
  return value;
}
