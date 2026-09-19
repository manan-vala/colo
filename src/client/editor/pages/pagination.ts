import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  formatHeaderFooter,
  pageBreakHeight,
  contentTop,
  pagesHeight,
  requiredPages,
  type PageLayout,
} from "./layout";
import { PAGE_BREAK_SELECTOR } from "./page-break";

/**
 * Real pages (plan F6), drawn entirely with decorations so the shared document never changes.
 *
 * A widget at the start of the document holds one full-width float per margin band — the first
 * page's header, then each page's footer, the gap and the next page's header — separated by
 * zero-width floats whose top margin is one page's text height. Floats are positioned from the
 * top of the editor, independent of content, and text lines cannot sit beside a full-width
 * float, so every line lands inside a page's text area. Block formatting contexts (table rows,
 * flex list items) move below a band as a whole, which is what splits tables between rows.
 *
 * After each document change the plugin measures where the content ends, sizes page breaks and
 * redraws the bands if the page count changed.
 */

export interface PaginationState {
  layout: PageLayout | null;
  pages: number;
  /** Derived from layout and pages; rebuilt only when they change. */
  decorations: DecorationSet;
  attributes: Record<string, string>;
}

type PaginationMeta = { layout: PageLayout | null } | { pages: number };

export const paginationKey = new PluginKey<PaginationState>("colo-pagination");


const printMedia = window.matchMedia("print");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pagination: {
      /** Draws pages with this layout, or a continuous document for null. */
      setPageLayout: (layout: PageLayout | null) => ReturnType;
    };
  }
}

export function paginationState(state: EditorState): PaginationState | undefined {
  return paginationKey.getState(state);
}

function buildState(doc: ProseMirrorNode, layout: PageLayout | null, pages: number): PaginationState {
  if (!layout) return { layout, pages, decorations: DecorationSet.empty, attributes: {} };
  return {
    layout,
    pages,
    decorations: DecorationSet.create(doc, [pagesWidget(layout, pages)]),
    attributes: { class: "colo-paged", style: layoutStyle(layout, pages) },
  };
}

export const Pagination = Extension.create({
  name: "pagination",

  addCommands() {
    return {
      setPageLayout:
        (layout) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(paginationKey, { layout } satisfies PaginationMeta).setMeta("addToHistory", false);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<PaginationState>({
        key: paginationKey,
        state: {
          init: (_, state) => buildState(state.doc, null, 1),
          apply: (tr, value) => {
            const meta = tr.getMeta(paginationKey) as PaginationMeta | undefined;
            if (meta && "layout" in meta) return buildState(tr.doc, meta.layout, value.pages);
            if (meta && meta.pages !== value.pages) return buildState(tr.doc, value.layout, meta.pages);
            if (!tr.docChanged) return value;
            return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations: (state) => paginationState(state)?.decorations,
          attributes: (state) => paginationState(state)?.attributes ?? {},
        },
        view: (view) => new PaginationView(view),
      }),
    ];
  },
});

/** Measures the document after it changes and keeps page count and page breaks in step. */
class PaginationView {
  private frame = 0;
  /** How far content ran past the last page when pages were last added for this document state. */
  private lastOverflow: number | null = null;
  private readonly onFontsLoaded = () => this.schedule();

  constructor(private readonly view: EditorView) {
    document.fonts?.addEventListener("loadingdone", this.onFontsLoaded);
    this.schedule();
  }

  update(view: EditorView, previous: EditorState) {
    const before = paginationState(previous);
    const after = paginationState(view.state);
    if (view.state.doc !== previous.doc || before?.layout !== after?.layout) {
      this.lastOverflow = null;
      this.schedule();
    } else if (before?.pages !== after?.pages) {
      this.schedule();
    }
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    document.fonts?.removeEventListener("loadingdone", this.onFontsLoaded);
  }

  private schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.measure());
  }

  private measure() {
    const { view } = this;
    // Print layout hides the gaps between pages, so screen geometry does not apply; the pages
    // drawn for the screen are exactly what prints.
    if (view.isDestroyed || printMedia.matches) return;
    const state = paginationState(view.state);
    if (!state) return;
    const { layout, pages } = state;
    const breaks = view.dom.querySelectorAll<HTMLElement>(`:scope > ${PAGE_BREAK_SELECTOR}`);
    if (!layout) {
      for (const element of breaks) element.style.removeProperty("height");
      return;
    }

    // In document order: each break's height moves everything after it.
    for (const element of breaks) {
      const height = pageBreakHeight(layout, element.offsetTop);
      if (Math.abs(element.offsetHeight - height) > 0.5) element.style.height = `${height}px`;
    }

    const bottom = contentBottom(view.dom);
    const needed = requiredPages(layout, bottom, pages);
    if (needed === pages) return;
    if (needed > pages) {
      // Adding pages normally shrinks the overflow. If it did not, something that cannot fit
      // between two bands keeps being pushed past the last one; stop instead of looping.
      const overflow = bottom - (contentTop(layout, pages) + layout.contentHeight);
      if (this.lastOverflow !== null && overflow >= this.lastOverflow - 1) return;
      this.lastOverflow = overflow;
    }
    view.dispatch(view.state.tr.setMeta(paginationKey, { pages: needed } satisfies PaginationMeta).setMeta("addToHistory", false));
  }
}

