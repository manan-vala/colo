# Colo

A private document editor for two people, in the style of Google Docs: simultaneous typing with live cursors, rich formatting, real pages with headers and footers, comments, and DOCX import/export.

Runs entirely on the **Cloudflare Workers Free plan** at $0/month, using only open-source libraries:

- **Workers Static Assets** serve the React SPA (Tiptap editor, shadcn/ui).
- A thin **Worker** routes `/api/*` and authorises document connections.
- A **Workspace Durable Object** holds members, passkeys, sessions and the document index.
- One **Document Durable Object** per document syncs edits with **Yjs** over hibernating **WebSockets** and stores the document in its embedded **SQLite** database.
- Sign-in is invite-only with **passkeys**.

## Docs

- [docs/colo-plan.md](docs/colo-plan.md) — architecture, data model, API, deployment, cost model and build plan
- [ADR 0001 — Move from AWS to Cloudflare](docs/decisions/0001-move-from-aws-to-cloudflare.md)
- [ADR 0002 — Passkey sign-in on workers.dev](docs/decisions/0002-passkey-auth-on-workers-dev.md)
- [ADR 0003 — Collaborative document engine: Tiptap + Yjs on per-document Durable Objects](docs/decisions/0003-collaborative-document-engine.md)
- [ADR 0004 — Our own pagination engine instead of tiptap-pagination-plus](docs/decisions/0004-own-pagination-engine.md)
- [ADR 0005 — Our own DOCX reader instead of mammoth; docx for export](docs/decisions/0005-own-docx-reader.md)

## Development

Requires Node.js 22+ (`.nvmrc` pins 24).

```bash
npm ci
npm run dev          # Vite + Worker + Durable Object in workerd: http://localhost:5173
npm test             # Vitest inside workerd
npm run typecheck    # tsc -b across every project
npm run ci           # what Workers Builds runs: typecheck, tests, build
npm run build        # type-check, then build client and Worker into dist/
npm run preview      # serve the production build locally (applies public/_headers)
npm run deploy       # build, then wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run invite -- --email <email> --name "<name>" [--local]   # one-time invite link
npm run restore -- --file <backup.ndjson> [--overwrite]       # restore a backup into the local instance
```

Browser smoke tests drive the local Chrome with virtual passkeys (start `npm run dev` or `npx vite preview --port 5173` first):

```bash
npm run e2e:auth     # invite → passkey → sign out → sign in
npm run e2e:collab   # two people co-edit a document
npm run e2e:formatting   # every toolbar and menu action reaches the other browser (M3)
npm run e2e:pages    # 50-page document, headers/footers, page breaks, print (M4); PDF_PATH=… saves the PDF
npm run e2e:comments # two people comment, reply, resolve; detached threads; phone panel (M5)
npm run e2e:comments-perf   # typing with many threads (run against the production build)
npm run e2e:images   # upload, paste, resize, align; large images compressed; pages and print (M6)
npm run e2e:restore  # named version, restore for both people with comments, restore the restore (M6)
npm run e2e:convert  # import a Word file, download every format, open the Word export in Word (M7)
npm run e2e:backup   # export, wreck a document, restore it with the script, image intact (M8)
COLO_URL=https://… npm run e2e:gate   # M2 gate on a deployed Worker (hibernation, deploy mid-typing)
```

Local secrets live in `.dev.vars` (git-ignored): `RP_ID="localhost"`, `ORIGIN="http://localhost:5173"`, `ADMIN_TOKEN="…"`.

To add a package, use `npx npm@latest install <pkg>`: npm 11.5 crashes resolving Vite 8's optional peer dependencies. `npm ci` is unaffected.

UI components come from [shadcn/ui](https://ui.shadcn.com): `npx shadcn@latest add <component>`.

## Repository layout

See §7 of the plan.

```
colo/
  wrangler.jsonc          # Worker, Durable Object, assets config
  vite.config.ts          # Vite + React + Tailwind + @cloudflare/vite-plugin
  vitest.config.ts        # @cloudflare/vitest-plugin
  components.json         # shadcn/ui config
  public/_headers         # security and cache headers for static assets
  src/
    client/               # React SPA (components/ui = shadcn/ui; editor/pages = pagination; editor/images; comments; convert = import/export)
    worker/               # Worker router + Workspace and Document Durable Objects
    shared/               # types shared by client and Worker
  scripts/                # admin scripts (M1); Word COM scripts for DOCX fixtures and checks (M7)
  e2e/                    # two-browser tests (puppeteer + Chrome virtual passkeys)
  test/                   # Vitest inside workerd
  docs/
```

## Status

Colo runs at <https://colo.manan-vala.workers.dev>. **M1 (passkey sign-in), M2 (collaborative documents), M3 (Google Docs-style editor UI), M4 (real pages), M5 (comments) and M6 (images and restore points) are built and deployed** — menus, toolbar, fonts, colours, links, lists, tables, outline, zoom, plus branding (logo, favicon, home-screen banner).

M4 added A4/Letter pages in portrait or landscape, margins, one-line headers and footers with `{page}` and `{total}` ("Page X of Y"), page breaks (Ctrl/⌘+Enter), tables that split between rows, File → Page setup, Insert → Page numbers, and printing one sheet per page. Narrow screens and pageless documents stay continuous.

**M5 (comments):** select text and add a comment (toolbar, Insert → Comment or Ctrl/⌘+Alt+M); cards sit in the margin beside their text, with replies, editing, resolve and reopen; the Comments button lists open, text-deleted and resolved threads. On phones comments open in a panel.

**M6 (images and restore points):** add images from Insert → Image, the toolbar, paste or drag and drop; they are compressed in the browser (at most 2048 px and 1 MB) and stored with the document; drag a corner to resize, use the alignment buttons to place them. File → Restore points lists automatic versions (kept before each stretch of editing) and named ones; restoring changes the document for both people, comments included, and keeps the version it replaced.

**M7 (import and export):** Import file on the list page or File → Open file brings in Word (.docx), Markdown, web page or text files as new documents (File → Replace with file swaps a document's content, keeping the old version as a restore point). Word files keep their fonts, colours, sizes, alignment, lists, tables with merged cells, images, links, page setup, header and footer page numbers, and comments with replies; an import report lists anything converted or left out. File → Download saves Word, PDF, web page, Markdown or plain text.

**M8 (hardening):** the account menu on the document list has **Download backup**, which saves every member, every document — soft-deleted ones included — and every image as one NDJSON file; `npm run restore -- --file <backup>` puts it back into a local instance, keeping document ids so images still resolve. Passkeys are never backed up (they are bound to a device), so a restored instance needs a fresh invite — see [§8.5 of the plan](docs/colo-plan.md) for the runbook. M8 also brought a phone pass (the offline indicator was invisible on phones; the table picker gave no touch feedback; resize handles were too small to hit), a security review, and `npm run ci` as the gate CI runs. **Still to do:** connect Workers Builds, deploy, and check a real phone.
