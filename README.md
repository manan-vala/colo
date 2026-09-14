# Colo

A small collaborative notes app for two people: shared notes, edited in the browser, with saved changes showing up on the other person's screen in about a second.

Runs entirely on the **Cloudflare Workers Free plan** at $0/month:

- **Workers Static Assets** serve the React SPA.
- A thin **Worker** forwards `/api/*` to one **Durable Object**.
- The Durable Object stores everything in its embedded **SQLite** database and pushes live updates over **WebSockets**.
- Sign-in is invite-only with **passkeys**.

## Docs

- [docs/colo-plan.md](docs/colo-plan.md) — architecture, data model, API, deployment, cost model and build plan
- [ADR 0001 — Move from AWS to Cloudflare](docs/decisions/0001-move-from-aws-to-cloudflare.md)
- [ADR 0002 — Passkey sign-in on workers.dev](docs/decisions/0002-passkey-auth-on-workers-dev.md)

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
```

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

M0 (skeleton) is deployed at <https://colo.manan-vala.workers.dev>: the SPA, the Worker router and an empty SQLite-backed Workspace Durable Object (running in SIN) answering `GET /api/health`. Next: M1, passkey auth.
