# Colo — orientation for coding agents

Colo is a private, browser-based document editor for **small groups in separate workspaces** (it began as a two-person app), styled like Google Docs: simultaneous typing with live cursors, rich formatting, real pages, comments, and DOCX import/export. It runs entirely on the **Cloudflare Workers Free plan** with no payment method on the account — **$0/month by construction**, every dependency is open source and self-hosted, nothing calls a third-party service.

**Read [docs/colo-plan.md](docs/colo-plan.md) before making non-trivial changes.** It is the living source of truth: architecture, data model, API, security posture, cost model, and the milestone-by-milestone build plan with a revision history explaining *why* each choice was made. This file is a fast-loading summary, not a replacement for it. The ADRs in `docs/decisions/` explain the platform (AWS→Cloudflare), auth (passkeys on workers.dev, 0002, amended by 0006), editor engine (Tiptap+Yjs), pagination engine (our own, 0004), DOCX reader (0005) and workspaces with password sign-in (0006) decisions in depth.

## Current status (23 Sep 2026)

M0–M7 are **built and deployed** to `colo.manan-vala.workers.dev`:
- Invite-only passkey auth (no passwords) — replaced by workspaces and password sign-in in M9, below
- Collaborative documents: per-document Durable Object, Yjs CRDT sync, hibernating WebSockets, live cursors
- Docs-style editor shell: File/Edit/View/Insert/Format menus, full formatting toolbar, fonts, colors, links, lists, tables, outline panel, zoom
- Branding: black logo mark (auth screens, document-list header), white favicon variant, home-screen banner image
- Real pages (M4): page settings in the Yjs `settings` map, our own decoration-only paginator in `src/client/editor/pages/` (ADR 0004 — `tiptap-pagination-plus`/`tiptap-table-plus` are *not* used), page breaks, Page setup dialog, print CSS. Page geometry is computed from settings (`layout.ts`); only content height is measured

**M5 — comments.** `src/client/comments/`: threads in the Yjs `comments` map (`model.ts`), a `comment` mark as the anchor (`comment-mark.ts`), highlights from a generated stylesheet (`highlight.ts`), margin cards placed from the page's own layout (`CommentRail.tsx`, `rail-layout.ts`), a panel for all threads and for narrow screens. `useComments` returns `{ state, actions }`; `state` must not change on ordinary typing and `actions` is stable — keep it that way, or every card re-renders per keystroke.

**M6 — images and restore points.**
- Images: `src/client/editor/images/` (extension, our own resizable node view, browser-side compression, upload with a tracked insertion point) and `src/worker/images.ts` (one SQLite row per image).
- Restore points: `src/worker/restore-points.ts` (storage, automatic points, `replaceState`) and `src/client/doc/RestorePointsDialog.tsx`.
- Image and restore-point routes are authorised by Workspace (`authorizeRequest`) and served by the Document object (`onMemberRequest`).
- A new top-level Yjs type must be added to `ROOT_TYPES` in `doc-schema.ts`, or restores will not rewind it.
- IDs from `ulid()` (`src/worker/http.ts`) are monotonic within an isolate; restore points rely on ID order for "newest first".

**M7 — import and export.** `src/client/convert/` (ADR 0005), loaded with dynamic `import()` only:
- `docx/`: our own reader (fflate + an injected XML parser; styles, numbering, comments, sections, drawings, body) and a writer on the `docx` library.
- `markdown.ts`, `html.ts`, `text.ts`, and `index.ts` (entry points).
- `apply.ts`: uploads images and applies an import to a document.
- `defaults.ts`: Colo's text look. The writer uses it for Word styles and the reader omits formatting equal to it; keep it in step with `index.css`.
- UI: `doc/useFileTransfers.tsx`, `doc/imports.ts`, `doc/ImportReportDialog.tsx`, and the Home "Import file" button.

**M8 — hardening, built.** Backups (§8.5 of the plan): `src/worker/backup.ts` holds the NDJSON format and both directions, `GET /api/export` streams it from Workspace with each Document object adding its own records, and `POST /api/admin/restore` reads it back — behind `requireAdmin`, so it 404s in production where `ADMIN_TOKEN` is deleted. `scripts/restore.ts` drives it; `src/client/backup.ts` plus the account menu in `Home.tsx` is the download.
- **Document ids are preserved on restore, never reminted** — an image's `src` embeds its document id, so reminting would break every image.
- **Passkeys and sessions are never exported.** If you add a record type, the allow-list in `test/backup.test.ts` is what stops credential material leaking into a downloaded file.
- **Committing a restore resets the document's metadata flags.** `replaceState` looks like an edit to the observer in `onLoad`, and a restored title pushes immediately, so without the reset every restored document gets stamped as edited just now.

