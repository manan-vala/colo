# Security

Colo is a private document editor for small groups, running as one Cloudflare
Worker at `colo.manan-vala.workers.dev`. The source is public; the instance is
not. There is no public sign-up — the owner creates every account in a
passkey-protected dashboard, and members sign in to one workspace with a
password the owner set.

## Reporting something

Open a [security advisory](https://github.com/manan-vala/colo/security/advisories/new)
on this repository, or raise an issue with no exploit details in it and say you
have found something. Please do not post a working exploit publicly.

This is a personal project, not a product: there is no bounty, no SLA, and it
may take a while. It is still worth telling me.

## What the design assumes

These are deliberate, and documented in [§10 of the plan](docs/colo-plan.md):

- **Members of a workspace are fully trusted.** Every member can read and
  write every document in their workspace. Comment authorship and cursor names
  come from the client and are not cryptographically enforced, so a report that
  one member can affect another's document *in the same workspace* is working as
  intended. **Reaching another workspace's documents is not**, and is exactly
  the kind of report that is wanted.
- **Passwords are PBKDF2-SHA256 at 100,000 iterations**, the Workers runtime's
  maximum and below OWASP's recommendation; accounts lock for 15 minutes after
  five failures ([ADR 0006](docs/decisions/0006-workspaces-and-password-sign-in.md)).
- **Some of the security-relevant code is ours**: the authentication flow (over
  `@simplewebauthn` for the owner, WebCrypto PBKDF2 for members), the pagination engine, the DOCX reader and the backup
  format. Those are the parts most worth a second pair of eyes.
- **`style-src` allows inline styles**, because rich-text marks, table column
  widths and page geometry render them. `script-src` stays `'self'`.

## What is genuinely out of bounds

- Anything touching the live instance at `colo.manan-vala.workers.dev`:
  no scanning, no brute force, no attempts to sign in. Run your own copy.
- The members' documents and personal data.

## What is not in this repository

No secrets are committed, and none ever have been. `ADMIN_TOKEN` is a Wrangler
secret, deleted after the owner's passkey is enrolled; `.dev.vars`, `.env*` and
`.wrangler/` are gitignored, as are `backups/` and `*.ndjson`, because a backup
file holds every document and image.

If you think you have found a credential in the history, please report it as
above rather than testing it.
