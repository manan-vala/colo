# Colo — orientation for coding agents

Colo is a private, browser-based document editor for **two people**, styled like Google Docs: simultaneous typing with live cursors, rich formatting, real pages, comments, and DOCX import/export. It runs entirely on the **Cloudflare Workers Free plan** with no payment method on the account — **$0/month by construction**, every dependency is open source and self-hosted, nothing calls a third-party service.

**Read [docs/colo-plan.md](docs/colo-plan.md) before making non-trivial changes.** It is the living source of truth: architecture, data model, API, security posture, cost model, and the milestone-by-milestone build plan with a revision history explaining *why* each choice was made. This file is a fast-loading summary, not a replacement for it. The three ADRs in `docs/decisions/` explain the platform (AWS→Cloudflare), auth (passkeys on workers.dev) and editor engine (Tiptap+Yjs) decisions in depth.

## Current status (15 Sep 2026)

M0–M3 are **built and deployed** to `colo.manan-vala.workers.dev`:
- Invite-only passkey auth (no passwords)
- Collaborative documents: per-document Durable Object, Yjs CRDT sync, hibernating WebSockets, live cursors
- Docs-style editor shell: File/Edit/View/Insert/Format menus, full formatting toolbar, fonts, colors, links, lists, tables, outline panel, zoom
- Branding: black logo mark (auth screens, document-list header), white favicon variant, home-screen banner image

**Next up: M4 — real pages** (A4/Letter pagination, margins, headers/footers, page numbers, table splitting, print stylesheet). See §11 of the plan for the full milestone table (M5 comments, M6 images/restore points, M7 DOCX import/export, M8 hardening/CI).

**Not built yet** — don't assume these exist: DOCX export/import (M7, nothing in `docx`/`mammoth` is installed), images (M6), comments (M5), pagination (M4), `/api/export` backups (M8), Workers Builds CI (M8).

## Stack

React 19 + TypeScript, Vite 8 + `@cloudflare/vite-plugin` (runs the Worker and Durable Objects in workerd during dev), Tailwind v4 + shadcn/ui (Radix), Tiptap 3 + Yjs + `y-partyserver` for collaborative editing, `@simplewebauthn` for passkeys. One Workspace Durable Object holds members/auth/document index; one Document Durable Object per document holds Yjs state in its own SQLite.

## Commands

```bash
npm run dev          # Vite + Worker + Durable Objects in workerd: http://localhost:5173
npm test             # Vitest inside workerd (real Durable Objects/SQLite)
npm run build        # tsc -b, then vite build
npm run deploy       # build, then wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run e2e:auth | e2e:collab | e2e:formatting   # puppeteer + Chrome virtual passkeys, two-browser tests
COLO_URL=https://… npm run e2e:gate              # deployed-Worker gate (hibernation, reconnect through a redeploy)
```

## Conventions and known quirks

- **`npm install` is broken on this project** — npm 11.5 crashes resolving Vite 8's optional peer deps. Add packages with `npx npm@latest install <pkg>`; plain `npm ci` is fine.
- **UI components** come from shadcn/ui: `npx shadcn@latest add <component>`, not hand-rolled.
- **Commit style**: `type(Mn): summary` for milestone work (e.g. `feat(M3): …`, `fix(M2): …`), plain `type: summary` otherwise (e.g. this session's `feat: add brand logo/favicon…`). Plan-doc updates are their own `docs:` commits.
- **No paid third-party services, ever** — stay on Cloudflare's Free plan; if a feature would need one (R2, a paid font CDN, a hosted DOCX/PDF converter), do it client-side or with a self-hosted open-source library instead, and record the trade-off in an ADR if it's a real architectural fork.
- **No Claude attribution in commits.**
- **Cost discipline is a hard constraint, not a preference.** Every design choice in the plan (whole-state debounced saves instead of per-keystroke rows, hibernating sockets, hidden-tab disconnect, per-connection rate/size caps) exists to stay inside the Workers Free daily limits — see §9 of the plan before changing anything touching Durable Object messages, storage rows, or duration.
- **Two trusted users, not a multi-tenant app.** Every member can read/write every document (D7 in the plan); don't add authorization complexity the plan explicitly deferred.
- When a milestone lands, the established pattern is: bump `docs/colo-plan.md`'s revision-history table (§0) and milestone table (§11) in the same or a following `docs:` commit, and update `README.md`'s Status paragraph.

## Repo layout

```
src/client/   React SPA — home/ (doc list), doc/ (editor shell), editor/ (Tiptap setup), auth/, assets/
src/worker/   Worker router + both Durable Object classes (workspace.ts, document.ts)
src/shared/   Types shared by client and Worker (protocol.ts)
e2e/          Puppeteer two-browser + deployed-gate tests
test/         Vitest unit/integration tests (run inside workerd)
docs/         colo-plan.md (source of truth) + decisions/ (ADRs)
```
