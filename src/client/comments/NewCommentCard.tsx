import { memberColor } from "../../shared/protocol";
import { Avatar } from "@/components/avatar";
import { CommentComposer } from "./CommentComposer";
import type { Comments } from "./useComments";

/** The card for a comment being written on the selected text (not shared until posted). */
export function NewCommentCard({ comments, showQuote = false }: { comments: Comments; showQuote?: boolean }) {
  const { draft, author, error } = comments;
  if (!draft) return null;
  return (
    <article
      aria-label="New comment"
      data-thread-id={draft.threadId}
      className="grid gap-3 rounded-lg border bg-card p-3 text-sm shadow-md ring-1 ring-primary/20"
    >
      {showQuote && <blockquote className="border-l-2 border-amber-400 pl-2 text-xs text-muted-foreground">“{draft.quote}”</blockquote>}
      <div className="flex items-center gap-2">
        <Avatar name={author.name} color={memberColor(author.id)} className="size-7" />
        <p className="font-medium">{author.name}</p>
      </div>
      <CommentComposer
        key={draft.threadId}
        label="Comment"
        placeholder="Comment"
        submitLabel="Comment"
        autoFocus
        onSubmit={comments.post}
        onCancel={comments.cancel}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
