import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { PageSettings } from "../../shared/doc-schema";
import type { Member } from "../../shared/protocol";
import { updatePageSettings, usePageSettings } from "../collab/usePageSettings";
import type { Collaboration } from "../collab/useCollaboration";
import { CommentRail, RAIL_WIDTH } from "../comments/CommentRail";
import { CommentsSheet } from "../comments/CommentsSheet";
import { CommentStyles } from "../comments/CommentStyles";
import { useComments } from "../comments/useComments";
import { buildExtensions } from "../editor/extensions";
import { resolvePageLayout } from "../editor/pages";
import { Toolbar } from "../editor/toolbar/Toolbar";
import { MenuBar } from "./MenuBar";
import { Outline } from "./Outline";
import { PageSetupDialog } from "./PageSetupDialog";
import { PrintStyles } from "./PrintStyles";

const OUTLINE_KEY = "colo.outlineOpen";
const DESKTOP_QUERY = "(min-width: 1024px)";
/** Narrower screens get a continuous page and no page bands (plan §6.2). */
const PAGED_QUERY = "(min-width: 640px)";
/** Width of a continuous (pageless) page; see .colo-page in index.css. */
const CONTINUOUS_PAGE_WIDTH = 816;

export interface DocumentEditorProps {
  collab: Collaboration;
  member: Member;
  /** The title bar; `actions` (the comments button) go beside the presence avatars. */
  renderTitleBar: (actions: ReactNode) => ReactNode;
  onError: (message: string) => void;
}

/** Creates the collaborative editor for an open document, then shows the document screen. */
export function DocumentEditor(props: DocumentEditorProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const editor = useEditor(
    {
      // Tiptap's injected <style> element is replaced by the rules in index.css.
      injectCSS: false,
      extensions: buildExtensions(props.collab),
      editorProps: {
        attributes: { class: "colo-editor", "aria-label": "Document", spellcheck: "true" },
        handleKeyDown: (_view, event) => {
          if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
            event.preventDefault();
            setLinkOpen(true);
            return true;
          }
          return false;
        },
      },
    },
    [props.collab.doc, props.collab.provider],
  );
  if (!editor) return null;
  return <DocumentScreen {...props} editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />;
}

/**
 * The Google Docs-style document screen: title bar, menu bar, toolbar, outline, the page canvas
 * and the comment margin (or the comments panel when there is no room for a margin).
 */
