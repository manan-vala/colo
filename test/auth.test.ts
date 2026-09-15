import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MeResponse } from "../src/shared/protocol";
import { ADMIN_TOKEN, ORIGIN, call, cookieFrom, enroll, invite, signIn } from "./helpers/api";
import { createSoftAuthenticator } from "./helpers/authenticator";

const workspace = () => env.WORKSPACE.getByName("default");
const LONG_AGO = "2000-01-01T00:00:00.000Z";

async function registrationOptions(inviteToken: string) {
  const response = await call("/api/auth/register/options", { body: { inviteToken } });
  return response.json<{ challengeId: string; options: any }>();
}

describe("admin invites", () => {
  it("requires the admin token", async () => {
    const body = { email: "x@example.com", name: "X" };
    expect((await call("/api/admin/invites", { body, origin: null })).status).toBe(401);
    const wrong = await call("/api/admin/invites", { body, origin: null, headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("creates a member and a one-time link on the configured origin, storing only a hash", async () => {
    const result = await invite("new@example.com", "New Person");
    expect(result.url.startsWith(`${ORIGIN}/invite#`)).toBe(true);
    expect(result.token.length).toBeGreaterThanOrEqual(43);
    await runInDurableObject(workspace(), (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ token_hash: string }>("SELECT token_hash FROM invites WHERE member_id = ?", result.memberId)
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).not.toBe(result.token);
    });
  });

  it("reuses the member for a second invite to the same email", async () => {
    const first = await invite("again@example.com", "Again");
    const second = await invite("AGAIN@example.com", "Again");
    expect(second.memberId).toBe(first.memberId);
  });

  it("rejects invalid input", async () => {
    const response = await call("/api/admin/invites", {
      body: { email: "not-an-email", name: "X" },
      origin: null,
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(400);
  });
});

describe("registration", () => {
  it("registers a passkey, sets a hardened session cookie and signs the member in", async () => {
    const { token } = await invite("reg@example.com", "Reg");
    const authenticator = await createSoftAuthenticator();
    const { challengeId, options } = await registrationOptions(token);
    expect(options.rp.id).toBe("colo.example");
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });

    const response = await call("/api/auth/register/verify", {
      body: { inviteToken: token, challengeId, response: await authenticator.register(options, ORIGIN) },
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^__Host-colo_session=[\w-]{43};/);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) {
      expect(setCookie).toContain(attribute);
    }

    const me = await call("/api/me", { cookie: cookieFrom(response) });
    expect(me.status).toBe(200);
    expect((await me.json<MeResponse>()).member).toMatchObject({ email: "reg@example.com", displayName: "Reg" });
  });

  it("uses each invite only once", async () => {
    const { inviteToken } = await enroll();
    const again = await call("/api/auth/register/options", { body: { inviteToken } });
    expect(again.status).toBe(400);
    expect((await again.json<{ error: string }>()).error).toBe("INVITE_INVALID");
  });

  it("rejects expired invites", async () => {
    const { token, memberId } = await invite("expired@example.com", "Old");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE invites SET expires_at = ? WHERE member_id = ?", LONG_AGO, memberId);
    });
    expect((await call("/api/auth/register/options", { body: { inviteToken: token } })).status).toBe(400);
  });

  it("rejects a response created for another origin", async () => {
    const { token } = await invite("phish@example.com", "Phish");
    const authenticator = await createSoftAuthenticator();
    const { challengeId, options } = await registrationOptions(token);
    const response = await call("/api/auth/register/verify", {
      body: { inviteToken: token, challengeId, response: await authenticator.register(options, "https://evil.example") },
    });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe("VERIFICATION_FAILED");
  });

  it("requires user verification", async () => {
    const { token } = await invite("nouv@example.com", "No UV");
    const authenticator = await createSoftAuthenticator({ userVerified: false });
    const { challengeId, options } = await registrationOptions(token);
    const response = await call("/api/auth/register/verify", {
      body: { inviteToken: token, challengeId, response: await authenticator.register(options, ORIGIN) },
    });
    expect(response.status).toBe(400);
  });

  it("does not accept a challenge twice", async () => {
    const { token } = await invite("twice@example.com", "Twice");
    const authenticator = await createSoftAuthenticator();
    const { challengeId, options } = await registrationOptions(token);
    const credential = await authenticator.register(options, ORIGIN);
    const body = { inviteToken: token, challengeId, response: credential };
    expect((await call("/api/auth/register/verify", { body })).status).toBe(200);
    expect((await call("/api/auth/register/verify", { body })).status).toBe(400);
  });
});

describe("sign-in", () => {
  it("signs in with a registered passkey and stores the new counter", async () => {
    const { authenticator, memberId } = await enroll();
    const response = await signIn(authenticator);
    expect(response.status).toBe(200);
    expect((await call("/api/me", { cookie: cookieFrom(response) })).status).toBe(200);
    await runInDurableObject(workspace(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ counter: number }>("SELECT counter FROM passkeys WHERE member_id = ?", memberId)
        .one();
      expect(row.counter).toBe(1);
    });
  });

  it("rejects unknown passkeys", async () => {
    const stranger = await createSoftAuthenticator();
    await stranger.register({ challenge: "x", rp: { id: "colo.example" }, user: { id: "someone" } }, ORIGIN);
    expect((await signIn(stranger)).status).toBe(401);
  });

  it("rejects replayed assertions", async () => {
    const { authenticator } = await enroll();
    const { challengeId, options } = await (await call("/api/auth/login/options", { body: {} })).json<any>();
    const body = { challengeId, response: await authenticator.authenticate(options, ORIGIN) };
    expect((await call("/api/auth/login/verify", { body })).status).toBe(200);
    expect((await call("/api/auth/login/verify", { body })).status).toBe(400);
  });

  it("refuses disabled members and their existing sessions", async () => {
    const { authenticator, memberId, cookie } = await enroll();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE members SET disabled_at = ? WHERE id = ?", new Date().toISOString(), memberId);
    });
    expect((await call("/api/me", { cookie })).status).toBe(401);
    expect((await signIn(authenticator)).status).toBe(401);
  });
});

describe("sessions", () => {
  it("returns 401 without a valid session", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", { cookie: "__Host-colo_session=forged" })).status).toBe(401);
  });

  it("logs out and clears the cookie", async () => {
    const { cookie } = await enroll();
    const response = await call("/api/auth/logout", { body: {}, cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call("/api/me", { cookie })).status).toBe(401);
  });

  it("slides the expiry at most once a day and re-issues the cookie", async () => {
    const { cookie, memberId } = await enroll();
    expect((await call("/api/me", { cookie })).headers.get("Set-Cookie")).toBeNull();

    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE member_id = ?",
        LONG_AGO,
        new Date(Date.now() + 60_000).toISOString(),
        memberId,
      );
    });
    const slid = await call("/api/me", { cookie });
    expect(slid.headers.get("Set-Cookie")).toContain("__Host-colo_session=");
    await runInDurableObject(workspace(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE member_id = ?", memberId)
        .one();
      expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    });
  });

  it("rejects expired sessions", async () => {
    const { cookie, memberId } = await enroll();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET expires_at = ? WHERE member_id = ?", LONG_AGO, memberId);
    });
    expect((await call("/api/me", { cookie })).status).toBe(401);
  });
});

describe("origin checks", () => {
  it("rejects state-changing requests without Colo's origin", async () => {
    expect((await call("/api/auth/login/options", { body: {}, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/auth/login/options", { body: {}, origin: null })).status).toBe(403);
  });
});
