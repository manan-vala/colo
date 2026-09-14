# ADR 0002 — Passkey sign-in on workers.dev instead of Cloudflare Access

**Status:** Accepted
**Date:** 14 September 2026
**Related:** [ADR 0001](0001-move-from-aws-to-cloudflare.md)

## Context

Colo needs invite-only sign-in for two people, must protect a WebSocket connection as well as HTTP calls, and has a $0/month target. After moving to Cloudflare (ADR 0001), the natural first choice was **Cloudflare Access** (Zero Trust, free for up to 50 users), which puts a managed login — for example an emailed one-time PIN — in front of the app with no auth code in Colo.

Cloudflare's documentation (September 2026) rules out the free version of that setup:

- **Worker-level Access policies do not currently support WebSocket connections.** Worker-level Access is the mode available on a `*.workers.dev` URL, and Colo's live updates depend on a WebSocket.
- **`ctx.access` is not passed to Workers that serve Static Assets.** Colo serves its SPA through Static Assets, so the Worker would not receive the identity even for HTTP calls.
- **Hostname-based Access** supports ordinary web apps and would work, but it requires a custom domain added to Cloudflare, which costs the domain's registry price every year.

## Options considered

1. **Custom domain + hostname-based Access (email one-time PIN).** Least auth code; login enforced at Cloudflare's edge; covers WebSockets. Costs the registry price of a domain each year (Cloudflare Registrar has no markup) — breaks the strict $0 target.
2. **Worker-level Access on `workers.dev`.** $0, but does not support the WebSocket connection and does not expose identity with Static Assets. Rejected.
3. **Passwords stored by Colo.** $0, but brings password hashing, credential stuffing and phishing risk, and password reset flows. Rejected.
4. **Passkeys (WebAuthn), invite-only, implemented in Colo.** $0 on `workers.dev`; phishing-resistant; no secrets stored besides public keys and hashed session and invite tokens.

## Decision

**Option 4.** The Workspace Durable Object implements passkey registration and sign-in with `@simplewebauthn/server`, one-time invite links created with an admin secret, and hashed, revocable session cookies. Details are in `docs/colo-plan.md` §5.

## Consequences

**Positive**

- Strictly $0: no domain, no Zero Trust setup.
- Phishing-resistant sign-in with biometrics or device PIN; no passwords to store or reset.
- The same session protects HTTP calls and the WebSocket upgrade.

**Negative**

- Around 250 lines of authentication code to own and test: invites, WebAuthn ceremonies, sessions, revocation.
- SimpleWebAuthn documents Node and Deno support but not Workers; an M1 spike must confirm it runs in workerd, with direct WebCrypto verification as the fallback.
- Passkeys are bound to the hostname. Moving to a custom domain later means both users enroll new passkeys via fresh invites.
- The admin secret can create invites; it is deleted after both users have enrolled.

## Revisit when

- A custom domain is registered for Colo (plan decision D4). Hostname-based Access then becomes a viable replacement or a second layer in front of the passkey login.
- Cloudflare adds WebSocket support to Worker-level Access and exposes `ctx.access` alongside Static Assets.
