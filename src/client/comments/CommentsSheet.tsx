import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NewCommentCard } from "./NewCommentCard";
import { ThreadCard } from "./ThreadCard";
import type { Comments } from "./useComments";

type View = "open" | "resolved";

/**
 * Every thread in the document: open ones in document order, then those whose text was
 * deleted, and resolved ones on a second tab. On narrow screens this is also where comments
 * are written and replied to, since there is no margin.
 */
export function CommentsSheet({ comments, open, onOpenChange }: { comments: Comments; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [view, setView] = useState<View>("open");
  const openCount = comments.anchored.length + comments.detached.length;

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
              {tab === "open" ? `Open (${openCount})` : `Resolved (${comments.resolved.length})`}
            </Button>
          ))}
        </div>
        <div className="grid content-start gap-3 overflow-y-auto px-4 pb-6">
          {view === "open" ? (
            <>
              <NewCommentCard comments={comments} showQuote />
              {comments.anchored.map(({ thread }) => (
                <ThreadCard key={thread.id} thread={thread} comments={comments} active={comments.activeId === thread.id} inPanel />
              ))}
              {comments.detached.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} comments={comments} active={comments.activeId === thread.id} inPanel detached />
              ))}
              {openCount === 0 && !comments.draft && <Empty text="No open comments. Select text and choose Insert → Comment." />}
            </>
          ) : (
            <>
              {comments.resolved.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} comments={comments} active={false} inPanel />
              ))}
              {comments.resolved.length === 0 && <Empty text="No resolved comments." />}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}
