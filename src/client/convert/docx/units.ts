/** Units used by WordprocessingML, converted to Colo's (px at 96 dpi, mm, pt). */

/** Twentieths of a point: page sizes, margins, indents, table widths. */
export const TWIPS_PER_INCH = 1440;
/** English Metric Units: drawing sizes. */
export const EMU_PER_PX = 9525;
const MM_PER_INCH = 25.4;

export const twipsToMm = (twips: number) => (twips / TWIPS_PER_INCH) * MM_PER_INCH;
export const mmToTwips = (mm: number) => Math.round((mm / MM_PER_INCH) * TWIPS_PER_INCH);
export const twipsToPx = (twips: number) => twips / 15;
export const pxToTwips = (px: number) => Math.round(px * 15);
export const emuToPx = (emu: number) => emu / EMU_PER_PX;

/** Colo's indent step (index.css: 0.5 in per level). */
export const INDENT_STEP_TWIPS = 720;

/** Rounds to one decimal, as the page setup dialog does. */
export const round1 = (n: number) => Math.round(n * 10) / 10;
