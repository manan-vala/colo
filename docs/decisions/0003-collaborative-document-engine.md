# ADR 0003 — Collaborative document engine: Tiptap + Yjs on per-document Durable Objects

**Status:** Accepted; the "Real pages" part of decision 1 is amended by [ADR 0004](0004-own-pagination-engine.md)
**Date:** 15 September 2026
**Supersedes:** the Tier A notes design (textarea + Markdown, `version`-column conflicts) in `docs/colo-plan.md` v3.1
**Related:** [ADR 0001](0001-move-from-aws-to-cloudflare.md), [ADR 0002](0002-passkey-auth-on-workers-dev.md)

## Context

The owner changed Colo's goal from shared Markdown notes to a **document editor in the style of Google Docs**: simultaneous typing with live cursors, a rich formatting toolbar and a similar UI, comments, real pages (A4 breaks, headers, footers) where feasible, and DOCX import/export. Suggesting mode (track changes) is wanted but not a priority.

Constraints, set by the owner on 15 September 2026:

- **No paid third-party services or paid add-ons.** Build features ourselves or use open-source software of any size.
- **Stay on the Cloudflare Workers Free plan** (no payment method) and design for its limits rather than upgrading.

## Research

### Editors

npm license, version and last-publish date checked on 15 September 2026; claims verified against documentation or package source where marked.

| Option | License | Real-time collaboration | Comments | Real pages | DOCX | Verdict |
|---|---|---|---|---|---|---|
| **Tiptap 3** (ProseMirror) | MIT (core, `extension-collaboration`, `extension-collaboration-caret`, tables, and the formerly paid drag handle, unique ID, table of contents, details, math) | Free, any Yjs provider | Paid (Tiptap Comments); **build our own** | Paid (Tiptap Pages); **open-source `tiptap-pagination-plus` (MIT) works — see spike** | Paid converters; **open-source `mammoth` / `docx` instead** | **Chosen** |
| **CKEditor 5** | GPL-2.0+ or commercial | Premium only (commercial licence and CKEditor Cloud Services or on-premises) | Premium only | Premium only | Premium only | Rejected: every feature we need is paid |
| **Plate** (Slate) | MIT; UI built on shadcn/ui | `@platejs/yjs` (slate-yjs) with custom providers | Free `@platejs/comment` marks; richer discussion UI is Plate Plus (paid) | None; open community discussion only | Free `@platejs/docx-io` (import via mammoth, export with page size, margins, comments) | Strong runner-up; no pagination, and Slate's Yjs binding and mobile input are less proven than ProseMirror's |
| **BlockNote** (ProseMirror/Tiptap) | Core MPL-2.0; `xl-*` packages (DOCX/PDF export, multi-column, AI) GPL-3.0 or commercial | Built in (Yjs) | Free, `YjsThreadStore` | None | Export only, GPL-3.0 | Rejected: Notion-style blocks rather than a paged document; copyleft exporters |
| **Novel** | Apache-2.0 (Tiptap wrapper) | Not built in | No | No | No | Rejected: last npm publish January 2025; Notion-style |
| **Lexical** | MIT | `@lexical/yjs` | Playground example only | None | None | Rejected: least of the required features out of the box |
| **SuperDoc** | AGPL-3.0 or commercial | Yjs (y-websocket, Hocuspocus or Liveblocks providers) | Built in | **True Word-style layout**, headers/footers, footnotes | Native DOCX round-trip | Kept as fallback only — see spike |
| eigenpal `docx-js-editor` | Apache-2.0 core, Pro licence for premium | Premium | Yes | Word-faithful | Native | Rejected: collaboration and tracked changes are paid |

### Yjs server on Durable Objects

| Option | License | Hibernating WebSockets | Persistence | Verdict |
|---|---|---|---|---|
| **`y-partyserver`** 2.2.0 (Cloudflare) | ISC | Yes — `partyserver`'s `static options = { hibernate: true }`; awareness client IDs stored in socket attachments (verified in source) | `onLoad` / `onSave` hooks; save debounced (`debounceWait` 2 s, `debounceMaxWait` 10 s by default) | **Chosen** |
| `y-durableobjects` 1.0.5 | MIT | Yes (`acceptWebSocket`) | Stores **every update** through the KV API and compacts at 500 updates or 10 KB (verified in source) | Rejected: one row written per keystroke breaks the 100,000 rows/day budget |
| `@hocuspocus/server` | MIT | n/a (Node.js server) | — | Rejected: does not run on Workers |

## Spikes (15 September 2026, local, throwaway code outside the repo)

**Spike 1 — `y-partyserver` in workerd** (Wrangler 4.131.2, `hibernate: true`, whole-document state saved as one SQLite row):

- Two Node clients synced text in real time.
- 46 single-character transactions produced **46 WebSocket messages** — one per keystroke.
- A debounced save wrote **1 row** (`rowsWritten=1`) regardless of how many edits preceded it.
- After a server restart, a fresh client received the document from SQLite.
- **Crash before save:** the server was killed after an edit but before its save; on restart the server had lost the edit, the still-open client reconnected and re-sent it, the server then saved it, and it survived a further restart.
- Not verifiable locally: eviction from hibernation under real traffic. Verify on the deployed Worker in M2.
- Packaging: `y-partyserver` 2.2.0 (last published April 2026) declares a peer of `@cloudflare/workers-types@^4` while Wrangler 4.131 wants v5. Types only; resolve with an npm `overrides` entry.

