import type { Editor } from "@tiptap/react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Thread } from "./model";
import { NewCommentCard } from "./NewCommentCard";
import { layoutRail } from "./rail-layout";
import { ThreadCard } from "./ThreadCard";
import { resolveRange } from "./tracked-range";
import type { CommentsActions, CommentsState } from "./useComments";

/** Width of the comment margin in pixels; the document screen reserves it beside the page. */
export const RAIL_WIDTH = 272;

type RailEntry = { kind: "thread"; id: string; thread: Thread } | { kind: "draft"; id: string };

/**
 * Comment cards beside the page, each level with its text (plan §6.2): open threads with text
 * in the document, plus the comment being written. Positions are read from the page itself
 * (the first highlighted span of each thread) once a frame after anything moves, so cards
 * follow pagination, zoom and remote edits. React only re-renders when a card actually moves;
 * memoised because the document screen re-renders on every presence and save-status change.
 */
export const CommentRail = memo(function CommentRail({ state, actions, editor }: { state: CommentsState; actions: CommentsActions; editor: Editor }) {
  const railRef = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [tops, setTops] = useState(new Map<string, number>());

  const entries: RailEntry[] = state.anchored.map((thread) => ({ kind: "thread", id: thread.id, thread }));
  if (state.draft) entries.push({ kind: "draft", id: state.draft.threadId });

  // Reads anchor positions and card heights, then places the cards. Always sees the latest
  // entries, so it can run from a frame callback without re-rendering first.
  const place = useRef(() => {});
  place.current = () => {
    const rail = railRef.current;
    if (!rail || editor.isDestroyed) return;
    const railTop = rail.getBoundingClientRect().top;
    const spans = firstSpans(editor);
    const items = entries
      .map((entry) => ({
        id: entry.id,
        anchorTop: anchorTop(editor, state, entry, spans) - railTop,
        height: cards.current.get(entry.id)?.offsetHeight ?? 0,
      }))
      .filter((item) => Number.isFinite(item.anchorTop))
      .sort((a, b) => a.anchorTop - b.anchorTop);
    const next = layoutRail(items, state.activeId);
    setTops((current) => (sameTops(current, next) ? current : next));
  };

  // After the cards change (a thread, the draft, the active card), place them before paint.
  useLayoutEffect(() => place.current(), [state, editor]);

  // Anything that moves text or resizes a card calls for new places (once per frame).
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => place.current());
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(editor.view.dom);
    for (const card of cards.current.values()) observer.observe(card);
    editor.on("transaction", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      editor.off("transaction", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [editor, entries.length]);

  return (
    <div ref={railRef} className="relative shrink-0 print:hidden" style={{ width: RAIL_WIDTH }} aria-label="Comments" role="complementary">
      {entries.map((entry) => (
        <div
          key={entry.id}
          ref={(element) => {
            if (element) cards.current.set(entry.id, element);
            else cards.current.delete(entry.id);
          }}
          className="absolute inset-x-0"
          style={{ top: tops.get(entry.id) ?? 0, visibility: tops.has(entry.id) ? "visible" : "hidden" }}
        >
          {entry.kind === "thread" ? (
            <ThreadCard thread={entry.thread} active={state.activeId === entry.id} authorId={state.author.id} actions={actions} />
          ) : (
            <NewCommentCard state={state} actions={actions} />
          )}
        </div>
      ))}
    </div>
  );
});

/** The first highlighted span of each thread, in one pass over the page. */
function firstSpans(editor: Editor): Map<string, Element> {
  const spans = new Map<string, Element>();
  for (const span of editor.view.dom.querySelectorAll("[data-comment-id]")) {
    const id = span.getAttribute("data-comment-id")!;
    if (!spans.has(id)) spans.set(id, span);
  }
  return spans;
}

/** Screen top of an entry's text: the first highlighted span, or the draft's selected range. */
function anchorTop(editor: Editor, state: CommentsState, entry: RailEntry, spans: Map<string, Element>): number {
  if (entry.kind === "thread") return spans.get(entry.id)?.getBoundingClientRect().top ?? Number.NaN;
  const range = state.draft ? resolveRange(editor.state, state.draft.range) : null;
  return range ? editor.view.coordsAtPos(range.from).top : Number.NaN;
}

function sameTops(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, top] of b) if (Math.abs((a.get(id) ?? Number.NaN) - top) > 0.5) return false;
  return true;
}