Also in M8: the phone pass (`npm run e2e:mobile`), `npm run ci` as the CI gate (typecheck → tests → build, in that order because `npm test` does not typecheck), `LICENSE` and `SECURITY.md`.

**Review pass (20 Sep 2026, plan v4.15)** — four rules it left behind:
- **A title reaching Workspace from a Document object is cut, not refused** (`clampTitle`). `updateMeta` runs behind a save with nobody to show a 400 to; throwing there stranded the document's index row and left an alarm retrying every minute.
- **Nothing on the load or save path may throw on a bad stored state.** partyserver starts an object from `fetch`, so a throw in `onLoad` fails *every* request to it — including the routes that would repair it. A state that will not apply sets `unreadable`: read-only, `DOCUMENT_UNREADABLE` to the client, and `onSave` returns without writing.
- **A record yielded by the backup generators suspends the object**, which is free to save in between. `documentBackup` takes a save counter and fails the export of a multi-chunk document that was saved underneath it.
- **e2e suites are the only cover the client's stateful parts have**, and nothing runs them in CI — so a UI change must be walked through the suite that touches it (`Sign out` moving into the account menu broke `e2e:auth` for a whole milestone without anyone noticing).

**M9 — workspaces, built, not deployed** (plan v5, ADR 0006). Invite links are gone.
- `src/worker/admin.ts`: the `Admin` object (`"admin"`) — workspace registry (slug → object name, `max_members`, disabled), the owner's passkeys and 12-hour sessions, `/api/admin/*`. `src/client/admin/` is the dashboard at `/admin`, lazily loaded; `npm run admin:enroll` makes the owner's one-time passkey link.
- One Workspace object per workspace: the pre-M9 one is `"default"` (slug `main`), new ones `ws-<ULID>`. **The session cookie is `<object>.<token>`** and the Worker routes by it; only `/api/auth/login` asks `Admin` to resolve a slug.
- Members sign in with workspace ID + email + password (`src/worker/passwords.ts`: PBKDF2-SHA256, 100k iterations — the runtime max — hashed in the Workspace object, never the Worker). Every failure is `LOGIN_FAILED`; five in a row lock 15 minutes. Passwords are shown to the owner once and never stored readably or exported.
- **Isolation is the Workspace's own document index** — `Documents.get` 404s a document another workspace made; don't add a document route that skips `authorizeDocument`/`authorizeRequest`. Each Document object records its workspace in `doc_workspace` from the `x-colo-workspace` header on internal calls; a restore can't claim a document that has content elsewhere (`restore-claim`, before the index row is written).
- Workspace methods the Admin object calls return `RpcResult` and `unwrap` rethrows: RPC keeps an error's message but not its class, so a thrown `HttpError` would arrive as a 500.
- Test helpers: `enroll()` adds a member straight through the Workspace RPC (no cap) and signs in; `ownerSession()` enrolls a soft-passkey owner. e2e helpers `ownerSession`/`addMember`/`signIn` make a fresh `e2e-<stamp>` workspace per run.

**Not done** — Workers Builds is not connected (dashboard-side, see §8.4), M8 is not deployed, no metrics reading has been taken, and nobody has opened Colo on a real phone.

## Stack

React 19 + TypeScript, Vite 8 + `@cloudflare/vite-plugin` (runs the Worker and Durable Objects in workerd during dev), Tailwind v4 + shadcn/ui (Radix), Tiptap 3 + Yjs + `y-partyserver` for collaborative editing, `@simplewebauthn` for passkeys. One Admin Durable Object holds the workspace registry and the owner's passkey; one Workspace Durable Object per workspace holds its members/passwords/sessions/document index; one Document Durable Object per document holds Yjs state in its own SQLite.

## Commands

