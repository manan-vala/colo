import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Collaboration } from "../collab/useCollaboration";
import { buildExtensions } from "../editor/extensions";
import { Toolbar } from "../editor/toolbar/Toolbar";
import { MenuBar } from "./MenuBar";
import { Outline } from "./Outline";

const OUTLINE_KEY = "colo.outlineOpen";
const DESKTOP_QUERY = "(min-width: 1024px)";

function readOutlinePreference(): boolean {
  try {
    return localStorage.getItem(OUTLINE_KEY) !== "false";
  } catch {
    return true;
  }
}

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setDesktop(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

/**
 * The Google Docs-style document screen: title bar (passed in), menu bar, toolbar, outline and
 * the page canvas with the collaborative editor.
 */
export function DocumentEditor({ collab, titleBar, onError }: { collab: Collaboration; titleBar: ReactNode; onError: (message: string) => void }) {
  const desktop = useIsDesktop();
  const [zoom, setZoom] = useState(100);
  const [outlinePreferred, setOutlinePreferred] = useState(readOutlinePreference);
  const [outlineSheetOpen, setOutlineSheetOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const editor = useEditor(
    {
      // Tiptap's injected <style> element is replaced by the rules in index.css.
      injectCSS: false,
      extensions: buildExtensions(collab),
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
    [collab.doc, collab.provider],
  );

  const outlineOpen = desktop ? outlinePreferred : outlineSheetOpen;
  const toggleOutline = () => {
    if (!desktop) {
      setOutlineSheetOpen((open) => !open);
      return;
    }
    setOutlinePreferred((open) => {
      try {
        localStorage.setItem(OUTLINE_KEY, String(!open));
      } catch {
        // Preference only; ignore storage failures.
      }
      return !open;
    });
  };

  return (
    <div className="flex h-svh flex-col bg-[#f9fbfd]">
      <header className="shrink-0 bg-background px-2 pt-2 sm:px-3">
        {titleBar}
        {editor && (
          <div className="overflow-x-auto pb-1 pl-9 [scrollbar-width:none]">
            <MenuBar
              editor={editor}
              zoom={zoom}
              onZoom={setZoom}
              outlineOpen={outlineOpen}
              onToggleOutline={toggleOutline}
              onInsertLink={() => setLinkOpen(true)}
              onError={onError}
            />
          </div>
        )}
      </header>
      {editor && (
        <div className="shrink-0 bg-background px-2 pb-2 sm:px-3">
          <Toolbar
            editor={editor}
            zoom={zoom}
            onZoom={setZoom}
            outlineOpen={outlineOpen}
            onToggleOutline={toggleOutline}
            linkOpen={linkOpen}
            onLinkOpenChange={setLinkOpen}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {editor && desktop && outlinePreferred && (
          <aside className="w-60 shrink-0 overflow-y-auto border-r bg-background/60 px-2 py-4">
            <Outline editor={editor} />
          </aside>
        )}
        <main className="min-w-0 flex-1 overflow-auto" data-testid="canvas">
          <div
            className="colo-page-zoom"
            ref={(element) => {
              // CSS zoom keeps caret and selection coordinates correct in current browsers.
              if (element) element.style.zoom = String(zoom / 100);
            }}
          >
            <div className="colo-page">
              <EditorContent editor={editor} />
            </div>
          </div>
        </main>
      </div>

      {editor && !desktop && (
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
