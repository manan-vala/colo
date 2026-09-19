import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SETTINGS,
  SETTINGS_KEYS,
  fitsPage,
  readPageSettings,
  sheetSize,
  type PageSettings,
} from "../src/shared/doc-schema";
import {
  contentTop,
  formatHeaderFooter,
  gridColumns,
  mmToPx,
  pageAt,
  pageBreakHeight,
  pagesHeight,
  parseHeaderFooter,
  requiredPages,
  resolvePageLayout,
} from "../src/client/editor/pages/layout";

const settings = (patch: Partial<PageSettings> = {}): PageSettings => ({ ...DEFAULT_PAGE_SETTINGS, ...patch });
const fromMap = (values: Record<string, unknown>) => readPageSettings((key) => values[key]);

describe("page settings", () => {
  it("defaults to A4 portrait with 1-inch margins and no headers or footers", () => {
    expect(fromMap({})).toEqual(DEFAULT_PAGE_SETTINGS);
    expect(DEFAULT_PAGE_SETTINGS.pageSize).toBe("A4");
    expect(DEFAULT_PAGE_SETTINGS.margins.top).toBe(25.4);
  });

  it("reads stored values and ignores malformed ones", () => {
    const read = fromMap({
      [SETTINGS_KEYS.pageSize]: "LETTER",
      [SETTINGS_KEYS.orientation]: "sideways",
      [SETTINGS_KEYS.margins]: { top: 10, bottom: 10, left: 10, right: -5 },
      [SETTINGS_KEYS.header]: { left: "Draft", right: "{page}" },
      [SETTINGS_KEYS.footer]: "not an object",
      [SETTINGS_KEYS.pagination]: false,
    });
    expect(read.pageSize).toBe("LETTER");
    expect(read.orientation).toBe("portrait");
    expect(read.margins).toEqual(DEFAULT_PAGE_SETTINGS.margins);
    expect(read.header).toEqual({ left: "Draft", right: "{page}" });
    expect(read.footer).toEqual(DEFAULT_PAGE_SETTINGS.footer);
    expect(read.pagination).toBe(false);
  });

  it("falls back to default margins when stored ones leave no room for text", () => {
    const read = fromMap({ [SETTINGS_KEYS.margins]: { top: 20, bottom: 20, left: 100, right: 100 } });
    expect(read.margins).toEqual(DEFAULT_PAGE_SETTINGS.margins);
  });

  it("truncates very long header and footer text", () => {
    const read = fromMap({ [SETTINGS_KEYS.header]: { left: "x".repeat(1000), right: "" } });
    expect(read.header.left.length).toBe(200);
  });

  it("swaps width and height for landscape", () => {
    expect(sheetSize(settings())).toEqual({ width: 210, height: 297 });
    expect(sheetSize(settings({ orientation: "landscape" }))).toEqual({ width: 297, height: 210 });
    expect(fitsPage(settings({ orientation: "landscape", margins: { top: 81, bottom: 80, left: 10, right: 10 } }))).toBe(false);
    expect(fitsPage(settings({ orientation: "landscape", margins: { top: 80, bottom: 80, left: 10, right: 10 } }))).toBe(true);
  });
});

describe("page layout", () => {
  const layout = resolvePageLayout(settings());

  it("converts millimetres to CSS pixels at 96 dpi", () => {
    expect(mmToPx(25.4)).toBe(96);
    expect(layout.pageWidth).toBeCloseTo(793.7, 1);
    expect(layout.pageHeight).toBeCloseTo(1122.52, 2);
    expect(resolvePageLayout(settings({ pageSize: "LETTER" })).pageWidth).toBe(816);
  });

  it("places each page's text area one stride below the previous one", () => {
    expect(layout.contentHeight).toBeCloseTo(layout.pageHeight - 192, 5);
    expect(contentTop(layout, 1)).toBe(96);
    expect(contentTop(layout, 3)).toBeCloseTo(96 + 2 * layout.stride, 5);
    expect(pagesHeight(layout, 3)).toBeCloseTo(3 * layout.pageHeight + 2 * layout.gap, 5);
    expect(pagesHeight(layout, 3, true)).toBeCloseTo(3 * layout.pageHeight, 5);
  });

  it("finds the page for a position, counting a margin band with the page above it", () => {
    expect(pageAt(layout, 0)).toBe(1);
    expect(pageAt(layout, contentTop(layout, 1) + layout.contentHeight + 10)).toBe(1);
    expect(pageAt(layout, contentTop(layout, 2) + 1)).toBe(2);
  });

  it("shrinks to the page where content ends", () => {
    expect(requiredPages(layout, contentTop(layout, 2) + 100, 5)).toBe(2);
    expect(requiredPages(layout, 50, 5)).toBe(1);
  });

  it("estimates the pages needed when content runs past the last page", () => {
    const lastEnd = contentTop(layout, 2) + layout.contentHeight;
    // Content flows on without bands past the last page: 2.5 text areas past its footer.
    const bottom = lastEnd + layout.marginBottom + 2.5 * layout.contentHeight;
    expect(requiredPages(layout, bottom, 2)).toBe(5);
  });

  it("keeps the page count when content only reaches into the last footer band", () => {
    const lastEnd = contentTop(layout, 2) + layout.contentHeight;
    expect(requiredPages(layout, lastEnd + 20, 2)).toBe(2);
  });

  it("sizes page breaks to the end of their page", () => {
    const top = contentTop(layout, 1) + 300;
    expect(pageBreakHeight(layout, top)).toBeCloseTo(layout.contentHeight - 300, 5);
    expect(pageBreakHeight(layout, contentTop(layout, 2))).toBeCloseTo(layout.contentHeight, 5);
    // A break that starts in a margin band: its page is already full.
    expect(pageBreakHeight(layout, contentTop(layout, 1) + layout.contentHeight + 5)).toBe(0);
  });
});

describe("headers and footers", () => {
  it("parses {page} and {total} fields", () => {
    expect(parseHeaderFooter("Page {page} of {total}")).toEqual(["Page ", { field: "page" }, " of ", { field: "total" }]);
    expect(parseHeaderFooter("{pages} {Page}")).toEqual(["{pages} {Page}"]);
  });

  it("fills fields and keeps everything else as plain text", () => {
    expect(formatHeaderFooter("Page {page} of {total}", 3, 12)).toBe("Page 3 of 12");
    expect(formatHeaderFooter("{page}/{page}", 2, 2)).toBe("2/2");
    expect(formatHeaderFooter("<b>{page}</b>", 1, 1)).toBe("<b>1</b>");
  });
});

describe("paged table columns", () => {
  it("turns column widths into proportional grid tracks", () => {
    expect(gridColumns([])).toBe("minmax(0, 1fr)");
    expect(gridColumns([null, null])).toBe("minmax(0, 1fr) minmax(0, 1fr)");
    expect(gridColumns([100, 300])).toBe("minmax(0, 100fr) minmax(0, 300fr)");
    expect(gridColumns([100, null, 300])).toBe("minmax(0, 100fr) minmax(0, 200fr) minmax(0, 300fr)");
  });
});
