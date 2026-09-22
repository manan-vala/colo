# ADR 0006 — Workspaces, password sign-in for members, and an owner's dashboard

**Status:** Accepted
**Date:** 23 September 2026
**Amends:** [ADR 0002](0002-passkey-auth-on-workers-dev.md) (invite links and member passkeys are replaced; the owner keeps a passkey) and plan D7 / §2.1 / §5

## Context

Colo was built for two people: one Workspace Durable Object (`"default"`), members added by one-time invite links from `scripts/invite.ts` with the `ADMIN_TOKEN` secret, and passkeys as the only credential. The owner wants something else:

- several **workspaces**, each a separate group with its own members and documents;
- an **owner-only dashboard** to create workspaces, add and disable members, set their passwords and cap how many members each workspace may have;
- members signing in with **workspace ID, email and password** — no invite links.

The constraints do not change: Workers Free plan, no payment method, no third-party service (so no email, which rules out verification links and password-reset mail).

## Decision

**One Workspace Durable Object per workspace, and a new `Admin` object as the registry.** `Admin` (one instance, `"admin"`) maps a workspace's slug — the ID people type — to its object name, holds its member cap and disabled flag, and holds the owner's passkeys and sessions. The pre-M9 workspace keeps its object `"default"` and is registered as `main`; new ones are `ws-` and a ULID. The object name never changes, so renaming a slug moves nothing.

**The session cookie names its workspace object** (`__Host-colo_session=<object>.<token>`), so the Worker routes every request straight to the right workspace; the Admin object is asked only at sign-in, to turn a slug into an object. A token is looked up only in the workspace the cookie names, so a cookie cannot be moved between workspaces.

**Isolation comes from the index that already existed.** Documents stay one object each, named by a global ULID. Every document route — list, socket, images, restore points — is authorised by `Documents.get`/`identify` in the workspace named by the cookie, and a document another workspace created is not in that index: 404. Each Document object records which workspace lists it (`doc_workspace`, set from a header on Workspace's internal calls) so its metadata goes back to the right place, and a backup restore may not claim a document that already holds content in another workspace.

**Members sign in with passwords, set by the owner.**
- PBKDF2-SHA256 through WebCrypto, 16-byte salt, **100,000 iterations**, the most the Workers runtime allows per `deriveBits`. The count is stored with each hash so it can rise later.
- Hashing runs in the Workspace object, whose CPU limit is 30 s, not in the Worker with its 10 ms on Free.
- After five failures in a row an account locks for 15 minutes. Every failure — unknown workspace, unknown email, wrong password, locked, disabled — is the same `LOGIN_FAILED`, and an unknown email still spends a hash.
- The owner sets or generates a password (20 characters, about 98 bits) and sees it **once**. It is never stored readably and never exported. Members can change their own, which signs out their other sessions; the owner can reset one, which signs out all of theirs.

**The owner keeps a passkey.** The dashboard at `/admin` opens with a passkey enrolled from a one-time link that `npm run admin:enroll` makes with `ADMIN_TOKEN` — the only link left. The owner's session lasts 12 hours and never slides. The dashboard's routes are cookie-authenticated, so they now need Colo's `Origin` like every other state-changing request; only the two bearer-token routes (`enroll-token`, `restore`) are exempt.

## Consequences

- **Passwords are weaker than passkeys.** They can be phished, reused and guessed; 100,000 PBKDF2 iterations is a sixth of OWASP's 600,000. The lockout limits online guessing to 480 tries a day per account, and generated passwords make offline guessing hopeless — a password a member picks for themselves is only as good as they make it (at least 12 characters).
- **No self-service reset.** With no email service, a forgotten password goes to the owner, who sets a new one.
- **Existing members keep their ids and documents but have no password** until the owner sets one; their passkeys stop working for sign-in. The `passkeys`, `invites` and `auth_challenges` tables stay in the workspace schema, unused, because migrations only move forward.
- **All workspaces share one Free allowance.** About 20–25 people typing heavily each day across every workspace (plan §9.2); the dashboard says so, and caps default to 10 members.
- **Unknown workspace IDs answer faster** than a wrong password, because no hash is spent; a slug is a name, not a secret.
- The Admin object makes one request per workspace to list them — fine for the handful one Free account can carry.
