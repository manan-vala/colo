import { DEFAULT_FONT, DEFAULT_FONT_SIZE } from "../editor/font-list";

/**
 * How Colo shows text when no formatting is applied (index.css). The DOCX writer gives its styles
 * these values, and the reader leaves out formatting equal to them, so a document keeps its
 * look in Word and round-trips without gaining formatting marks.
 */

export interface TextLook {
  /** Office font name. */
  font: string;
  /** Points. */
  size: number;
  /** #rrggbb */
  color: string;
}

export const BODY_TEXT: TextLook = { font: DEFAULT_FONT.label, size: DEFAULT_FONT_SIZE, color: "#000000" };

/** Headings 1–4 (index.css: .colo-editor h1…h4; weight 400, so not bold). */
export const HEADING_TEXT: Record<1 | 2 | 3 | 4, TextLook> = {
  1: { ...BODY_TEXT, size: 20 },
  2: { ...BODY_TEXT, size: 16 },
  3: { ...BODY_TEXT, size: 14, color: "#434343" },
  4: { ...BODY_TEXT, size: 12, color: "#666666" },
};

/** Quotes (index.css: .colo-editor blockquote). */
export const QUOTE_TEXT: TextLook = { ...BODY_TEXT, color: "#5f6368" };

export function textLook(heading: number | null, quote = false): TextLook {
  if (heading && heading >= 1 && heading <= 4) return HEADING_TEXT[heading as 1 | 2 | 3 | 4];
  return quote ? QUOTE_TEXT : BODY_TEXT;
}

/** Line spacing (index.css: line-height 1.15) and space after a paragraph (0.5em of 11 pt). */
export const LINE_SPACING = 1.15;
export const PARAGRAPH_AFTER_PT = 5.5;
