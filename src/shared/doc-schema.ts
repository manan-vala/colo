/** Structure of the Yjs document behind every Colo document (plan §3.3). */

/** `Y.XmlFragment` holding the Tiptap/ProseMirror content. */
export const CONTENT_FIELD = "content";

/** `Y.Map` of document settings. Each key is last-writer-wins; a missing key means the default. */
export const SETTINGS_MAP = "settings";

export const SETTINGS_KEYS = {
  title: "title",
  pageSize: "pageSize",
  orientation: "orientation",
  /** `PageMargins`, in millimetres. */
  margins: "margins",
  /** `HeaderFooterText`; plain text with `{page}` and `{total}` placeholders. */
  header: "header",
  footer: "footer",
  /** false for a continuous ("pageless") document. */
  pagination: "pagination",
} as const;

export const DEFAULT_TITLE = "Untitled document";

// ---- page setup (M4) ------------------------------------------------------------------------

export type PageSizeName = "A4" | "LETTER";
export type Orientation = "portrait" | "landscape";

/** Portrait sheet dimensions in millimetres. */
export const PAGE_SIZES: Record<PageSizeName, { label: string; width: number; height: number }> = {
  A4: { label: "A4 (21 × 29.7 cm)", width: 210, height: 297 },
  LETTER: { label: "Letter (8.5 × 11 in)", width: 215.9, height: 279.4 },
};

export interface PageMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface HeaderFooterText {
  left: string;
  right: string;
}

export interface PageSettings {
  pageSize: PageSizeName;
  orientation: Orientation;
  margins: PageMargins;
  header: HeaderFooterText;
  footer: HeaderFooterText;
  pagination: boolean;
}

export const DEFAULT_PAGE_SETTINGS: PageSettings = {
  pageSize: "A4",
  orientation: "portrait",
  margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
  header: { left: "", right: "" },
  footer: { left: "", right: "" },
  pagination: true,
};

export const MARGIN_LIMITS = { min: 0, max: 100 } as const;
/** Smallest text area a page may have, in millimetres, so a document always makes progress. */
export const MIN_CONTENT_MM = 50;
export const HEADER_FOOTER_MAX_LENGTH = 200;

/**
 * Reads page settings from the settings map's values, falling back to defaults for anything
 * missing or malformed (a buggy or older client must not break layout for everyone).
 */
export function readPageSettings(get: (key: string) => unknown): PageSettings {
  const d = DEFAULT_PAGE_SETTINGS;
  const pageSize = get(SETTINGS_KEYS.pageSize);
  const orientation = get(SETTINGS_KEYS.orientation);
  const pagination = get(SETTINGS_KEYS.pagination);
  const settings: PageSettings = {
    pageSize: pageSize === "A4" || pageSize === "LETTER" ? pageSize : d.pageSize,
    orientation: orientation === "portrait" || orientation === "landscape" ? orientation : d.orientation,
    margins: readMargins(get(SETTINGS_KEYS.margins)) ?? d.margins,
    header: readHeaderFooter(get(SETTINGS_KEYS.header)) ?? d.header,
    footer: readHeaderFooter(get(SETTINGS_KEYS.footer)) ?? d.footer,
    pagination: typeof pagination === "boolean" ? pagination : d.pagination,
  };
  return fitsPage(settings) ? settings : { ...settings, margins: d.margins };
}

/** Sheet size in millimetres after orientation. */
export function sheetSize(settings: Pick<PageSettings, "pageSize" | "orientation">): { width: number; height: number } {
  const { width, height } = PAGE_SIZES[settings.pageSize];
  return settings.orientation === "landscape" ? { width: height, height: width } : { width, height };
}

/** True when the margins leave at least MIN_CONTENT_MM of text area in both directions. */
export function fitsPage(settings: Pick<PageSettings, "pageSize" | "orientation" | "margins">): boolean {
  const { width, height } = sheetSize(settings);
  const m = settings.margins;
  return width - m.left - m.right >= MIN_CONTENT_MM && height - m.top - m.bottom >= MIN_CONTENT_MM;
}

function readMargins(value: unknown): PageMargins | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const margins = { top: record.top, bottom: record.bottom, left: record.left, right: record.right };
  const valid = Object.values(margins).every(
    (n) => typeof n === "number" && Number.isFinite(n) && n >= MARGIN_LIMITS.min && n <= MARGIN_LIMITS.max,
  );
  return valid ? (margins as PageMargins) : null;
}

function readHeaderFooter(value: unknown): HeaderFooterText | null {
  if (typeof value !== "object" || value === null) return null;
  const { left, right } = value as Record<string, unknown>;
  if (typeof left !== "string" || typeof right !== "string") return null;
  return { left: left.slice(0, HEADER_FOOTER_MAX_LENGTH), right: right.slice(0, HEADER_FOOTER_MAX_LENGTH) };
}
