import { sheetSize, type HeaderFooterText, type PageSettings } from "../../../shared/doc-schema";

/**
 * Page geometry in CSS pixels (96 per inch, as browsers print), derived from a document's
 * page settings. Everything the paginator draws follows from these numbers, so no header or
 * footer has to be measured: the header sits in the top margin, the footer in the bottom one.
 *
 *   page k (1-based)   content from  marginTop + (k - 1) · stride
 *                      for           contentHeight
 *   stride           = pageHeight + gap
 */
export interface PageLayout {
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  contentHeight: number;
  /** Space between pages on screen; hidden when printing. */
  gap: number;
  stride: number;
  header: HeaderFooterText;
  footer: HeaderFooterText;
}

export const PAGE_GAP_PX = 16;

const PX_PER_MM = 96 / 25.4;

export function mmToPx(mm: number): number {
  return Math.round(mm * PX_PER_MM * 100) / 100;
}

export function resolvePageLayout(settings: PageSettings): PageLayout {
  const sheet = sheetSize(settings);
  const pageWidth = mmToPx(sheet.width);
  const pageHeight = mmToPx(sheet.height);
  const marginTop = mmToPx(settings.margins.top);
  const marginBottom = mmToPx(settings.margins.bottom);
  return {
    pageWidth,
    pageHeight,
    marginTop,
    marginBottom,
    marginLeft: mmToPx(settings.margins.left),
    marginRight: mmToPx(settings.margins.right),
    contentHeight: pageHeight - marginTop - marginBottom,
    gap: PAGE_GAP_PX,
    stride: pageHeight + PAGE_GAP_PX,
    header: settings.header,
    footer: settings.footer,
  };
}

/** Top of page `page`'s text area, measured from the top of the editor. */
export function contentTop(layout: PageLayout, page: number): number {
  return layout.marginTop + (page - 1) * layout.stride;
}

/** Page (1-based) whose text area or following margin band contains `y`. */
export function pageAt(layout: PageLayout, y: number): number {
  return Math.max(1, Math.floor((y - layout.marginTop) / layout.stride) + 1);
}

/**
 * How many pages the document needs, given where its content ends while `current` pages are
 * drawn. Content past the last drawn page flows without margin bands, so that part is
 * estimated by filling whole text areas; the next measurement corrects any remainder.
 */
export function requiredPages(layout: PageLayout, contentBottom: number, current: number): number {
  const drawn = Math.max(1, current);
  const lastContentEnd = contentTop(layout, drawn) + layout.contentHeight;
  if (contentBottom > lastContentEnd + 0.5) {
    // Lines that do not fit are pushed below the last page's footer band. Text never ends
    // inside a band, so a box that merely reaches into it (say, a margin) still fits.
    const overflow = contentBottom - lastContentEnd - layout.marginBottom;
    if (overflow <= 0) return drawn;
    return drawn + Math.ceil(overflow / layout.contentHeight);
  }
  return Math.min(drawn, pageAt(layout, contentBottom - 0.5));
}

/**
 * Height a page break must take up so that the content after it starts on the next page.
 * A break that already sits in a margin band (its page is full) needs no height.
 */
export function pageBreakHeight(layout: PageLayout, top: number): number {
  const page = pageAt(layout, top);
  const end = contentTop(layout, page) + layout.contentHeight;
  return top < end ? end - top : 0;
}

/** Total height of `pages` pages on screen, and when printed (no gaps). */
export function pagesHeight(layout: PageLayout, pages: number, print = false): number {
  return pages * layout.pageHeight + (print ? 0 : (pages - 1) * layout.gap);
}

export type HeaderFooterPart = string | { field: "page" | "total" };

/** Splits header/footer text into literal text and `{page}` / `{total}` fields. */
export function parseHeaderFooter(text: string): HeaderFooterPart[] {
  const parts: HeaderFooterPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{(page|total)\}/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ field: match[1] as "page" | "total" });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Header/footer text with its fields filled in. The result is plain text, never HTML. */
export function formatHeaderFooter(text: string, page: number, total: number): string {
  return parseHeaderFooter(text)
    .map((part) => (typeof part === "string" ? part : String(part.field === "page" ? page : total)))
    .join("");
}

/**
 * Grid tracks for column widths in pixels (null where unset). Widths become proportions so a
 * table always fits the text area, as it does in print.
 */
export function gridColumns(widths: (number | null)[]): string {
  if (widths.length === 0) return "minmax(0, 1fr)";
  const set = widths.filter((w): w is number => w !== null);
  const fallback = set.length ? set.reduce((a, b) => a + b, 0) / set.length : 1;
  return widths.map((w) => `minmax(0, ${Math.round((w ?? fallback) * 100) / 100}fr)`).join(" ");
}
