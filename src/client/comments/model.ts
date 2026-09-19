import * as Y from "yjs";
import {
  COMMENTS_MAP,
  COMMENT_LIMITS,
  type CommentFields,
  type ThreadFields,
} from "../../shared/doc-schema";

/**
 * Comment threads stored in the document's Yjs `comments` map (plan §3.3). Every operation is a
 * single Yjs transaction, so it syncs to the other person as one update and merges with their
 * concurrent changes field by field. Reads validate what they find: a buggy client must not be
 * able to break the comments panel for everyone.
 */

export interface Author {
  id: string;
  name: string;
}

export interface Comment extends CommentFields {
  deleted: boolean;
}

export interface Thread extends ThreadFields {
  id: string;
  resolved: boolean;
  /** The first comment starts the thread; the rest are replies. Deleted replies are kept. */
  comments: Comment[];
}

type YThread = Y.Map<unknown>;

export function threadsMap(doc: Y.Doc): Y.Map<YThread> {
  return doc.getMap<YThread>(COMMENTS_MAP);
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Trims and bounds comment text; returns null for an empty comment. */
export function cleanBody(body: string): string | null {
  const trimmed = body.trim();
  return trimmed ? trimmed.slice(0, COMMENT_LIMITS.bodyLength) : null;
}

export function cleanQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > COMMENT_LIMITS.quoteLength ? `${flat.slice(0, COMMENT_LIMITS.quoteLength - 1)}…` : flat;
}

function commentMap(author: Author, body: string, now: string): Y.Map<unknown> {
  const fields: CommentFields = {
    id: newId(),
    authorId: author.id,
    authorName: author.name,
    body,
    createdAt: now,
    editedAt: null,
    deletedAt: null,
  };
  return new Y.Map(Object.entries(fields));
}

// ---- writes ---------------------------------------------------------------------------------

export function createThread(doc: Y.Doc, threadId: string, input: { quote: string; body: string; author: Author }): boolean {
  const body = cleanBody(input.body);
  if (!body) return false;
  const now = new Date().toISOString();
  doc.transact(() => {
    const fields: ThreadFields = {
      quote: cleanQuote(input.quote),
      createdAt: now,
      createdBy: input.author.id,
      createdByName: input.author.name,
      resolvedAt: null,
      resolvedBy: null,
      resolvedByName: null,
    };
    const thread = new Y.Map<unknown>(Object.entries(fields));
    thread.set("comments", Y.Array.from([commentMap(input.author, body, now)]));
    threadsMap(doc).set(threadId, thread);
  });
  return true;
}

export function addReply(doc: Y.Doc, threadId: string, author: Author, body: string): boolean {
  const text = cleanBody(body);
  const comments = commentsOf(doc, threadId);
  if (!text || !comments) return false;
  doc.transact(() => {
    comments.push([commentMap(author, text, new Date().toISOString())]);
    // Replying to a resolved thread reopens it, as in Google Docs.
    if (threadsMap(doc).get(threadId)?.get("resolvedAt")) setResolved(doc, threadId, null);
  });
  return true;
}

export function editComment(doc: Y.Doc, threadId: string, commentId: string, body: string): boolean {
  const text = cleanBody(body);
  const comment = findComment(doc, threadId, commentId);
  if (!text || !comment || comment.get("deletedAt")) return false;
  doc.transact(() => {
    comment.set("body", text);
    comment.set("editedAt", new Date().toISOString());
  });
  return true;
}

/** Soft-deletes a reply. Deleting the first comment deletes the thread (see `isThreadStart`). */
export function deleteComment(doc: Y.Doc, threadId: string, commentId: string): boolean {
  const comment = findComment(doc, threadId, commentId);
  if (!comment) return false;
  doc.transact(() => {
    comment.set("body", "");
    comment.set("deletedAt", new Date().toISOString());
  });
  return true;
}

export function deleteThread(doc: Y.Doc, threadId: string): void {
  threadsMap(doc).delete(threadId);
}

/** Resolves the thread for `author`, or reopens it for null. */
export function setResolved(doc: Y.Doc, threadId: string, author: Author | null): void {
  const thread = threadsMap(doc).get(threadId);
  if (!(thread instanceof Y.Map)) return;
  doc.transact(() => {
    thread.set("resolvedAt", author ? new Date().toISOString() : null);
    thread.set("resolvedBy", author?.id ?? null);
    thread.set("resolvedByName", author?.name ?? null);
  });
}

function commentsOf(doc: Y.Doc, threadId: string): Y.Array<Y.Map<unknown>> | null {
  const comments = threadsMap(doc).get(threadId)?.get("comments");
  return comments instanceof Y.Array ? (comments as Y.Array<Y.Map<unknown>>) : null;
}

function findComment(doc: Y.Doc, threadId: string, commentId: string): Y.Map<unknown> | null {
  const found = commentsOf(doc, threadId)
    ?.toArray()
    .find((c) => c instanceof Y.Map && c.get("id") === commentId);
  return found ?? null;
}

// ---- reads ----------------------------------------------------------------------------------

/** All valid threads, oldest first. */
export function readThreads(doc: Y.Doc): Thread[] {
  const threads: Thread[] = [];
  threadsMap(doc).forEach((value, id) => {
    const thread = readThread(id, value);
    if (thread) threads.push(thread);
  });
  return threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function isThreadStart(thread: Thread, commentId: string): boolean {
  return thread.comments[0]?.id === commentId;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function readThread(id: string, value: unknown): Thread | null {
  if (!(value instanceof Y.Map)) return null;
  const createdAt = text(value.get("createdAt"));
  const createdBy = text(value.get("createdBy"));
  const rawComments = value.get("comments");
  if (!createdAt || !createdBy || !(rawComments instanceof Y.Array)) return null;
  const comments = rawComments.toArray().flatMap((c) => {
    const comment = readComment(c);
    return comment ? [comment] : [];
  });
  if (comments.length === 0) return null;
  const resolvedAt = text(value.get("resolvedAt"));
  return {
    id,
    quote: text(value.get("quote")) ?? "",
    createdAt,
    createdBy,
    createdByName: text(value.get("createdByName")) ?? "",
    resolvedAt,
    resolvedBy: text(value.get("resolvedBy")),
    resolvedByName: text(value.get("resolvedByName")),
    resolved: resolvedAt !== null,
    comments,
  };
}

function readComment(value: unknown): Comment | null {
  if (!(value instanceof Y.Map)) return null;
  const id = text(value.get("id"));
  const authorId = text(value.get("authorId"));
  const createdAt = text(value.get("createdAt"));
  if (!id || !authorId || !createdAt) return null;
  const deletedAt = text(value.get("deletedAt"));
  return {
    id,
    authorId,
    authorName: text(value.get("authorName")) ?? "",
    body: deletedAt ? "" : (text(value.get("body")) ?? "").slice(0, COMMENT_LIMITS.bodyLength),
    createdAt,
    editedAt: text(value.get("editedAt")),
    deletedAt,
    deleted: deletedAt !== null,
  };
}
