import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  type ProsemirrorBinding,
} from "@tiptap/y-tiptap";

/**
 * A text range that survives edits from both people while a new comment is being written.
 * ProseMirror positions do not: y-prosemirror applies remote changes by replacing content, so
 * the range is kept as Yjs relative positions and resolved again when the comment is posted.
 */
export interface TrackedRange {
  from: unknown;
  to: unknown;
}

function binding(state: EditorState): ProsemirrorBinding | null {
  return (ySyncPluginKey.getState(state)?.binding as ProsemirrorBinding | undefined) ?? null;
}

export function trackRange(state: EditorState, from: number, to: number): TrackedRange | null {
  const b = binding(state);
  if (!b) return null;
  return {
    from: absolutePositionToRelativePosition(from, b.type, b.mapping),
    to: absolutePositionToRelativePosition(to, b.type, b.mapping),
  };
}

/** The range's current positions, or null if its text was deleted meanwhile. */
export function resolveRange(state: EditorState, range: TrackedRange): { from: number; to: number } | null {
  const b = binding(state);
  if (!b) return null;
  const from = relativePositionToAbsolutePosition(b.doc, b.type, range.from, b.mapping);
  const to = relativePositionToAbsolutePosition(b.doc, b.type, range.to, b.mapping);
  return from !== null && to !== null && to > from ? { from, to } : null;
}
