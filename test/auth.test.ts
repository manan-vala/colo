import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MeResponse } from "../src/shared/protocol";
import { PASSWORD, call, cookieFrom, enroll, signIn } from "./helpers/api";

const workspace = () => env.WORKSPACE.getByName("default");
const LONG_AGO = "2000-01-01T00:00:00.000Z";

async function errorOf(response: Response): Promise<string> {
  return (await response.json<{ error: string }>()).error;
}

describe("password sign-in", () => {
  it("signs in to the named workspace and sets a hardened cookie that names it", async () => {
    const { email } = await enroll("reg@example.com", "Reg");
    const response = await signIn(email);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^__Host-colo_session=default\.[\w-]{43};/);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) {
      expect(setCookie).toContain(attribute);
    }
    const me = await (await call("/api/me", { cookie: cookieFrom(response) })).json<MeResponse>();
    expect(me.member).toMatchObject({ email: "reg@example.com", displayName: "Reg" });
    expect(me.workspace).toEqual({ slug: "main", name: "Main" });
  });

  it("ignores case and spaces around the email and workspace", async () => {
    await enroll("mixed@example.com", "Mixed");
    const response = await call("/api/auth/login", {
      body: { workspace: " MAIN ", email: " Mixed@Example.com ", password: PASSWORD },
    });
    expect(response.status).toBe(200);
  });

  it("answers a wrong password, an unknown email and an unknown workspace alike", async () => {
    const { email } = await enroll();
    for (const response of [
      await signIn(email, "not the password at all"),
      await signIn("nobody@example.com"),
      await signIn(email, PASSWORD, "no-such-workspace"),
      await call("/api/auth/login", { body: {} }),
    ]) {
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toBe("LOGIN_FAILED");
    }
  });

  it("stores a salted hash, never the password", async () => {
    const { memberId } = await enroll();
    await runInDurableObject(workspace(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ password_hash: string; password_salt: string; password_iterations: number }>(
          "SELECT password_hash, password_salt, password_iterations FROM members WHERE id = ?",
          memberId,
        )
        .one();
      expect(row.password_hash).not.toContain(PASSWORD);
      expect(row.password_salt.length).toBeGreaterThan(0);
      expect(row.password_iterations).toBe(100_000);
    });
  });

  it("locks an account after five failures in a row, even against the right password", async () => {
    const { email, memberId } = await enroll();
    for (let i = 0; i < 5; i++) expect((await signIn(email, "wrong password!")).status).toBe(401);
    expect((await signIn(email)).status).toBe(401);

    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE members SET locked_until = ? WHERE id = ?", LONG_AGO, memberId);
    });
    expect((await signIn(email)).status).toBe(200);
  });

  it("refuses disabled members and ends their existing sessions", async () => {
    const { email, memberId, cookie } = await enroll();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE members SET disabled_at = ? WHERE id = ?", new Date().toISOString(), memberId);
    });
    expect((await call("/api/me", { cookie })).status).toBe(401);
    expect((await signIn(email)).status).toBe(401);
  });

  it("refuses a member carried over without a password", async () => {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO members (id, email, display_name, created_at) VALUES ('01HOLDMEMBER00000000000000', 'old@example.com', 'Old', ?)",
        LONG_AGO,
      );
    });
    expect((await signIn("old@example.com")).status).toBe(401);
  });
});

describe("changing a password", () => {
  it("needs the current password, then signs out every other session", async () => {
    const { email, cookie } = await enroll();
    const other = cookieFrom(await signIn(email));
    const next = "a brand new passphrase";

    const wrong = await call("/api/auth/password", { body: { current: "nope", next }, cookie });
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe("WRONG_PASSWORD");
    const short = await call("/api/auth/password", { body: { current: PASSWORD, next: "short" }, cookie });
    expect(await errorOf(short)).toBe("INVALID_PASSWORD");

    expect((await call("/api/auth/password", { body: { current: PASSWORD, next }, cookie })).status).toBe(200);
    expect((await call("/api/me", { cookie })).status).toBe(200);
    expect((await call("/api/me", { cookie: other })).status).toBe(401);
    expect((await signIn(email)).status).toBe(401);
    expect((await signIn(email, next)).status).toBe(200);
  });
});

describe("sessions", () => {
  it("returns 401 without a valid session", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", { cookie: "__Host-colo_session=forged" })).status).toBe(401);
    expect((await call("/api/me", { cookie: "__Host-colo_session=default.forged" })).status).toBe(401);
    expect((await call("/api/me", { cookie: "__Host-colo_session=../admin.forged" })).status).toBe(401);
  });

  it("does not accept a session from one workspace in another", async () => {
    const { cookie } = await enroll();
    const token = cookie.split(".")[1];
    const moved = `__Host-colo_session=ws-01ARZ3NDEKTSV4RRFFQ69G5FAV.${token}`;
    expect((await call("/api/me", { cookie: moved })).status).toBe(401);
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
    expect(slid.headers.get("Set-Cookie")).toContain(`${cookie};`);
    await runInDurableObject(workspace(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE member_id = ?", memberId)
        .one();
      expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    });
  });

  it("re-issues the cookie on any route that extends the session", async () => {
    const { cookie, memberId } = await enroll();
    const backdate = () =>
      runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec("UPDATE sessions SET last_seen_at = ? WHERE member_id = ?", LONG_AGO, memberId);
      });
    await backdate();
    const list = await call("/api/docs", { cookie });
    expect(list.status).toBe(200);
    expect(list.headers.get("Set-Cookie")).toContain("__Host-colo_session=");

    // Document authorisation cannot return a cookie, so it leaves the session as it was.
    await backdate();
    const { id } = (await (await call("/api/docs", { body: {}, cookie })).json()) as { id: string };
    await backdate();
    await runInDurableObject(workspace(), async (instance) => {
      expect((await instance.authorizeDocument(cookie, id)).ok).toBe(true);
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      const row = state.storage.sql.exec<{ last_seen_at: string }>("SELECT last_seen_at FROM sessions WHERE member_id = ?", memberId).one();
      expect(row.last_seen_at).toBe(LONG_AGO);
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
    const body = { workspace: "main", email: "x@example.com", password: PASSWORD };
    expect((await call("/api/auth/login", { body, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/auth/login", { body, origin: null })).status).toBe(403);
    expect((await call("/api/admin/workspaces", { body: {}, origin: null })).status).toBe(403);
  });
});
