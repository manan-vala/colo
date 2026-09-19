import type { JSONContent } from "@tiptap/core";
import type { PageSettings } from "../../shared/doc-schema";

/**
 * What every importer produces (plan F10): editor content plus the parts of a document that
 * live outside it. Images are not uploaded yet: their nodes carry `src: "pending:<key>"` and the
 * bytes wait in `images` until the document they belong to exists.
 */
export interface ImportedDocument {
  title: string;
  content: JSONContent;
  /** Only what the file specifies; the rest keeps the document's current settings. */
  settings: Partial<PageSettings>;
  threads: ImportedThread[];
  images: Map<string, Blob>;
  /** What was converted or left out, for the import report. */
  notes: ImportNote[];
}

export interface ImportedComment {
  author: string;
  /** ISO date, when the file has one. */
  date: string | null;
  body: string;
}

export interface ImportedThread {
  /** Also the `threadId` of the comment marks in `content`. */
  id: string;
  quote: string;
  resolved: boolean;
  /** The first comment starts the thread; the rest are replies, oldest first. */
  comments: ImportedComment[];
}

export interface ImportNote {
  /** "converted": kept in another form; "dropped": left out. */
  kind: "converted" | "dropped";
  message: string;
  count: number;
}

export const PENDING_IMAGE = "pending:";

/** A file Colo cannot read at all (the report is for partial losses). */
export class ImportError extends Error {}

/** Collects notes, counting repeats of the same message. */
export class NoteList {
  private readonly notes = new Map<string, ImportNote>();

  add(kind: ImportNote["kind"], message: string, count = 1) {
    const note = this.notes.get(message);
    if (note) note.count += count;
    else this.notes.set(message, { kind, message, count });
  }

  list(): ImportNote[] {
    return [...this.notes.values()];
  }
}
