import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { PageSettings } from "../../shared/doc-schema";
import { updatePageSettings, usePageSettings } from "../collab/usePageSettings";
import type { Collaboration } from "../collab/useCollaboration";
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

function readOutlinePreference(): boolean {
  try {
    return localStorage.getItem(OUTLINE_KEY) !== "false";
  } catch {
    return true;
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

/**
 * The Google Docs-style document screen: title bar (passed in), menu bar, toolbar, outline and
 * the page canvas with the collaborative editor.
 */
export function DocumentEditor({ collab, titleBar, onError }: { collab: Collaboration; titleBar: ReactNode; onError: (message: string) => void }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const wide = useMediaQuery(PAGED_QUERY);
  const pageSettings = usePageSettings(collab.doc);
  const layout = useMemo(() => resolvePageLayout(pageSettings), [pageSettings]);
  const paged = pageSettings.pagination && wide;
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
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

  useEffect(() => {
    editor?.commands.setPageLayout(paged ? layout : null);
  }, [editor, paged, layout]);

  const applyPageSettings = (next: PageSettings) => {
    updatePageSettings(collab.doc, next);
    setPageSetupOpen(false);
  };

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
    <div className="flex h-svh flex-col bg-[#f9fbfd] print:block print:h-auto print:bg-white">
      <PrintStyles settings={pageSettings} paged={paged} />
      <header className="shrink-0 bg-background px-2 pt-2 sm:px-3 print:hidden">
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
              onPageSetup={() => setPageSetupOpen(true)}
              pageSettings={pageSettings}
              onPageSettingsChange={(next) => updatePageSettings(collab.doc, next)}
              onError={onError}
            />
          </div>
        )}
      </header>
      {editor && (
        <div className="shrink-0 bg-background px-2 pb-2 sm:px-3 print:hidden">
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

      <div className="flex min-h-0 flex-1 print:block">
        {editor && desktop && outlinePreferred && (
          <aside className="w-60 shrink-0 overflow-y-auto border-r bg-background/60 px-2 py-4 print:hidden">
            <Outline editor={editor} />
          </aside>
        )}
        <main className="min-w-0 flex-1 overflow-auto print:overflow-visible" data-testid="canvas">
          {/* CSS zoom keeps caret and selection coordinates correct in current browsers. */}
          <div className="colo-page-zoom" style={{ zoom: zoom / 100 }}>
            <div className="colo-page" data-paged={paged || undefined}>
              <EditorContent editor={editor} />
            </div>
          </div>
        </main>
      </div>

      <PageSetupDialog open={pageSetupOpen} onOpenChange={setPageSetupOpen} settings={pageSettings} onApply={applyPageSettings} />

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
