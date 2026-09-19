import { DEFAULT_FONT, DOCUMENT_FONTS, fontLabel } from "../../editor/font-list";

/**
 * Office font names ↔ Colo's font families. Colo hosts metric-compatible stand-ins for the
 * common Office fonts, so those map to Colo's own families; any other font keeps its name (it
 * shows if the reader has it installed) with a generic fallback of the right kind.
 */

type Generic = "sans-serif" | "serif" | "monospace";

const ALIASES: Record<string, string> = {
  arial: "Arial",
  arimo: "Arial",
  helvetica: "Arial",
  "liberation sans": "Arial",
  calibri: "Calibri",
  carlito: "Calibri",
  cambria: "Cambria",
  caladea: "Cambria",
  "courier new": "Courier New",
  courier: "Courier New",
  cousine: "Courier New",
  "liberation mono": "Courier New",
  "times new roman": "Times New Roman",
  times: "Times New Roman",
  tinos: "Times New Roman",
  "liberation serif": "Times New Roman",
};

/** The CSS font-family Colo stores for an Office font name. */
export function officeFontToCss(name: string, generic: Generic = "sans-serif"): string {
  const label = ALIASES[name.trim().toLowerCase()];
  const known = label ? DOCUMENT_FONTS.find((font) => font.label === label) : undefined;
  if (known) return known.family;
  return `'${name.replace(/['\\]/g, "")}', ${generic}`;
}

/** The Office font name for a stored CSS font-family (the first family in the list). */
export function cssFontToOffice(family: string | undefined): string {
  return fontLabel(family ?? DEFAULT_FONT.family);
}

/** A font table's family class (w:family) as a CSS generic family. */
export function genericFor(fontClass: string | null): Generic {
  if (fontClass === "roman") return "serif";
  if (fontClass === "modern") return "monospace";
  return "sans-serif";
}