function DocumentScreen({
  collab,
  member,
  renderTitleBar,
  onError,
  editor,
  linkOpen,
  onLinkOpenChange,
}: DocumentEditorProps & { editor: Editor; linkOpen: boolean; onLinkOpenChange: (open: boolean) => void }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const wide = useMediaQuery(PAGED_QUERY);
  const [zoom, setZoom] = useState(100);

  // Pages
  const pageSettings = usePageSettings(collab.doc);
  const layout = useMemo(() => resolvePageLayout(pageSettings), [pageSettings]);
  const paged = pageSettings.pagination && wide;
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  useEffect(() => {
    editor.commands.setPageLayout(paged ? layout : null);
  }, [editor, paged, layout]);
  const applyPageSettings = (next: PageSettings) => {
    updatePageSettings(collab.doc, next);
    setPageSetupOpen(false);
  };

  // Outline
  const [outlinePreferred, setOutlinePreferred] = useState(readOutlinePreference);
  const [outlineSheetOpen, setOutlineSheetOpen] = useState(false);
  const outlineOpen = desktop ? outlinePreferred : outlineSheetOpen;
  const toggleOutline = () => {
    if (!desktop) {
      setOutlineSheetOpen((open) => !open);
      return;
    }
    setOutlinePreferred((open) => {
      writeOutlinePreference(!open);
      return !open;
    });
  };

  // Comments: a margin beside the page when it fits, otherwise the comments panel.
  const author = useMemo(() => ({ id: member.id, name: member.displayName }), [member.id, member.displayName]);
  const comments = useComments(editor, collab.doc, author);
  const [commentsSheetOpen, setCommentsSheetOpen] = useState(false);
  const canvasRef = useRef<HTMLElement>(null);
  const canvasWidth = useElementWidth(canvasRef);
  const pageWidth = ((paged ? layout.pageWidth : CONTINUOUS_PAGE_WIDTH) * zoom) / 100;
  const marginFits = desktop && canvasWidth >= pageWidth + RAIL_WIDTH + 48;
  const showRail = marginFits && (comments.anchored.length > 0 || comments.draft !== null);
  const openCount = comments.anchored.length + comments.detached.length;

  const addComment = () => {
    if (!comments.start()) {
      onError("Select some text to comment on.");
      return;
    }
    if (!marginFits) setCommentsSheetOpen(true);
  };
  useEffect(() => {
    editor.storage.comment.onAddComment = addComment;
  });

  const commentsButton = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Comments (${openCount} open)`}
      title="Show all comments"
      onClick={() => setCommentsSheetOpen(true)}
    >
      <MessageSquareText data-icon="inline-start" />
      <span className="tabular-nums">{openCount}</span>
    </Button>
  );

  return (
    <div className="flex h-svh flex-col bg-[#f9fbfd] print:block print:h-auto print:bg-white">
      <PrintStyles settings={pageSettings} paged={paged} />
      <CommentStyles openIds={comments.anchored.map((a) => a.thread.id)} activeId={comments.activeId} />
      <header className="shrink-0 bg-background px-2 pt-2 sm:px-3 print:hidden">
        {renderTitleBar(commentsButton)}
        <div className="overflow-x-auto pb-1 pl-9 [scrollbar-width:none]">
          <MenuBar
            editor={editor}
            zoom={zoom}
            onZoom={setZoom}
            outlineOpen={outlineOpen}
            onToggleOutline={toggleOutline}
            onInsertLink={() => onLinkOpenChange(true)}
            onInsertComment={addComment}
            onPageSetup={() => setPageSetupOpen(true)}
            pageSettings={pageSettings}
            onPageSettingsChange={(next) => updatePageSettings(collab.doc, next)}
            onError={onError}
          />
        </div>
      </header>
      <div className="shrink-0 bg-background px-2 pb-2 sm:px-3 print:hidden">
        <Toolbar
          editor={editor}
          zoom={zoom}
          onZoom={setZoom}
          outlineOpen={outlineOpen}
          onToggleOutline={toggleOutline}
          linkOpen={linkOpen}
          onLinkOpenChange={onLinkOpenChange}
          onAddComment={addComment}
        />
      </div>

      <div className="flex min-h-0 flex-1 print:block">
        {desktop && outlinePreferred && (
          <aside className="w-60 shrink-0 overflow-y-auto border-r bg-background/60 px-2 py-4 print:hidden">
            <Outline editor={editor} />
          </aside>
        )}
        <main ref={canvasRef} className="min-w-0 flex-1 overflow-auto print:overflow-visible" data-testid="canvas">
          <div className="flex min-w-fit gap-6 pr-6 print:block print:p-0">
            {/* CSS zoom keeps caret and selection coordinates correct in current browsers. */}
            <div className="colo-page-zoom min-w-0 flex-1" style={{ zoom: zoom / 100 }}>
              <div className="colo-page" data-paged={paged || undefined}>
                <EditorContent editor={editor} />
              </div>
            </div>
            {showRail && <CommentRail comments={comments} editor={editor} />}
          </div>
        </main>
      </div>

      {!marginFits && comments.activeId && !commentsSheetOpen && (
        <Button className="fixed right-4 bottom-4 z-10 shadow-lg print:hidden" onClick={() => setCommentsSheetOpen(true)}>
          <MessageSquareText data-icon="inline-start" />
          Show comment
        </Button>
      )}

      <CommentsSheet comments={comments} open={commentsSheetOpen} onOpenChange={setCommentsSheetOpen} />
      <PageSetupDialog open={pageSetupOpen} onOpenChange={setPageSetupOpen} settings={pageSettings} onApply={applyPageSettings} />
      {!desktop && (
        <Sheet open={outlineSheetOpen} onOpenChange={setOutlineSheetOpen}>
          <SheetContent side="left" className="w-72 overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Outline</SheetTitle>
              <SheetDescription>Jump to a heading.</SheetDescription>
            </SheetHeader>
            <div className="px-2">
              <Outline editor={editor} showTitle={false} onNavigate={() => setOutlineSheetOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function readOutlinePreference(): boolean {
  try {
    return localStorage.getItem(OUTLINE_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeOutlinePreference(open: boolean) {
  try {
    localStorage.setItem(OUTLINE_KEY, String(open));
  } catch {
    // Preference only; ignore storage failures.
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
