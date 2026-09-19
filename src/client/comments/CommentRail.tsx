import type { Editor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { NewCommentCard } from "./NewCommentCard";
import { layoutRail } from "./rail-layout";
import type { Thread } from "./model";
import { ThreadCard } from "./ThreadCard";
import { resolveRange } from "./tracked-range";
import type { Comments } from "./useComments";

/** Width of the comment margin in pixels; the document screen reserves it beside the page. */
export const RAIL_WIDTH = 272;

type RailEntry = { id: string; pos: number } & ({ kind: "thread"; thread: Thread } | { kind: "draft" });

/**
 * Comment cards beside the page, each level with its text (plan §6.2): open threads with text
 * in the document, plus the comment being written. Cards are positioned from the anchors'
 * screen positions, so they follow pagination, zoom and remote edits.
 */
export function CommentRail({ comments, editor }: { comments: Comments; editor: Editor }) {
  const railRef = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [tops, setTops] = useState(new Map<string, number>());
  const [, relayout] = useReducer((n: number) => n + 1, 0);

  // Items in document order: the draft goes where its text is.
  const draftPos = comments.draft ? resolveRange(editor.state, comments.draft.range)?.from : undefined;
  const items: RailEntry[] = comments.anchored.map(({ thread, anchor }) => ({ kind: "thread", id: thread.id, pos: anchor.from, thread }));
  if (comments.draft && draftPos !== undefined) {
    const index = items.findIndex((item) => item.pos > draftPos);
    items.splice(index === -1 ? items.length : index, 0, { kind: "draft", id: comments.draft.threadId, pos: draftPos });
  }

  // Anything that moves text or resizes a card calls for a new layout (once per frame).
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(relayout);
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
  }, [editor, items.length]);

  // Runs after every render: anchors and card heights are read from the DOM.
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail || editor.isDestroyed) return;
    const railTop = rail.getBoundingClientRect().top;
    const size = editor.state.doc.content.size;
    const next = layoutRail(
      items.map((item) => ({
        id: item.id,
        anchorTop: editor.view.coordsAtPos(Math.min(item.pos, size)).top - railTop,
        height: cards.current.get(item.id)?.offsetHeight ?? 0,
      })),
      comments.activeId,
    );
    setTops((current) => (sameTops(current, next) ? current : next));
  });

  return (
    <div ref={railRef} className="relative shrink-0 print:hidden" style={{ width: RAIL_WIDTH }} aria-label="Comments" role="complementary">
      {items.map((item) => (
        <div
          key={item.id}
          ref={(element) => {
            if (element) cards.current.set(item.id, element);
            else cards.current.delete(item.id);
          }}
          className="absolute inset-x-0"
          style={{ top: tops.get(item.id) ?? 0, visibility: tops.has(item.id) ? "visible" : "hidden" }}
        >
          {item.kind === "thread" ? (
            <ThreadCard thread={item.thread} comments={comments} active={comments.activeId === item.id} />
          ) : (
            <NewCommentCard comments={comments} />
          )}
        </div>
      ))}
    </div>
  );
}

function sameTops(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, top] of b) if (Math.abs((a.get(id) ?? Number.NaN) - top) > 0.5) return false;
  return true;
}
