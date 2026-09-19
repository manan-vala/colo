import { Check, EllipsisVertical, RotateCcw } from "lucide-react";
import { memo, useRef, useState } from "react";
import { memberColor } from "../../shared/protocol";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { timeAgo } from "../lib/time";
import { CommentComposer } from "./CommentComposer";
import { isThreadStart, type Comment, type Thread } from "./model";
import type { CommentsActions } from "./useComments";

interface ThreadCardProps {
  thread: Thread;
  active: boolean;
  /** The signed-in member, who may edit and delete their own comments. */
  authorId: string;
  actions: CommentsActions;
  inPanel?: boolean;
  detached?: boolean;
}

/**
 * One comment thread: its comments, a reply box when active, and resolve / reopen. In the
 * margin an inactive thread shows only its first comment; the panel shows the quoted text too.
 * Memoised: typing in the document does not re-render the cards.
 */
export const ThreadCard = memo(function ThreadCard({ thread, active, authorId, actions, inPanel = false, detached = false }: ThreadCardProps) {
  const [first, ...replies] = thread.comments;
  const expanded = active || inPanel;
  const shown = expanded ? replies : [];

  return (
    <article
      aria-label={`Comment by ${first.authorName}`}
      data-thread-id={thread.id}
      data-active={active || undefined}
      className="grid cursor-pointer gap-3 rounded-lg border bg-card p-3 text-sm shadow-sm transition-shadow data-[active]:cursor-default data-[active]:shadow-md data-[active]:ring-1 data-[active]:ring-primary/20"
      onClick={() => {
        if (!active) actions.focus(thread.id);
      }}
    >
      {(inPanel || detached) && (
        <blockquote className="border-l-2 border-amber-400 pl-2 text-xs text-muted-foreground">
          {thread.quote ? `“${thread.quote}”` : "(no text)"}
          {detached && <span className="mt-0.5 block italic">The commented text was deleted.</span>}
        </blockquote>
      )}
      {thread.resolved && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Resolved by {thread.resolvedByName ?? "someone"}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={(event) => {
              event.stopPropagation();
              actions.reopen(thread.id);
            }}
          >
            <RotateCcw data-icon="inline-start" />
            Reopen
          </Button>
        </div>
      )}

      <CommentView thread={thread} comment={first} authorId={authorId} actions={actions} />
      {!expanded && replies.length > 0 && (
        <p className="text-xs font-medium text-primary">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </p>
      )}
      {shown.map((comment) => (
        <CommentView key={comment.id} thread={thread} comment={comment} authorId={authorId} actions={actions} />
      ))}

      {active && !thread.resolved && (
        <CommentComposer
          key={thread.id}
          label="Reply"
          placeholder="Reply"
          submitLabel="Reply"
          collapsed
          onSubmit={(body) => actions.reply(thread.id, body)}
        />
      )}
    </article>
  );
});

function CommentView({ thread, comment, authorId, actions }: { thread: Thread; comment: Comment; authorId: string; actions: CommentsActions }) {
  const [editing, setEditing] = useState(false);
  const editBox = useRef<HTMLTextAreaElement>(null);
  const own = comment.authorId === authorId;
  const start = isThreadStart(thread, comment.id);

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Avatar name={comment.authorName} color={memberColor(comment.authorId)} className="size-7" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate font-medium">{comment.authorName || "Unknown"}</p>
          <p className="text-xs text-muted-foreground">
            {timeAgo(comment.createdAt)}
            {comment.editedAt && !comment.deleted && " · edited"}
          </p>
        </div>
        {start && !thread.resolved && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Resolve"
            title="Mark as resolved and hide"
            onClick={(event) => {
              event.stopPropagation();
              actions.resolve(thread.id);
            }}
          >
            <Check />
          </Button>
        )}
        {own && !comment.deleted && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="More options" onClick={(event) => event.stopPropagation()}>
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(event) => event.stopPropagation()}
              onCloseAutoFocus={(event) => {
                // After "Edit", focus goes to the edit box instead of back to this button.
                const box = editBox.current;
                if (!box) return;
                event.preventDefault();
                box.focus();
                box.setSelectionRange(box.value.length, box.value.length);
              }}
            >
              <DropdownMenuItem onSelect={() => setEditing(true)}>Edit</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(thread.id, comment.id)}>
                {start ? "Delete thread" : "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {editing ? (
        <CommentComposer
          label="Edit comment"
          placeholder="Comment"
          submitLabel="Save"
          initial={comment.body}
          textareaRef={editBox}
          onSubmit={(body) => {
            const saved = actions.edit(thread.id, comment.id, body);
            if (saved) setEditing(false);
            return saved;
          }}
          onCancel={() => setEditing(false)}
        />
      ) : comment.deleted ? (
        <p className="text-muted-foreground italic">Comment deleted</p>
      ) : (
        <p className="break-words whitespace-pre-wrap">{comment.body}</p>
      )}
    </div>
  );
}