```bash
npm run dev          # Vite + Worker + Durable Objects in workerd: http://localhost:5173
npm test             # Vitest inside workerd (real Durable Objects/SQLite)
npm run build        # tsc -b, then vite build
npm run deploy       # build, then wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run admin:enroll [-- --local]   # one-time link for the owner's dashboard passkey (needs ADMIN_TOKEN)
npm run e2e:auth | e2e:collab | e2e:formatting | e2e:pages | e2e:comments | e2e:images | e2e:restore | e2e:convert | e2e:backup   # puppeteer + Chrome virtual passkeys, two-browser tests (need a server on :5173)
npm run e2e:comments-perf   # typing with many comment threads; run against `npm run build && npx vite preview --port 5173`
COLO_URL=https://… npm run e2e:gate              # deployed-Worker gate (hibernation, reconnect through a redeploy)
```

## Conventions and known quirks

- **`npm install` is broken on this project** — npm 11.5 crashes resolving Vite 8's optional peer deps. Add packages with `npx npm@latest install <pkg>`; plain `npm ci` is fine.
- **UI components** come from shadcn/ui: `npx shadcn@latest add <component>`, not hand-rolled.
- **Commit style**: `type(Mn): summary` for milestone work (e.g. `feat(M3): …`, `fix(M2): …`), plain `type: summary` otherwise (e.g. this session's `feat: add brand logo/favicon…`). Plan-doc updates are their own `docs:` commits.
- **No paid third-party services, ever** — stay on Cloudflare's Free plan; if a feature would need one (R2, a paid font CDN, a hosted DOCX/PDF converter), do it client-side or with a self-hosted open-source library instead, and record the trade-off in an ADR if it's a real architectural fork.
- **No Claude attribution in commits** — no `Co-Authored-By` or other Claude/Anthropic trailers, even if a tool suggests one. History was rewritten on 19 Sep 2026 to remove the old ones (backup tag `pre-rewrite`).
- **Cost discipline is a hard constraint, not a preference.** Every design choice in the plan (whole-state debounced saves instead of per-keystroke rows, hibernating sockets, hidden-tab disconnect, per-connection rate/size caps) exists to stay inside the Workers Free daily limits — see §9 of the plan before changing anything touching Durable Object messages, storage rows, or duration.
- **Workspaces are the only boundary.** Every member of a workspace can read/write all of its documents (D7 in the plan); don't add per-document roles the plan explicitly deferred — but never let anything cross a workspace.
- **Pagination is decoration-only.** Never write page-derived data into the Yjs document; pages are computed per browser. Blocks that establish a formatting context (table rows, `hr`, flex list items) need an explicit full width on paged screens, or the browser squeezes them into the zero-width gap beside a margin band (see `index.css`).
- **e2e helpers live in `e2e/browser.ts`** (`enroll`, `press`, `openMenubar`, `chooseMenuItem`, `editorText`, `selectText`, `EditorElement`); don't copy them into scripts. The suites run in seconds against the production build (`npm run build && npx vite preview --port 5173`) and several times slower against `npm run dev`. A file given to Chrome's file chooser is read lazily, so delete test fixtures only after the upload.
- **Converter tests** live in `test/convert/` with their own tsconfig (DOM types; the Workers types' `Element` is HTMLRewriter's). workerd has no DOMParser, so they pass `@xmldom/xmldom` in; Word fixtures load with `?inline`. Rebuild the Word fixture with `scripts/docx-fixtures.ps1`. It must never change Word's user name (the machine owner's identity) and reads the document as Flat OPC, because automated `SaveAs` can hang on this machine. Always quit Word with `Quit([ref]0)`.
- When a milestone lands, the established pattern is: bump `docs/colo-plan.md`'s revision-history table (§0) and milestone table (§11) in the same or a following `docs:` commit, and update `README.md`'s Status paragraph.

## Repo layout

```
src/client/   React SPA — admin/ (owner's dashboard, lazy), home/ (doc list, import, change password), doc/ (editor shell, page setup, restore points, import/export UI, print styles), editor/ (Tiptap setup, toolbar, pages/ = pagination, images/), comments/, convert/ (import/export, lazy), collab/ (provider, page settings, tracked positions), auth/, assets/
src/worker/   Worker router + the three Durable Object classes (admin.ts, workspace.ts, document.ts) + passwords.ts, storage.ts, images.ts, restore-points.ts, backup.ts, auth.ts, documents.ts, db.ts
src/shared/   Shared by client and Worker: protocol.ts (API, limits), doc-schema.ts (Yjs structure, page settings)
e2e/          Puppeteer two-browser + deployed-gate tests
test/         Vitest unit/integration tests (run inside workerd); test/convert/ = converter tests and Word fixtures
docs/         colo-plan.md (source of truth) + decisions/ (ADRs)
```
