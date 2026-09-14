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

## Repository layout

Planned layout (see §7 of the plan); only `docs/` exists so far.

```
colo/
  wrangler.jsonc          # Worker, Durable Object, assets config
  vite.config.ts          # Vite + @cloudflare/vite-plugin
  public/_headers         # security and cache headers for static assets
  src/
    client/               # React SPA
    worker/               # Worker router + Workspace Durable Object
    shared/               # WebSocket protocol types
  scripts/invite.ts       # admin: create one-time invite links
  test/                   # vitest + @cloudflare/vitest-pool-workers
  docs/
```

## Status

Planning complete (Draft v3). Next: M0 — skeleton deployed to `workers.dev`.
