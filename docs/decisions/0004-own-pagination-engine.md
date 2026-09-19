# ADR 0004 — Our own pagination engine instead of tiptap-pagination-plus and tiptap-table-plus

**Status:** Accepted
**Date:** 19 September 2026
**Amends:** [ADR 0003](0003-collaborative-document-engine.md), decision 1 ("Real pages")

## Context

ADR 0003 chose `tiptap-pagination-plus` and `tiptap-table-plus` (both MIT, single maintainer) for real pages, with the note that we would fork or vendor them if they stalled or needed fixes. Both were still at 3.1.0 when M4 started — the version the spike used. Reading their source before building on them showed:

- **table-plus changes the table schema.** Tables may contain a new `tableRowGroup` node and get a `columnSize` attribute. Its row-grouping plugin replaces the **whole table** in an `appendTransaction` whenever merged rows change the grouping. That runs in both browsers, including for changes that arrived from the other person, so two people can each insert a replacement table and Yjs keeps both — a duplicated table.
- **table-plus drops `tableEditing()`.** Its table extension overrides Tiptap's plugins, so cell selection, and with it Colo's merge and split cells, stops working.
- **pagination-plus renders header and footer text with `innerHTML`**, injects a `<style>` element at runtime, has no `{total}` and replaces only the first `{page}`.
- **pagination-plus's page count is measured, not computed.** It measures header and footer heights and compares element positions every transaction; its shrink rule removes one page too many in some cases and relies on later passes to correct, which is the kind of loop the spike saw as a runaway.

The layout technique itself is sound and small: full-width floats as margin bands, which text lines cannot sit beside, and table rows as separate block formatting contexts so a band can fall between them.

## Options considered

1. **Use the packages as they are.** Fastest, but ships the table duplication, broken merge/split, and the missing `{total}`.
2. **Vendor and patch both (~1,000 lines).** Keeps their structure, including the schema change and the per-transaction measuring we would have to make collaboration-safe.
3. **Write our own engine with the same float technique (~350 lines).** No schema change; geometry computed from the page settings.

## Decision

**Option 3.** `src/client/editor/pages/`:

- **Geometry is computed, not measured.** The header sits in the top margin and the footer in the bottom margin (vertically centred, one line, like Google Docs' default 0.5-inch header offset), so page *k*'s text area starts at `marginTop + (k − 1) · (pageHeight + gap)` for exactly `pageHeight − marginTop − marginBottom`. The only measurement is where the content ends, once per animation frame after a change.
- **Decorations only.** One widget at position 0 holds the bands; page count, `{page}` and `{total}` are drawn as text nodes. Nothing is written to the Yjs document except page settings and the `pageBreak` node.
- **Tables keep Tiptap's schema** and its `colwidth` column resizing. A `TableView` subclass turns column widths into a CSS grid track list, and on paged screens each row is its own grid. Tables with vertically merged cells cannot split between rows; they keep table layout, move to the next page as a whole, and are capped at one page's text height (scrolling inside, cut off in print).
- **Page breaks** are a block node sized by the engine to the end of their page.
- **Printing** uses `@page` with the sheet size and zero margins, hides the gaps and sets widows/orphans to 1 (the browser's default of 2 moved single lines to the next sheet and shifted every later page). Measuring is suspended while print media applies.

## Consequences

**Positive**

- No schema change: M3 documents, including their tables and column widths, load unchanged. Merge and split cells keep working.
- No `appendTransaction` rewrites, so nothing can be applied twice by two browsers.
- Header and footer text cannot inject markup.
- Measured on a 52-page document with tables: about 5 ms median and 9 ms at the 95th percentile for a keystroke plus layout near the top of the document; printing produces one sheet per drawn page (`npm run e2e:pages`).
- Two fewer single-maintainer dependencies.

**Negative**

- The engine is ours to maintain.
- A table row is never split mid-row: a row taller than a page scrolls inside itself. Tables with vertically merged cells do not split at all, and one taller than a page is cut off in print.
- Headers and footers are one line of plain text per side, with the same text on every page (no different first page, no odd/even pages).
- Layout follows the browser, not Word: a DOCX opened elsewhere will not break pages identically (already accepted in plan §1.3).

## Revisit when

- People need mid-row table splits, multi-line or rich headers, or different first-page headers.
- A maintained open-source pagination library appears that works with Yjs without rewriting the document.
- M7 (DOCX) needs page geometry the engine cannot express.