**Spike 2 — Tiptap 3.31 + Collaboration + `tiptap-pagination-plus` 3.1.0** (two editors linked through in-memory Yjs documents, Chrome headless via puppeteer-core):

- A4 pages with page gaps, per-page header and footer, and `{page}` numbers rendered correctly; both editors' documents stayed identical after remote edits.
- Pagination is **decoration-only** (widgets and CSS; verified in source) — it never changes document content, which is what makes it safe with Yjs.
- Layout cost while typing: about **3 ms per keystroke** at 3 pages and **5 ms** at 10 pages (text only).
- **Tables:** the stock Tiptap table extension sent pagination into a runaway (234 page-break widgets, page unresponsive). The same author's `tiptap-table-plus` (MIT) fixed it: 6 pages, rows split across pages, about 7.6 ms per keystroke.
- `{total}` in headers/footers is not implemented in 3.1.0; only `{page}` is.
- **CSP:** Tiptap's default `injectCSS` and pagination-plus both insert `<style>` elements, blocked by `style-src 'self'`. Tiptap's can be disabled (`injectCSS: false` plus a stylesheet); pagination-plus's cannot without patching.
- Remote caret rendering uses `element.style` (allowed by CSP) but was not visually verified headless because the editors had no focus.
- Bundle: React + Tiptap + Yjs + pagination ≈ 796 kB (248 kB gzip).

**Spike 3 — SuperDoc 2.14.0:**

- Rendered a real Word page (with footnotes) from a DOCX file once `style-src 'unsafe-inline'` was allowed.
- Build output ≈ 21 MB: a 9.5 MB DOCX engine (2.7 MB gzip) plus two web workers of 4.9 MB and 5.7 MB.
- Required installing `@hocuspocus/provider` even without collaboration.
- **Sends document-open telemetry to `ingest.superdoc.dev` by default** (blocked by Colo's CSP; can be disabled).
- AGPL-3.0; its own Vue-based UI.

## Decision

1. **Editor:** Tiptap 3 (MIT) with its free extensions, a Google Docs–style shell built from shadcn/ui, and:
   - **Real pages:** `tiptap-pagination-plus` + `tiptap-table-plus` (MIT). Both are small single-maintainer packages, so we will fork or vendor them (≈1,000 lines) if they stall or need fixes such as `{total}` and CSP-friendly styles.
   - **Comments:** built by us — a `comment` mark carrying a thread ID, with threads stored in a `Y.Map` inside the same Yjs document.
   - **DOCX:** built by us on `mammoth` (BSD-2-Clause) for import and `docx` (MIT) for export, entirely in the browser.
   - **Suggesting mode:** deferred; evaluate `@handlewithcare/prosemirror-suggest-changes` (MIT) later.
2. **Collaboration server:** one **Document Durable Object per document**, built on `y-partyserver` with hibernation, saving the whole Yjs state (chunked at 2 MB) on a debounce. The **Workspace Durable Object** keeps members, passkeys, sessions, invites and the document index. The Worker authenticates each document connection against Workspace before forwarding it.
3. **Budget:** stay on the Free plan with the safeguards in plan §9.3.
4. **Fallback:** if real-world use shows pagination-plus cannot deliver acceptable pages, re-evaluate SuperDoc for document layout, accepting AGPL-3.0, its bundle size and disabling its telemetry.

## Consequences

**Positive**

- Simultaneous typing, live cursors and presence with no conflict banner — Yjs merges edits.
- Every dependency is open source and self-hosted; nothing phones home.
- One row written per save instead of per keystroke keeps well inside 100,000 rows/day; hibernating sockets keep duration near zero while idle.
- Tiptap is headless, so the UI is fully ours (shadcn/ui), and it has the most widely used Yjs binding.
- If the server loses unsaved edits, reconnecting clients restore them (spike 1).

**Negative**

- Much more work than the Tier A notes app: roughly 17–24 working days for M1–M8 instead of about 5.
- Comments, DOCX conversion, `{total}` page numbers, restore points and the document UI are ours to build and maintain.
- Pagination is a visual layout, not a Word layout engine: DOCX round-trips will not be pixel-identical, and large documents cost a few milliseconds of layout per keystroke.
- `style-src` must allow `'unsafe-inline'` (pagination-plus and Radix inject styles); `script-src` stays strict.
- Two small single-maintainer dependencies for pagination.
- Document data lives in many Durable Objects, so backup and export must fan out across them.
- Server cannot cheaply validate document structure; a buggy client could damage a document, mitigated by restore points.

## Revisit when

- M2's deployed hibernation test shows higher duration or row counts than §9.2 predicts.
- M4's pagination milestone cannot meet its acceptance checks (§11).
- Suggesting mode becomes a priority.
- A Free-plan limit is approached in the dashboard metrics.
