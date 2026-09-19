import { LIMITS, type DocumentSummary } from "../../shared/protocol";
import { ApiRequestError, api } from "../api";
import { ImportError } from "../convert/model";
import { setPendingImport } from "../convert/pending";

/**
 * Opening a file as a new document (the list page and File → Open file): the file is read, the
 * document created with its title and its images uploaded; the document screen then applies
 * the content once it has connected. The converters load only when a file is chosen.
 */
export async function importAsNewDocument(file: File): Promise<string> {
  const { readImport } = await import("../convert");
  const imported = await readImport(file);
  const doc = await api<DocumentSummary>("/api/docs", { body: { title: imported.title.slice(0, LIMITS.titleLength) } });
  const { uploadImportedImages } = await import("../convert/apply");
  setPendingImport(doc.id, { document: await uploadImportedImages(doc.id, imported), fileName: file.name });
  return doc.id;
}

export function describeImportError(error: unknown): string {
  if (error instanceof ImportError) return error.message;
  if (error instanceof ApiRequestError && error.status === 401) return "You were signed out. Sign in again to import files.";
  return "The file could not be imported.";
}

/** Saves a file the browser has made (an export) through a download link. */
export function saveDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked later: some browsers start the download after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
