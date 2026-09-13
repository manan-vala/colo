# Colo

A small collaborative notes app for two people: shared notes, edited in the browser, with saved changes showing up on the other person's screen in about a second.

Fully serverless on AWS — CloudFront + S3 for the app, Cognito for sign-in, AppSync for the GraphQL API and live updates, DynamoDB for storage — and designed to cost a few cents a month.

The architecture, data model, API, deployment steps and cost model are in [docs/colo-plan.md](docs/colo-plan.md).

## Repository layout

Planned layout (see §7 of the plan); only `docs/` exists so far.

```
colo/
  docs/colo-plan.md   # architecture and build plan
  scripts/            # admin scripts (add-member)
  infra/              # AWS CDK v2 app (TypeScript)
  web/                # Vite + React SPA
```

## Status

Planning complete; M0 (skeleton) is next.
