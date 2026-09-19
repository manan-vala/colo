import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";

/** Name of the mark that anchors a thread to text (see comment-mark.ts). */
export const COMMENT_MARK = "comment";

export interface Anchor {
  threadId: string;
  /** Start and end of the thread's first marked range. */
  from: number;
  to: number;
  /** All text the mark covers, in document order. */
  text: string;
}

/**
 * Where each thread is anchored, in document order. A thread whose text was deleted has no
 * anchor (it is "detached"); a thread whose text was split keeps its first range as the anchor.
 */
export function findAnchors(doc: ProseMirrorNode): Anchor[] {
  const anchors = new Map<string, Anchor>();
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== COMMENT_MARK) continue;
      const threadId = mark.attrs.threadId as string;
      const end = pos + node.nodeSize;
      const anchor = anchors.get(threadId);
      if (!anchor) anchors.set(threadId, { threadId, from: pos, to: end, text: node.text ?? "" });
      else {
        if (anchor.to === pos) anchor.to = end; // the first range continues
        anchor.text += node.text ?? "";
      }
    }
    return false;
  });
  return [...anchors.values()];
}

/** Threads whose text touches a position (the character before or after it is commented). */
export function threadsAt($pos: ResolvedPos): string[] {
  const ids = new Set<string>();
  for (const node of [$pos.nodeBefore, $pos.nodeAfter]) {
    for (const mark of node?.marks ?? []) {
      if (mark.type.name === COMMENT_MARK) ids.add(mark.attrs.threadId as string);
    }
  }
  return [...ids];
}
