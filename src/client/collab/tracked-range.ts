import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  type ProsemirrorBinding,
} from "@tiptap/y-tiptap";

/**
 * Positions that survive edits from both people while something is pending: a comment being
 * written, an image being uploaded. ProseMirror positions do not: y-prosemirror applies remote
 * changes by replacing content, so positions are kept as Yjs relative positions and resolved
 * again when they are needed.
 */
export interface TrackedRange {
  from: unknown;
  to: unknown;
}

function binding(state: EditorState): ProsemirrorBinding | null {
  return (ySyncPluginKey.getState(state)?.binding as ProsemirrorBinding | undefined) ?? null;
}

/** A single position; see `TrackedRange`. */
export type TrackedPosition = unknown;

export function trackPosition(state: EditorState, pos: number): TrackedPosition | null {
  const b = binding(state);
  return b ? absolutePositionToRelativePosition(pos, b.type, b.mapping) : null;
}

/** The position now, or null if the content around it was deleted. */
export function resolvePosition(state: EditorState, position: TrackedPosition): number | null {
  const b = binding(state);
  return b ? relativePositionToAbsolutePosition(b.doc, b.type, position, b.mapping) : null;
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
