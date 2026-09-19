import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Thread } from "./model";
import { NewCommentCard } from "./NewCommentCard";
import { ThreadCard } from "./ThreadCard";
import type { CommentsActions, CommentsState } from "./useComments";

type View = "open" | "resolved";

/**
 * Every thread in the document: open ones in document order, then those whose text was
 * deleted, and resolved ones on a second tab. On narrow screens this is also where comments
 * are written and replied to, since there is no margin. Memoised like the margin.
 */
export const CommentsSheet = memo(function CommentsSheet({
  state,
  actions,
  open,
  onOpenChange,
}: {
  state: CommentsState;
  actions: CommentsActions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [view, setView] = useState<View>("open");
  const openCount = state.anchored.length + state.detached.length;
  const card = (thread: Thread, extra: { detached?: boolean } = {}) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      active={state.activeId === thread.id}
      authorId={state.author.id}
      actions={actions}
      inPanel
      {...extra}
    />
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Comments</SheetTitle>
          <SheetDescription>Everyone in this document sees these.</SheetDescription>
        </SheetHeader>
        <div role="tablist" aria-label="Comment filter" className="flex gap-1 px-4 pb-3">
          {(["open", "resolved"] as const).map((tab) => (
            <Button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              variant={view === tab ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setView(tab)}
            >
              {tab === "open" ? `Open (${openCount})` : `Resolved (${state.resolved.length})`}
            </Button>
          ))}
        </div>
        <div className="grid content-start gap-3 overflow-y-auto px-4 pb-6">
          {view === "open" ? (
            <>
              <NewCommentCard state={state} actions={actions} showQuote />
              {state.anchored.map((thread) => card(thread))}
              {state.detached.map((thread) => card(thread, { detached: true }))}
              {openCount === 0 && !state.draft && <Empty text="No open comments. Select text and choose Insert → Comment." />}
            </>
          ) : (
            <>
              {state.resolved.map((thread) => card(thread))}
              {state.resolved.length === 0 && <Empty text="No resolved comments." />}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
});

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}
