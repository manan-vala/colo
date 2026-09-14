# ADR 0001 — Move Colo from AWS to Cloudflare

**Status:** Accepted
**Date:** 14 September 2026
**Supersedes:** the AWS design in `docs/colo-plan.md` Draft v2 (commit `be40456`)

## Context

Colo is a two-person collaborative notes app with near-real-time updates and a very low budget target.

Draft v2 planned it on AWS serverless: S3 + CloudFront for the app, Cognito for sign-in, AppSync for GraphQL and subscriptions, DynamoDB for storage. Checking current AWS pricing showed:

- **S3 and AppSync have no free allowance this project can rely on.** Accounts created before 15 July 2025 had 12-month trials that have all expired; newer accounts get no trials, only sign-up credits that expire after 12 months.
- **Realistic cost was $0.00–0.25/month from day one,** with no hard cap: AWS Budgets alert but do not stop charges, so a runaway bug is billed.
- **New accounts must be on the Paid plan**, because a Free-plan account closes after six months.

We compared the same app on Cloudflare before writing any code.

## Options considered

1. **Stay on AWS (Draft v2).** Managed real-time subscriptions (AppSync) and managed login (Cognito) mean almost no connection or auth code. Costs a few cents a month with open-ended billing.
2. **Cloudflare: D1 for storage + a Durable Object for fan-out.** $0 on the Free plan, but two data-path services and a race between writing and broadcasting.
3. **Cloudflare: one Durable Object holding SQLite data and the WebSocket hub.** $0 on the Free plan, one data-path service, write and broadcast in one serialized step.

| | AWS (option 1) | Cloudflare (option 3) |
|---|---|---|
| Monthly cost | $0.00–0.25 | $0.00 |
| Billing exposure | Open-ended; alerts only | None — Free plan, no payment method; limits fail with errors |
| Failure mode on a runaway bug | A bill | App unavailable until 00:00 UTC |
| Real-time | Managed (AppSync subscriptions) | Our code: ~150 lines of WebSocket handling in a Durable Object plus a client wrapper |
| Login | Managed (Cognito + Amplify) | Our code: passkeys (see ADR 0002) |
| Deploy | CDK stack + S3 sync + CloudFront invalidation | `wrangler deploy` (one versioned upload) |
| Backups | DynamoDB PITR, 35 days (~1¢/month) | JSON export; SQLite PITR 30 days if available on Free |
| Tier B co-editing | Hard: payload caps, per-delta operation billing, no server-side merge | Natural: Yjs documents inside the same Durable Object |

## Decision

**Option 3.** Colo runs on the Cloudflare Workers Free plan as a thin Worker in front of a single Workspace Durable Object that stores all data in SQLite and holds every WebSocket connection. Static assets are served by Workers Static Assets.

## Consequences

**Positive**

- A hard $0 bill: no payment method, no credits to expire, no account-plan traps.
- One deployable unit; no cache invalidation or cross-service wiring.
- No race between saving and broadcasting; no echo-suppression IDs.
- Edits sent as WebSocket messages are billed at 20:1, leaving large headroom under the daily limits.
- Tier B (Yjs) fits without new services.

**Negative**

- We own the real-time connection code (reconnect, resync, heartbeats) that AppSync and Amplify provided.
- We own authentication (ADR 0002).
- Exceeding a daily free limit takes the app offline until 00:00 UTC (05:30 IST) instead of costing money; mitigated by debounce, a per-socket rate cap and size caps.
- Data is reachable only through the Durable Object, so there is no ad-hoc SQL console; inspection and backup go through `/api/export`.
- Shorter or unconfirmed point-in-time recovery on the Free plan compared with DynamoDB's 35 days.

## Revisit when

- Real use shows daily free limits being approached, which would make Workers Paid ($5/month minimum) worth comparing against AWS again.
- Colo needs to serve many more users or teams.
