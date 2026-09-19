# Colo — orientation for coding agents

Colo is a private, browser-based document editor for **two people**, styled like Google Docs: simultaneous typing with live cursors, rich formatting, real pages, comments, and DOCX import/export. It runs entirely on the **Cloudflare Workers Free plan** with no payment method on the account — **$0/month by construction**, every dependency is open source and self-hosted, nothing calls a third-party service.

**Read [docs/colo-plan.md](docs/colo-plan.md) before making non-trivial changes.** It is the living source of truth: architecture, data model, API, security posture, cost model, and the milestone-by-milestone build plan with a revision history explaining *why* each choice was made. This file is a fast-loading summary, not a replacement for it. The ADRs in `docs/decisions/` explain the platform (AWS→Cloudflare), auth (passkeys on workers.dev), editor engine (Tiptap+Yjs) and pagination engine (our own, 0004) decisions in depth.

## Current status (19 Sep 2026)

M0–M4 are **built and deployed** to `colo.manan-vala.workers.dev`:
- Invite-only passkey auth (no passwords)
- Collaborative documents: per-document Durable Object, Yjs CRDT sync, hibernating WebSockets, live cursors
- Docs-style editor shell: File/Edit/View/Insert/Format menus, full formatting toolbar, fonts, colors, links, lists, tables, outline panel, zoom
- Branding: black logo mark (auth screens, document-list header), white favicon variant, home-screen banner image
- Real pages (M4): page settings in the Yjs `settings` map, our own decoration-only paginator in `src/client/editor/pages/` (ADR 0004 — `tiptap-pagination-plus`/`tiptap-table-plus` are *not* used), page breaks, Page setup dialog, print CSS. Page geometry is computed from settings (`layout.ts`); only content height is measured

**M5 — comments is built but not deployed** (run `npm run deploy` when ready). `src/client/comments/`: threads in the Yjs `comments` map (`model.ts`), a `comment` mark as the anchor (`comment-mark.ts`), highlights from a generated stylesheet (`highlight.ts`), margin cards placed from the page's own layout (`CommentRail.tsx`, `rail-layout.ts`), a panel for all threads and for narrow screens. `useComments` returns `{ state, actions }`; `state` must not change on ordinary typing and `actions` is stable — keep it that way, or every card re-renders per keystroke.

**M6 — images and restore points is built but not deployed.**
- Images: `src/client/editor/images/` (extension, our own resizable node view, browser-side compression, upload with a tracked insertion point) and `src/worker/images.ts` (one SQLite row per image).
- Restore points: `src/worker/restore-points.ts` (storage, automatic points, `replaceState`) and `src/client/doc/RestorePointsDialog.tsx`.
- Image and restore-point routes are authorised by Workspace (`authorizeRequest`) and served by the Document object (`onMemberRequest`).
- A new top-level Yjs type must be added to `ROOT_TYPES` in `doc-schema.ts`, or restores will not rewind it.

**Next up: M7 — DOCX import/export.** See §11 of the plan for the full milestone table (M8 hardening/CI).

**Not built yet** — don't assume these exist: DOCX export/import (M7, nothing in `docx`/`mammoth` is installed), `/api/export` backups (M8), Workers Builds CI (M8).

## Stack

React 19 + TypeScript, Vite 8 + `@cloudflare/vite-plugin` (runs the Worker and Durable Objects in workerd during dev), Tailwind v4 + shadcn/ui (Radix), Tiptap 3 + Yjs + `y-partyserver` for collaborative editing, `@simplewebauthn` for passkeys. One Workspace Durable Object holds members/auth/document index; one Document Durable Object per document holds Yjs state in its own SQLite.

## Commands

```bash
npm run dev          # Vite + Worker + Durable Objects in workerd: http://localhost:5173
npm test             # Vitest inside workerd (real Durable Objects/SQLite)
npm run build        # tsc -b, then vite build
npm run deploy       # build, then wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run e2e:auth | e2e:collab | e2e:formatting | e2e:pages | e2e:comments | e2e:images | e2e:restore   # puppeteer + Chrome virtual passkeys, two-browser tests (need a server on :5173)
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
- **Two trusted users, not a multi-tenant app.** Every member can read/write every document (D7 in the plan); don't add authorization complexity the plan explicitly deferred.
- **Pagination is decoration-only.** Never write page-derived data into the Yjs document; pages are computed per browser. Blocks that establish a formatting context (table rows, `hr`, flex list items) need an explicit full width on paged screens, or the browser squeezes them into the zero-width gap beside a margin band (see `index.css`).
- **e2e helpers live in `e2e/browser.ts`** (`enroll`, `press`, `openMenubar`, `chooseMenuItem`, `editorText`); don't copy them into scripts.
- When a milestone lands, the established pattern is: bump `docs/colo-plan.md`'s revision-history table (§0) and milestone table (§11) in the same or a following `docs:` commit, and update `README.md`'s Status paragraph.

## Repo layout

```
src/client/   React SPA — home/ (doc list), doc/ (editor shell, page setup, restore points, print styles), editor/ (Tiptap setup, toolbar, pages/ = pagination, images/), comments/, collab/ (provider, page settings, tracked positions), auth/, assets/
src/worker/   Worker router + both Durable Object classes (workspace.ts, document.ts) + storage.ts, images.ts, restore-points.ts, auth.ts, documents.ts, db.ts
src/shared/   Shared by client and Worker: protocol.ts (API, limits), doc-schema.ts (Yjs structure, page settings)
e2e/          Puppeteer two-browser + deployed-gate tests
test/         Vitest unit/integration tests (run inside workerd)
docs/         colo-plan.md (source of truth) + decisions/ (ADRs)
```
