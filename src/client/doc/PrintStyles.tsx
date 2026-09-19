import { sheetSize, type PageSettings } from "../../shared/doc-schema";

/**
 * The `@page` rule for printing (and "Save as PDF") this document. Paged documents print the
 * on-screen pages one-to-one: the sheet has no margins because each drawn page already contains
 * its margins, header and footer. Continuous documents let the browser break pages, using the
 * document's margins.
 */
export function PrintStyles({ settings, paged }: { settings: PageSettings; paged: boolean }) {
  const { width, height } = sheetSize(settings);
  const m = settings.margins;
  const margin = paged ? "0" : `${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm`;
  return <style>{`@page { size: ${width}mm ${height}mm; margin: ${margin}; }`}</style>;
}
