import { useEditorState, type Editor } from "@tiptap/react";

export interface OutlineHeading {
  level: number;
  text: string;
  /** Position of the heading node in the document. */
  pos: number;
}

/**
 * Headings are read from the editor state rather than stored as IDs in the document, so the
 * outline never writes to the shared Yjs document (no ID churn between collaborators).
 */
export function readOutline(editor: Editor): { headings: OutlineHeading[]; activePos: number | null } {
  const headings: OutlineHeading[] = [];
  const cursor = editor.state.selection.from;
  let activePos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      headings.push({ level: node.attrs.level as number, text: node.textContent, pos });
      if (pos < cursor) activePos = pos;
      return false;
    }
    return node.type.name !== "paragraph";
  });
  return { headings, activePos };
}

export function Outline({ editor, onNavigate, showTitle = true }: { editor: Editor; onNavigate?: () => void; showTitle?: boolean }) {
  const outline = useEditorState({ editor, selector: ({ editor: e }) => (e ? readOutline(e) : null), equalityFn: sameOutline });
  if (!outline) return null;

  const goTo = (pos: number) => {
    editor.chain().focus().setTextSelection(pos + 1).run();
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center", behavior: "smooth" });
    onNavigate?.();
  };

  return (
    <nav aria-label="Document outline" className="grid gap-1 text-sm">
      {showTitle && <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outline</h2>}
      {outline.headings.length === 0 ? (
        <p className="px-2 text-muted-foreground">Headings you add to the document will appear here.</p>
      ) : (
        <ul className="grid">
          {outline.headings.map((heading) => (
            <li key={heading.pos}>
              <button
                type="button"
                data-level={heading.level}
                aria-current={outline.activePos === heading.pos ? "location" : undefined}
                className="w-full truncate rounded-md px-2 py-1 text-left hover:bg-muted aria-[current=location]:font-semibold aria-[current=location]:text-primary data-[level=2]:pl-5 data-[level=3]:pl-8 data-[level=4]:pl-11"
                onClick={() => goTo(heading.pos)}
              >
                {heading.text || <span className="italic text-muted-foreground">Untitled heading</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

function sameOutline(
  a: ReturnType<typeof readOutline> | null,
  b: ReturnType<typeof readOutline> | null,
): boolean {
  if (!a || !b) return a === b;
  if (a.activePos !== b.activePos || a.headings.length !== b.headings.length) return false;
  return a.headings.every((h, i) => h.pos === b.headings[i].pos && h.text === b.headings[i].text && h.level === b.headings[i].level);
}
