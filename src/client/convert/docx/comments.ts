import type { ImportedThread } from "../model";
import type { DocxPackage } from "./package";
import { partOfType } from "./package";
import { NS, attr, children, descendants } from "./xml";

/**
 * Word comments: comments.xml holds each comment's author, date and text; commentsExtended.xml
 * links replies to their parent and marks threads done (resolved), keyed by the paraId of each
 * comment's last paragraph. Every reply joins its root comment's thread.
 */

export interface DocxComments {
  threads: ImportedThread[];
  /** Word comment ID → Colo thread ID (a reply maps to its thread's root). */
  threadOf: Map<string, string>;
}

interface WordComment {
  id: string;
  author: string;
  date: string | null;
  body: string;
  paraId: string | null;
}

export function readComments(pkg: DocxPackage, newId: () => string): DocxComments {
  const commentsPart = partOfType(pkg, pkg.mainPart, "/comments");
  const doc = commentsPart ? pkg.xml(commentsPart) : null;
  const comments: WordComment[] = [];
  for (const element of doc ? children(doc.documentElement, NS.w, "comment") : []) {
    const id = attr(element, NS.w, "id");
    if (id === null) continue;
    const paragraphs = children(element, NS.w, "p");
    const body = paragraphs
      .map((p) => descendants(p, NS.w, "t").map((t) => t.textContent ?? "").join(""))
      .join("\n")
      .trim();
    comments.push({
      id,
      author: attr(element, NS.w, "author") || "Unknown",
      date: normaliseDate(attr(element, NS.w, "date")),
      body,
      paraId: paragraphs.length ? attr(paragraphs[paragraphs.length - 1], NS.w14, "paraId") : null,
    });
  }

  // paraId → { parent paraId, done }
  const extendedPart = partOfType(pkg, pkg.mainPart, "/commentsExtended");
  const extended = new Map<string, { parent: string | null; done: boolean }>();
  const ext = extendedPart ? pkg.xml(extendedPart) : null;
  for (const element of ext ? descendants(ext, NS.w15, "commentEx") : []) {
    const paraId = attr(element, NS.w15, "paraId");
    if (paraId) extended.set(paraId, { parent: attr(element, NS.w15, "paraIdParent"), done: attr(element, NS.w15, "done") === "1" });
  }

  const byParaId = new Map(comments.filter((c) => c.paraId).map((c) => [c.paraId!, c]));
  const rootOf = (comment: WordComment): WordComment => {
    const seen = new Set<string>();
    let current = comment;
    for (;;) {
      const parent = current.paraId ? extended.get(current.paraId)?.parent : null;
      const next = parent ? byParaId.get(parent) : undefined;
      if (!next || seen.has(next.id)) return current;
      seen.add(current.id);
      current = next;
    }
  };

  const threads = new Map<string, ImportedThread>();
  const threadOf = new Map<string, string>();
  for (const comment of comments) {
    const root = rootOf(comment);
    let thread = threads.get(root.id);
    if (!thread) {
      thread = { id: newId(), quote: "", resolved: false, comments: [] };
      threads.set(root.id, thread);
    }
    if (comment.body) thread.comments.push({ author: comment.author, date: comment.date, body: comment.body });
    if (comment.paraId && extended.get(comment.paraId)?.done) thread.resolved = true;
    threadOf.set(comment.id, thread.id);
  }
  return { threads: [...threads.values()].filter((t) => t.comments.length > 0), threadOf };
}

/** Word writes local times with a "Z"; keep any valid date as ISO. */
function normaliseDate(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
