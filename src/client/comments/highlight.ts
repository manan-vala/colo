/**
 * Highlights for commented text. The comment mark renders a plain `<span data-comment-id>`;
 * which spans are highlighted depends on thread state (open, resolved, active), so the rules
 * are generated here instead of stored in the document. Resolving a thread only changes this
 * stylesheet, and nothing is recomputed per keystroke.
 */

/** Thread IDs are UUIDs; anything else from a buggy client is left unhighlighted. */
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

const selector = (id: string) => `.colo-editor [data-comment-id="${id}"]`;

export function commentStyles(openIds: string[], activeId: string | null): string {
  const open = openIds.filter((id) => SAFE_ID.test(id));
  if (open.length === 0) return "";
  const rules = [`${open.map(selector).join(",\n")} { background-color: rgb(253 231 164 / 70%); border-bottom: 2px solid rgb(251 188 4); }`];
  if (activeId && open.includes(activeId)) rules.push(`${selector(activeId)} { background-color: rgb(250 204 90 / 85%); }`);
  return `@media screen {\n${rules.join("\n")}\n}`;
}