/** Bottom of the last block of content, in the editor's coordinates. */
function contentBottom(root: HTMLElement): number {
  for (let element = root.lastElementChild; element; element = element.previousElementSibling) {
    if (!(element instanceof HTMLElement) || element.classList.contains("ProseMirror-gapcursor")) continue;
    if (element.classList.contains("colo-pages")) return 0;
    return element.offsetTop + element.offsetHeight;
  }
  return 0;
}

function layoutStyle(layout: PageLayout, pages: number): string {
  const vars: Record<string, number> = {
    "page-width": layout.pageWidth,
    "page-height": layout.pageHeight,
    "margin-top": layout.marginTop,
    "margin-bottom": layout.marginBottom,
    "margin-left": layout.marginLeft,
    "margin-right": layout.marginRight,
    "content-height": layout.contentHeight,
    "page-gap": layout.gap,
    "pages-height": pagesHeight(layout, pages),
    "print-height": pagesHeight(layout, pages, true),
  };
  return Object.entries(vars)
    .map(([name, value]) => `--colo-${name}: ${value}px`)
    .join("; ");
}

function pagesWidget(layout: PageLayout, pages: number): Decoration {
  const key = `colo-pages:${pages}:${JSON.stringify(layout)}`;
  return Decoration.widget(0, () => renderPages(layout, pages), { key, side: -1, ignoreSelection: true });
}

function renderPages(layout: PageLayout, pages: number): HTMLElement {
  const root = element("div", "colo-pages");
  root.contentEditable = "false";
  root.setAttribute("aria-hidden", "true");
  const band = (...children: HTMLElement[]) => {
    const node = element("div", "colo-page-band");
    node.append(...children);
    return node;
  };
  root.append(band(renderHeaderFooter("header", layout.header, 1, pages)));
  for (let page = 1; page <= pages; page++) {
    const spacer = element("div", "colo-page-spacer");
    const parts = [renderHeaderFooter("footer", layout.footer, page, pages)];
    if (page < pages) parts.push(element("div", "colo-page-gap"), renderHeaderFooter("header", layout.header, page + 1, pages));
    root.append(spacer, band(...parts));
  }
  return root;
}

function renderHeaderFooter(kind: "header" | "footer", text: { left: string; right: string }, page: number, total: number) {
  const node = element("div", `colo-page-${kind}`);
  const left = element("span", "colo-page-text");
  const right = element("span", "colo-page-text");
  // textContent, never innerHTML: header and footer text comes from the shared document.
  left.textContent = formatHeaderFooter(text.left, page, total);
  right.textContent = formatHeaderFooter(text.right, page, total);
  node.append(left, right);
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
