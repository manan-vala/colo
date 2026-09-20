# Security

Colo is a private document editor for two people, running as one Cloudflare
Worker at `colo.manan-vala.workers.dev`. The source is public; the instance is
not. There is no public sign-up — the only way in is a one-time invite link and
a passkey.

## Reporting something

Open a [security advisory](https://github.com/manan-vala/colo/security/advisories/new)
on this repository, or raise an issue with no exploit details in it and say you
have found something. Please do not post a working exploit publicly.

This is a personal project, not a product: there is no bounty, no SLA, and it
may take a while. It is still worth telling me.

## What the design assumes

These are deliberate, and documented in [§10 of the plan](docs/colo-plan.md):

- **Both members are fully trusted.** Every member can read and write every
  document. Comment authorship and cursor names come from the client and are not
  cryptographically enforced. This is a two-person app, not a multi-tenant one,
  so a report that one member can affect another's document is working as
  intended.
- **Some of the security-relevant code is ours**: the authentication flow (over
  `@simplewebauthn`), the pagination engine, the DOCX reader and the backup
  format. Those are the parts most worth a second pair of eyes.
- **`style-src` allows inline styles**, because rich-text marks, table column
  widths and page geometry render them. `script-src` stays `'self'`.

## What is genuinely out of bounds

- Anything touching the live instance at `colo.manan-vala.workers.dev`:
  no scanning, no brute force, no attempts to sign in. Run your own copy.
- The two members' documents and personal data.

## What is not in this repository

No secrets are committed, and none ever have been. `ADMIN_TOKEN` is a Wrangler
secret, deleted after both passkeys are enrolled; `.dev.vars`, `.env*` and
`.wrangler/` are gitignored, as are `backups/` and `*.ndjson`, because a backup
file holds every document and image.

If you think you have found a credential in the history, please report it as
above rather than testing it.
