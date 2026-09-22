import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SETTINGS_KEYS, SETTINGS_MAP } from "../src/shared/doc-schema";
import type {
  AdminMembersResponse,
  AdminWorkspace,
  AdminWorkspacesResponse,
  DocumentSummary,
  ListDocumentsResponse,
  MemberChangeResponse,
} from "../src/shared/protocol";
import { ADMIN_TOKEN, ORIGIN, call, cookieFrom, enroll, ownerSession, signIn } from "./helpers/api";
import { createSoftAuthenticator } from "./helpers/authenticator";
import type { Document } from "../src/worker/document";
import { connect, eventually, openSocket } from "./helpers/yclient";

const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error;

async function createWorkspace(owner: string, slug: string, maxMembers?: number): Promise<AdminWorkspace> {
  const response = await call("/api/admin/workspaces", { body: { slug, name: `Team ${slug}`, maxMembers }, cookie: owner });
  expect(response.status).toBe(201);
  return response.json<AdminWorkspace>();
}

async function addMember(owner: string, slug: string, email: string, password?: string) {
  return call(`/api/admin/workspaces/${slug}/members`, { body: { email, name: email.split("@")[0], password }, cookie: owner });
}

describe("owner passkey", () => {
  it("needs the admin token for an enrollment link, and uses each link once", async () => {
    expect((await call("/api/admin/enroll-token", { body: {}, origin: null })).status).toBe(401);
    const bad = await call("/api/admin/enroll-token", { body: {}, origin: null, headers: { Authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);

    const link = await call("/api/admin/enroll-token", { body: {}, origin: null, headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    const { url } = await link.json<{ url: string }>();
    expect(url.startsWith(`${ORIGIN}/admin/enroll#`)).toBe(true);
    const token = url.split("#")[1];
    const authenticator = await createSoftAuthenticator();
    const { challengeId, options } = await (await call("/api/admin/enroll/options", { body: { token } })).json<any>();
    const body = { token, challengeId, response: await authenticator.register(options, ORIGIN) };
    const enrolled = await call("/api/admin/enroll/verify", { body });
    expect(enrolled.status).toBe(200);
    expect(enrolled.headers.get("Set-Cookie")).toMatch(/^__Host-colo_admin=[\w-]{43};.*Max-Age=43200/);
    expect((await call("/api/admin/enroll/options", { body: { token } })).status).toBe(400);
  });

  it("signs the owner in with the enrolled passkey and nobody else's", async () => {
    const { authenticator } = await ownerSession();
    const { challengeId, options } = await (await call("/api/admin/login/options", { body: {} })).json<any>();
    const response = await call("/api/admin/login/verify", {
      body: { challengeId, response: await authenticator.authenticate(options, ORIGIN) },
    });
    expect(response.status).toBe(200);
    expect((await call("/api/admin/me", { cookie: cookieFrom(response) })).status).toBe(200);

    const stranger = await createSoftAuthenticator();
    await stranger.register({ challenge: "x", rp: { id: "colo.example" }, user: { id: "someone" } }, ORIGIN);
    const next = await (await call("/api/admin/login/options", { body: {} })).json<any>();
    const refused = await call("/api/admin/login/verify", {
      body: { challengeId: next.challengeId, response: await stranger.authenticate(next.options, ORIGIN) },
    });
    expect(refused.status).toBe(401);
  });

  it("keeps the dashboard from members and strangers", async () => {
    const { cookie } = await enroll();
    expect((await call("/api/admin/workspaces", { cookie })).status).toBe(401);
    expect((await call("/api/admin/workspaces")).status).toBe(401);
    expect((await call("/api/admin/workspaces/main/members", { cookie })).status).toBe(401);
  });

  it("ends the owner's session on sign-out", async () => {
    const { cookie } = await ownerSession();
    const out = await call("/api/admin/logout", { body: {}, cookie });
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call("/api/admin/me", { cookie })).status).toBe(401);
  });
});

describe("workspaces", () => {
  it("lists the workspace from before M9 as main", async () => {
    const { cookie } = await ownerSession();
    const { workspaces } = await (await call("/api/admin/workspaces", { cookie })).json<AdminWorkspacesResponse>();
    expect(workspaces.find((w) => w.slug === "main")).toMatchObject({ name: "Main", maxMembers: 10, disabledAt: null });
  });

  it("creates workspaces with valid, unique IDs", async () => {
    const { cookie } = await ownerSession();
    const created = await createWorkspace(cookie, "design-team", 3);
    expect(created).toMatchObject({ slug: "design-team", maxMembers: 3, members: 0, documents: 0 });
    const again = await call("/api/admin/workspaces", { body: { slug: "design-team", name: "X" }, cookie });
    expect(await errorOf(again)).toBe("SLUG_TAKEN");
    for (const slug of ["A", "Has Space", "-dash", "x"]) {
      expect((await call("/api/admin/workspaces", { body: { slug, name: "X" }, cookie })).status).toBe(400);
    }
    expect((await call("/api/admin/workspaces", { body: { slug: "big", name: "X", maxMembers: 0 }, cookie })).status).toBe(400);
  });

  it("adds members up to the cap and shows a generated password once", async () => {
    const { cookie } = await ownerSession();
    await createWorkspace(cookie, "pair", 2);
    const first = await addMember(cookie, "pair", "one@pair.example");
    expect(first.status).toBe(201);
    const { member, password } = await first.json<MemberChangeResponse>();
    expect(password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/);
    expect(member).toMatchObject({ email: "one@pair.example", hasPassword: true, disabledAt: null });
    expect((await signIn("one@pair.example", password, "pair")).status).toBe(200);

    expect((await addMember(cookie, "pair", "two@pair.example", "a chosen password")).status).toBe(201);
    const third = await addMember(cookie, "pair", "three@pair.example");
    expect(third.status).toBe(409);
    expect(await errorOf(third)).toBe("WORKSPACE_FULL");
    expect(await errorOf(await addMember(cookie, "pair", "one@pair.example"))).toBe("EMAIL_TAKEN");
    expect(await errorOf(await addMember(cookie, "pair", "short@pair.example", "short"))).toBe("INVALID_PASSWORD");

    const { members } = await (await call("/api/admin/workspaces/pair/members", { cookie })).json<AdminMembersResponse>();
    expect(members.map((m) => m.email)).toEqual(["one@pair.example", "two@pair.example"]);
    expect(JSON.stringify(members)).not.toContain(password!);
  });

  it("will not lower the cap below the members already there", async () => {
    const { cookie } = await ownerSession();
    await createWorkspace(cookie, "trio", 3);
    await addMember(cookie, "trio", "a@trio.example");
    await addMember(cookie, "trio", "b@trio.example");
    const lower = await call("/api/admin/workspaces/trio", { method: "PATCH", body: { maxMembers: 1 }, cookie });
    expect(await errorOf(lower)).toBe("BELOW_MEMBER_COUNT");
    expect((await call("/api/admin/workspaces/trio", { method: "PATCH", body: { maxMembers: 2 }, cookie })).status).toBe(200);
  });

  it("resets a password and disables a member, signing them out each time", async () => {
    const { cookie } = await ownerSession();
    await createWorkspace(cookie, "reset");
    const { member, password } = await (await addMember(cookie, "reset", "r@reset.example")).json<MemberChangeResponse>();
    const session = cookieFrom(await signIn("r@reset.example", password, "reset"));
    expect((await call("/api/me", { cookie: session })).status).toBe(200);

    const reset = await call(`/api/admin/workspaces/reset/members/${member.id}`, {
      method: "PATCH",
      body: { password: true },
      cookie,
    });
    const next = (await reset.json<MemberChangeResponse>()).password!;
    expect(next).not.toBe(password);
    expect((await call("/api/me", { cookie: session })).status).toBe(401);
    expect((await signIn("r@reset.example", password, "reset")).status).toBe(401);
    const again = cookieFrom(await signIn("r@reset.example", next, "reset"));

    await call(`/api/admin/workspaces/reset/members/${member.id}`, { method: "PATCH", body: { disabled: true }, cookie });
    expect((await call("/api/me", { cookie: again })).status).toBe(401);
    expect((await signIn("r@reset.example", next, "reset")).status).toBe(401);
  });

  it("renames a workspace's ID without touching its sessions, and disabling one signs everyone out", async () => {
    const { cookie } = await ownerSession();
    await createWorkspace(cookie, "old-name");
    const { password } = await (await addMember(cookie, "old-name", "m@rename.example")).json<MemberChangeResponse>();
    const session = cookieFrom(await signIn("m@rename.example", password, "old-name"));

    await call("/api/admin/workspaces/old-name", { method: "PATCH", body: { slug: "new-name" }, cookie });
    expect((await call("/api/me", { cookie: session })).status).toBe(200);
    expect((await signIn("m@rename.example", password, "old-name")).status).toBe(401);
    expect((await signIn("m@rename.example", password, "new-name")).status).toBe(200);

    await call("/api/admin/workspaces/new-name", { method: "PATCH", body: { disabled: true }, cookie });
    expect((await call("/api/me", { cookie: session })).status).toBe(401);
    expect((await signIn("m@rename.example", password, "new-name")).status).toBe(401);
  });
});

describe("isolation between workspaces", () => {
  it("keeps each workspace's documents, sockets and images to its own members", async () => {
    const { cookie: owner } = await ownerSession();
    const created = await createWorkspace(owner, "isolated");
    expect(created.documents).toBe(0);
    const { password } = await (await addMember(owner, "isolated", "iso@example.com")).json<MemberChangeResponse>();
    const outsider = cookieFrom(await signIn("iso@example.com", password, "isolated"));
    const insider = (await enroll()).cookie;

    const doc = await (await call("/api/docs", { body: { title: "Main only" }, cookie: insider })).json<DocumentSummary>();
    const theirs = await (await call("/api/docs", { cookie: outsider })).json<ListDocumentsResponse>();
    expect(theirs.documents).toEqual([]);
    expect((await call(`/api/docs/${doc.id}`, { cookie: outsider })).status).toBe(404);
    expect((await call(`/api/docs/${doc.id}`, { method: "DELETE", cookie: outsider })).status).toBe(404);
    expect((await call(`/api/docs/${doc.id}/restore-points`, { cookie: outsider })).status).toBe(404);
    expect((await openSocket(doc.id, { cookie: outsider })).status).toBe(404);
    expect((await openSocket(doc.id, { cookie: insider })).status).toBe(101);
  });

  it("will not restore one workspace's document into another", async () => {
    const { cookie: owner } = await ownerSession();
    await createWorkspace(owner, "restore-target");
    const { cookie } = await enroll();
    const doc = await (await call("/api/docs", { body: { title: "Belongs to main" }, cookie })).json<DocumentSummary>();
    const client = await connect(doc.id, cookie);
    await client.synced;
    client.close();
    await runInDurableObject(env.DOCUMENT.getByName(doc.id) as DurableObjectStub<Document>, (instance) => instance.onSave());
    const backup = await (await call("/api/export", { cookie })).text();

    const response = await exports.default.fetch(`${ORIGIN}/api/admin/restore?workspace=restore-target`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/x-ndjson" },
      body: backup,
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe("DOCUMENT_IN_OTHER_WORKSPACE");
    // Refused before its index row was written, so the target does not list it either.
    await runInDurableObject(env.WORKSPACE.getByName((await env.ADMIN.getByName("admin").resolve("restore-target"))!), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT 1 FROM documents WHERE id = ?", doc.id).toArray()).toEqual([]);
    });
  });

  it("sends a new workspace's document metadata back to that workspace", async () => {
    const { cookie: owner } = await ownerSession();
    await createWorkspace(owner, "meta-home");
    const { password } = await (await addMember(owner, "meta-home", "meta@example.com")).json<MemberChangeResponse>();
    const cookie = cookieFrom(await signIn("meta@example.com", password, "meta-home"));
    const doc = await (await call("/api/docs", { body: {}, cookie })).json<DocumentSummary>();

    const client = await connect(doc.id, cookie);
    await client.synced;
    client.doc.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, "Renamed live");
    await runInDurableObject(env.DOCUMENT.getByName(doc.id) as DurableObjectStub<Document>, async (instance, state) => {
      await eventually(() => expect(instance.document.getMap(SETTINGS_MAP).get(SETTINGS_KEYS.title)).toBe("Renamed live"));
      await instance.onSave();
      const row = state.storage.sql.exec<{ do_name: string }>("SELECT do_name FROM doc_workspace").one();
      expect(row.do_name).toMatch(/^ws-/);
    });
    client.close();
    const list = await (await call("/api/docs", { cookie })).json<ListDocumentsResponse>();
    expect(list.documents[0]?.title).toBe("Renamed live");
  });
});
