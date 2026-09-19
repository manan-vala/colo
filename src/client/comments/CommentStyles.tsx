import { commentStyles } from "./highlight";

/** The highlight stylesheet for commented text; see highlight.ts. */
export function CommentStyles({ openIds, activeId }: { openIds: string[]; activeId: string | null }) {
  return <style>{commentStyles(openIds, activeId)}</style>;
}
