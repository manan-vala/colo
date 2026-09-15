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

## Development

Requires Node.js 22+ (`.nvmrc` pins 24).

```bash
npm ci
npm run dev          # Vite + Worker + Durable Object in workerd: http://localhost:5173
npm test             # Vitest inside workerd
npm run build        # type-check, then build client and Worker into dist/
npm run preview      # serve the production build locally (applies public/_headers)
npm run deploy       # build, then wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run invite -- --email <email> --name "<name>" [--local]   # one-time invite link
```

Browser smoke tests drive the local Chrome with virtual passkeys (start `npm run dev` or `npx vite preview --port 5173` first):

```bash
npm run e2e:auth     # invite → passkey → sign out → sign in
npm run e2e:collab   # two people co-edit a document
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
    client/               # React SPA (components/ui = shadcn/ui)
    worker/               # Worker router + Workspace Durable Object
    shared/               # types shared by client and Worker
  scripts/                # admin scripts (M1)
  test/
  docs/
```

## Status

M0 (skeleton) is deployed at <https://colo.manan-vala.workers.dev>: the SPA, the Worker router and an empty SQLite-backed Workspace Durable Object (running in SIN) answering `GET /api/health`.

Plan v4 turns Colo into a collaborative document editor (§11 of the plan). **M1 (passkey sign-in) and M2 (collaborative documents) are built and tested locally but not yet deployed**; the production deploy, admin secret, enrolment and the deployed M2 gate are the next steps. After that: M3, the Docs-style UI.
