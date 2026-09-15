// Self-hosted document fonts (plan §6.1). They are metric-compatible with the Office fonts
// they stand in for, so line breaks and page layout stay close when a DOCX is opened in Word.
import "@fontsource/arimo/400.css";
import "@fontsource/arimo/400-italic.css";
import "@fontsource/arimo/700.css";
import "@fontsource/arimo/700-italic.css";
import "@fontsource/tinos/400.css";
import "@fontsource/tinos/400-italic.css";
import "@fontsource/tinos/700.css";
import "@fontsource/tinos/700-italic.css";
import "@fontsource/cousine/400.css";
import "@fontsource/cousine/400-italic.css";
import "@fontsource/cousine/700.css";
import "@fontsource/cousine/700-italic.css";
import "@fontsource/carlito/400.css";
import "@fontsource/carlito/400-italic.css";
import "@fontsource/carlito/700.css";
import "@fontsource/carlito/700-italic.css";
import "@fontsource/caladea/400.css";
import "@fontsource/caladea/400-italic.css";
import "@fontsource/caladea/700.css";
import "@fontsource/caladea/700-italic.css";

export interface DocumentFont {
  /** Name shown in the toolbar, and the font name used when exporting DOCX. */
  label: string;
  /** CSS font-family stored in the document. */
  family: string;
}

export const DOCUMENT_FONTS: DocumentFont[] = [
  { label: "Arial", family: "Arimo, Arial, sans-serif" },
  { label: "Calibri", family: "Carlito, Calibri, sans-serif" },
  { label: "Cambria", family: "Caladea, Cambria, serif" },
  { label: "Courier New", family: "Cousine, 'Courier New', monospace" },
  { label: "Times New Roman", family: "Tinos, 'Times New Roman', serif" },
];

export const DEFAULT_FONT = DOCUMENT_FONTS[0];

/** Font sizes offered in the toolbar, in points (as in Google Docs). */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
export const DEFAULT_FONT_SIZE = 11;

export function fontLabel(family: string | undefined): string {
  if (!family) return DEFAULT_FONT.label;
  return DOCUMENT_FONTS.find((font) => font.family === family)?.label ?? family.split(",")[0].replace(/['"]/g, "");
}

/** Parses a stored font size ("14pt") into points. */
export function parsePoints(size: string | undefined): number {
  const match = size ? /^([\d.]+)pt$/.exec(size) : null;
  return match ? Number(match[1]) : DEFAULT_FONT_SIZE;
}
