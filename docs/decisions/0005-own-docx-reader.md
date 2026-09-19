# ADR 0005 — Our own DOCX reader instead of mammoth; `docx` for export

**Status:** Accepted
**Date:** 20 September 2026
**Amends:** [ADR 0003](0003-collaborative-document-engine.md) and plan §2.3 / §6.1 ("DOCX: `mammoth` (import), `docx` (export), JSZip (page settings)")

## Context

M7 is DOCX import and export (plan F10). The plan named `mammoth` for import, `docx` for export and JSZip to read page settings. Google Docs, the reference, keeps most of what makes a Word file look right when it opens one: fonts, colours, sizes, highlight, alignment, indents, lists, tables with merged cells, images, headers and footers with page numbers, page setup, and comments with their replies and resolved state.

`mammoth` is semantic by design: it maps styles to clean HTML and deliberately drops direct formatting. It does not keep fonts, colours, sizes, alignment, highlights, page breaks, headers, footers or page setup, and it keeps comments only as flat text. Everything it drops would have to be read separately anyway, and the HTML it produces would then need to be reconciled with that.

The OOXML subset Colo can show is well defined and small: paragraphs and runs with their properties, style inheritance, numbering, tables, drawings, fields, hyperlinks, comments, notes, sections and headers/footers.

## Options considered

1. **mammoth + JSZip, as planned.** A simple import that loses most visual formatting; page setup and headers read separately; comment replies and resolved state lost.
2. **docx-preview (Apache-2.0).** Renders DOCX to styled HTML for display. Its output is layout HTML (absolute sizes, classes, generated CSS), not something the editor schema maps cleanly, and comments are not threads.
3. **Our own reader on fflate and the browser's DOMParser.** About 1,000 lines across small modules; every mapping ours to test.

For export, `docx` (MIT) covers everything Colo has: styles, numbering, tables with merged cells, images, hyperlinks, headers/footers with PAGE/NUMPAGES fields, and comments with `parentId` replies and a `resolved` flag. There was no reason to write our own writer.

## Decision

**Option 3 for import; `docx` for export.** `src/client/convert/`:

- **Reader** (`docx/`):
  - `package.ts` unzips with fflate. The file (≤ 50 MB) and the declared unzipped size (≤ 200 MB, checked per entry before inflating) are both limited, so a zip bomb is refused.
  - `styles.ts` resolves Word's inheritance chain: document defaults, then the paragraph style and its bases, the character style, and the run. Theme fonts included.
  - `numbering.ts`, `comments.ts`, `sections.ts` and `drawings.ts` read their parts.
  - `body.ts` walks the body into Colo's JSON. Lists and quotes come out flat and are grouped by `blocks.ts`.
  - The XML parser is injected: DOMParser in the browser, `@xmldom/xmldom` in workerd tests.
- **Writer:** `docx/write-docx.ts`.
- **Shared look:** `defaults.ts` holds Colo's text look (Arial 11 pt; heading sizes and colours; quote colour).
  - The writer gives Word's styles those values, so an export looks like Colo in Word.
  - The reader leaves out formatting equal to them, so a document round-trips without gaining marks.
- **Other formats:**
  - Markdown export is our own serializer; `@tiptap/markdown` is an early release with documented edge cases.
  - Markdown import goes through `marked` (MIT) and the editor's HTML parser.
  - HTML goes through the editor schema, and plain text is trivial.
- **Loading:** everything is in one chunk loaded on first use, so the editor's bundle does not grow.

Mappings that are conversions rather than one-to-one, each listed in the import report:

- Footnotes and endnotes → superscript numbers and a numbered "Notes" list at the end (Colo has no notes).
- Tracked changes → accepted (insertions kept, deletions dropped).
- Text boxes → their paragraphs; floating images → in line.
- Title and Subtitle → Heading 1 and 2; Heading 5–9 → Heading 4 (Colo offers four levels).
- Fonts Colo hosts (Arial, Calibri, Cambria, Courier New, Times New Roman, plus their metric-compatible aliases) map to Colo's; any other font keeps its name with a generic fallback.
- Word's user name on comments becomes the importing member when the names match; other authors keep their names.

## Consequences

- **Fidelity is ours to maintain.** Unusual Word constructs we have not mapped fall back to their text, and the report says what was left out: equations, charts and SmartArt, embedded objects, EMF/WMF/TIFF images, columns, line spacing, and different first-page or even-page headers.
- **Tests carry the weight.**
  - A fixture built in Word through COM (`scripts/docx-fixtures.ps1`, which never changes Word's user name and reads the result as Flat OPC instead of saving through Word) pins the reader to real Word output.
  - A round-trip test writes a document using every supported feature and reads it back unchanged.
  - `e2e/convert.ts` opens an export in Word (`scripts/check-docx-in-word.ps1`).
- **Bundle:** the converter chunk is ~470 KB (~140 KB gzipped), fetched only when someone imports or downloads.
- **Line spacing and paragraph spacing** are not carried either way: Colo has one line height (1.15) and one paragraph spacing.
- **LibreOffice** is not checked automatically (not installed on the development machine); exports use only standard WordprocessingML that LibreOffice reads.

## Revisit when

- Colo gains features Word files commonly use (line spacing, footnotes, columns): extend the reader and writer, with a fixture for each.
- Someone imports Google Docs exports regularly: add a fixture exported from Google Docs.
- The converter chunk's size matters on slow connections: move conversion into a Web Worker, which also keeps large files from blocking the page.
