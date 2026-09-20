import { abortAllDurableObjects, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CONTENT_FIELD, SETTINGS_KEYS, SETTINGS_MAP } from "../src/shared/doc-schema";
import { CLOSE_CODES, LIMITS, type DocumentSummary, type ListDocumentsResponse } from "../src/shared/protocol";
import { takeToken, type ConnectionState, type Document } from "../src/worker/document";
import { STATE_CHUNK_BYTES } from "../src/worker/storage";
import { call, enroll, signIn } from "./helpers/api";
import { connect, eventually, openSocket, syncStep1Message } from "./helpers/yclient";

async function createDoc(cookie: string, title?: string): Promise<DocumentSummary> {
  const response = await call("/api/docs", { body: title === undefined ? {} : { title }, cookie });
  expect(response.status).toBe(201);
  return response.json<DocumentSummary>();
}

const documentStub = (id: string) => env.DOCUMENT.getByName(id) as DurableObjectStub<Document>;

function storedState(state: DurableObjectState): Y.Doc {
  const chunks = state.storage.sql
    .exec<{ data: ArrayBuffer }>("SELECT data FROM doc_state ORDER BY seq")
    .toArray()
    .map((row) => new Uint8Array(row.data));
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const doc = new Y.Doc();
  if (merged.byteLength) Y.applyUpdate(doc, merged);
  return doc;
}

describe("document index API", () => {
  it("requires a session", async () => {
    expect((await call("/api/docs")).status).toBe(401);
    expect((await call("/api/docs", { body: {} })).status).toBe(401);
  });

  it("creates, lists, renames and deletes documents", async () => {
    const { cookie } = await enroll("owner@example.com", "Owner");
    const created = await createDoc(cookie);
    expect(created.title).toBe("Untitled document");
    expect(created.createdBy.displayName).toBe("Owner");

    const list = await (await call("/api/docs", { cookie })).json<ListDocumentsResponse>();
    expect(list.documents.map((d) => d.id)).toContain(created.id);

    const renamed = await call(`/api/docs/${created.id}`, { method: "PATCH", body: { title: "  Trip   plan " }, cookie });
    expect(renamed.status).toBe(200);
    expect((await renamed.json<DocumentSummary>()).title).toBe("Trip plan");

    expect((await call(`/api/docs/${created.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await call(`/api/docs/${created.id}`, { cookie })).status).toBe(404);
    const after = await (await call("/api/docs", { cookie })).json<ListDocumentsResponse>();
    expect(after.documents.map((d) => d.id)).not.toContain(created.id);
  });

  it("validates titles and ids", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie);
    const long = "x".repeat(LIMITS.titleLength + 1);
    expect((await call(`/api/docs/${doc.id}`, { method: "PATCH", body: { title: long }, cookie })).status).toBe(400);
    expect((await call("/api/docs/not-a-doc", { cookie })).status).toBe(404);
  });
});

describe("document WebSocket authorisation", () => {
  it("rejects connections without a session, from other origins, or to deleted documents", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie);
    expect((await openSocket(doc.id)).status).toBe(401);
    expect((await openSocket(doc.id, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await openSocket("01ARZ3NDEKTSV4RRFFQ69G5FAV", { cookie })).status).toBe(404);
    await call(`/api/docs/${doc.id}`, { method: "DELETE", cookie });
    expect((await openSocket(doc.id, { cookie })).status).toBe(404);
  });

  it("ignores an identity header supplied by the client", async () => {
    const { cookie, memberId } = await enroll("real@example.com", "Real");
    const doc = await createDoc(cookie);
    const client = await connect(doc.id, cookie);
    await client.synced;
    client.doc.getText("probe").insert(0, "hi");
    await runInDurableObject(documentStub(doc.id), async (instance) => {
      await eventually(() => expect(instance.document.getText("probe").toString()).toBe("hi"));
      const identities = [...instance.getConnections()].map((c) => (c.state as { identity: { memberId: string } }).identity.memberId);
      expect(identities).toEqual([memberId]);
    });
    client.close();
  });
});

describe("collaboration", () => {
  it("syncs edits between two members and seeds the title into the Yjs document", async () => {
    const a = await enroll("a@example.com", "Alex");
    const b = await enroll("b@example.com", "Sam");
    const doc = await createDoc(a.cookie, "Shared");

    const alex = await connect(doc.id, a.cookie);
    const sam = await connect(doc.id, b.cookie);
    await Promise.all([alex.synced, sam.synced]);
    expect(sam.doc.getMap(SETTINGS_MAP).get(SETTINGS_KEYS.title)).toBe("Shared");

    alex.doc.getText("body").insert(0, "Hello ");
    sam.doc.getText("body").insert(0, "World");
    await eventually(() => {
      expect(alex.doc.getText("body").toString()).toBe(sam.doc.getText("body").toString());
      expect(alex.doc.getText("body").length).toBe(11);
    });

    alex.close();
    sam.close();
  });

  it("saves the whole state, reloads it, and pushes title and last editor to the index", async () => {
    const a = await enroll("saver@example.com", "Saver");
    const doc = await createDoc(a.cookie, "Before");
    const client = await connect(doc.id, a.cookie);
    await client.synced;
    client.doc.getText("body").insert(0, "persist me");
    client.doc.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, "After");

    await runInDurableObject(documentStub(doc.id), async (instance, state) => {
      await eventually(() => {
        expect(instance.document.getText("body").toString()).toBe("persist me");
        expect(instance.document.getMap(SETTINGS_MAP).get(SETTINGS_KEYS.title)).toBe("After");
      });
      await instance.onSave();
      const rows = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM doc_state").one();
      expect(rows.n).toBe(1);
      expect(storedState(state).getText("body").toString()).toBe("persist me");
    });

    await eventually(() => expect(client.events.some((e) => e.type === "saved")).toBe(true));
    const summary = await (await call(`/api/docs/${doc.id}`, { cookie: a.cookie })).json<DocumentSummary>();
    expect(summary.title).toBe("After");
    expect(summary.updatedBy.displayName).toBe("Saver");
    client.close();
  });

  it("splits large documents into chunks below the SQLite row limit", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie);
    const client = await connect(doc.id, cookie);
    await client.synced;
    client.close();

    await runInDurableObject(documentStub(doc.id), async (instance, state) => {
      instance.document.getText("big").insert(0, "x".repeat(STATE_CHUNK_BYTES * 2 + 10));
      await instance.onSave();
      const sizes = state.storage.sql
        .exec<{ size: number }>("SELECT length(data) AS size FROM doc_state ORDER BY seq")
        .toArray()
        .map((r) => r.size);
      expect(sizes.length).toBe(3);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(STATE_CHUNK_BYTES);
      expect(storedState(state).getText("big").length).toBe(STATE_CHUNK_BYTES * 2 + 10);

      instance.document.getText("big").delete(0, STATE_CHUNK_BYTES * 2);
      await instance.onSave();
      const after = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM doc_state").one();
      expect(after.n).toBeLessThan(3);
    });
  });

  it("pushes title changes to the index immediately but throttles ordinary edits", async () => {
    const { cookie } = await enroll("throttle@example.com", "Throttle");
    const doc = await createDoc(cookie, "One");
    const client = await connect(doc.id, cookie);
    await client.synced;
    const stub = documentStub(doc.id);

    client.doc.getText("body").insert(0, "first");
    await runInDurableObject(stub, async (instance) => {
      await eventually(() => expect(instance.document.getText("body").toString()).toBe("first"));
      await instance.onSave();
    });
    const first = await (await call(`/api/docs/${doc.id}`, { cookie })).json<DocumentSummary>();

    client.doc.getText("body").insert(5, " second");
    await runInDurableObject(stub, async (instance, state) => {
      await eventually(() => expect(instance.document.getText("body").toString()).toBe("first second"));
      await instance.onSave();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    const throttled = await (await call(`/api/docs/${doc.id}`, { cookie })).json<DocumentSummary>();
    expect(throttled.updatedAt).toBe(first.updatedAt);

    client.doc.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, "Two");
    await runInDurableObject(stub, async (instance) => {
      await eventually(() => expect(instance.document.getMap(SETTINGS_MAP).get(SETTINGS_KEYS.title)).toBe("Two"));
      await instance.onSave();
    });
    expect((await (await call(`/api/docs/${doc.id}`, { cookie })).json<DocumentSummary>()).title).toBe("Two");
    client.close();
  });

  it("delivers a throttled metadata update even if the object is evicted before its alarm", async () => {
    const alice = await enroll(undefined, "Alice");
    const bob = await enroll(undefined, "Bob");
    const doc = await createDoc(alice.cookie, "Evicted");
    const stub = documentStub(doc.id);
    const a = await connect(doc.id, alice.cookie);
    const b = await connect(doc.id, bob.cookie);
    await Promise.all([a.synced, b.synced]);

    a.doc.getText("body").insert(0, "a");
    await runInDurableObject(stub, async (instance) => {
      await eventually(() => expect(instance.document.getText("body").toString()).toBe("a"));
      await instance.onSave();
    });
    b.doc.getText("body").insert(1, "b");
    await runInDurableObject(stub, async (instance, state) => {
      await eventually(() => expect(instance.document.getText("body").toString()).toBe("ab"));
      await instance.onSave();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    const summary = () => call(`/api/docs/${doc.id}`, { cookie: alice.cookie }).then((r) => r.json<DocumentSummary>());
    expect((await summary()).updatedBy.id).toBe(alice.memberId);

    // In-memory state is lost here, as when Cloudflare evicts a hibernated object. (The test's
    // own socket requests would keep the object from draining, so close them first.)
    a.close();
    b.close();
    await abortAllDurableObjects().catch(() => undefined);
    const fresh = documentStub(doc.id);
    expect(await runDurableObjectAlarm(fresh)).toBe(true);

    expect((await summary()).updatedBy.id).toBe(bob.memberId);
    await runInDurableObject(fresh, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT * FROM pending_meta").toArray()).toHaveLength(0);
    });
  });

  it("applies renames from the document list to open documents", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie, "Old");
    const client = await connect(doc.id, cookie);
    await client.synced;
    await call(`/api/docs/${doc.id}`, { method: "PATCH", body: { title: "New" }, cookie });
    await eventually(() => expect(client.doc.getMap(SETTINGS_MAP).get(SETTINGS_KEYS.title)).toBe("New"));
    client.close();
  });
});

describe("revocation", () => {
  it("closes a session's sockets on logout but leaves other sessions open", async () => {
    const a = await enroll("leaver@example.com", "Leaver");
    const b = await enroll("stayer@example.com", "Stayer");
    const doc = await createDoc(a.cookie);
    const leaver = await connect(doc.id, a.cookie);
    const stayer = await connect(doc.id, b.cookie);
    await Promise.all([leaver.synced, stayer.synced]);

    await call("/api/auth/logout", { body: {}, cookie: a.cookie });
    expect((await leaver.closed).code).toBe(CLOSE_CODES.sessionExpired);
    expect(leaver.events).toContainEqual({ type: "session-expired" });

    stayer.doc.getText("t").insert(0, "still here");
    await runInDurableObject(documentStub(doc.id), async (instance) => {
      await eventually(() => expect(instance.document.getText("t").toString()).toBe("still here"));
    });
    stayer.close();
  });

  it("forgets which documents an expired session opened at the next sign-in", async () => {
    const a = await enroll();
    const doc = await createDoc(a.cookie);
    const client = await connect(doc.id, a.cookie);
    await client.synced;
    client.close();

    const workspace = env.WORKSPACE.getByName("default");
    const openedBy = () =>
      runInDurableObject(workspace, (_instance, state) =>
        state.storage.sql.exec("SELECT * FROM document_sessions WHERE doc_id = ?", doc.id).toArray().length,
      );
    expect(await openedBy()).toBe(1);
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET expires_at = ? WHERE member_id = ?", "2000-01-01T00:00:00.000Z", a.memberId);
    });
    expect((await signIn(a.authenticator)).status).toBe(200);
    expect(await openedBy()).toBe(0);
  });

  it("closes every socket when the document is deleted", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie);
    const client = await connect(doc.id, cookie);
    await client.synced;
    await call(`/api/docs/${doc.id}`, { method: "DELETE", cookie });
    expect((await client.closed).code).toBe(CLOSE_CODES.documentDeleted);
    expect(client.events).toContainEqual({ type: "document-deleted" });
  });

  it("closes sockets whose session has expired on their next message", async () => {
    const { cookie, memberId } = await enroll();
    await runInDurableObject(env.WORKSPACE.getByName("default"), (_i, state) => {
      state.storage.sql.exec("UPDATE sessions SET expires_at = ? WHERE member_id = ?", new Date(Date.now() + 400).toISOString(), memberId);
    });
    const doc = await createDoc(cookie);
    const client = await connect(doc.id, cookie);
    await client.synced;
    await new Promise((resolve) => setTimeout(resolve, 600));
    client.sendRaw(syncStep1Message());
    expect((await client.closed).code).toBe(CLOSE_CODES.sessionExpired);
  });
});

describe("limits", () => {
  it("closes connections that send oversized messages", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie);
    const client = await connect(doc.id, cookie);
    await client.synced;
    client.sendRaw(new Uint8Array(LIMITS.messageBytes + 1));
    expect((await client.closed).code).toBe(CLOSE_CODES.messageTooLarge);
  });

  it("refills the token bucket at the sustained rate up to the burst size", () => {
    const now = 1_000_000;
    expect(takeToken({ tokens: 0, refilledAt: now }, now)).toBeNull();
    expect(takeToken({ tokens: 0, refilledAt: now - 1000 }, now)).toEqual({ tokens: LIMITS.messagesPerSecond - 1, refilledAt: now });
    expect(takeToken({ tokens: LIMITS.messageBurst, refilledAt: 0 }, now)).toEqual({ tokens: LIMITS.messageBurst - 1, refilledAt: now });
  });

  it("closes connections that exceed the message rate", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie);
    const client = await connect(doc.id, cookie);
    await client.synced;
    // Drain the bucket, then send faster than it refills.
    await runInDurableObject(documentStub(doc.id), (instance) => {
      for (const connection of instance.getConnections<ConnectionState>()) {
        connection.setState({ ...connection.state!, tokens: 0, refilledAt: Date.now() });
      }
    });
    for (let i = 0; i < 5; i++) client.sendRaw(syncStep1Message());
    expect((await client.closed).code).toBe(CLOSE_CODES.rateLimited);
    expect(client.events).toContainEqual({ type: "limit", code: "RATE_LIMITED" });
  });
});

describe("a title the document list cannot take", () => {
  it("cuts an over-long title instead of stranding the document", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie, "Short");
    const long = `${"y".repeat(LIMITS.titleLength)} and then some more`;

    const after = await runInDurableObject(documentStub(doc.id), async (instance, state) => {
      instance.document.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, long);
      await instance.onSave();
      return { alarm: await state.storage.getAlarm() };
    });

    // The push went through, so nothing is left pending and no alarm retries it every minute.
    expect(after.alarm).toBeNull();
    const listed = await (await call(`/api/docs/${doc.id}`, { cookie })).json<DocumentSummary>();
    expect(listed.title).toBe("y".repeat(LIMITS.titleLength));
  });
});

describe("a saved state that will not load", () => {
  /** Leaves the document with bytes that are not a Yjs update, as a torn restore would. */
  async function damage(docId: string) {
    await runInDurableObject(documentStub(docId), (_instance, state) => {
      state.storage.sql.exec("UPDATE doc_state SET data = ? WHERE seq = 0", new Uint8Array([9, 9, 9, 9, 9]).buffer);
    });
    await abortAllDurableObjects(); // so the next request loads it fresh
  }

  it("opens read-only rather than failing every request to the object", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie, "Damaged");
    await runInDurableObject(documentStub(doc.id), async (instance) => {
      instance.document.getXmlFragment(CONTENT_FIELD).insert(0, [new Y.XmlText("real content")]);
      await instance.onSave();
    });
    await damage(doc.id);

    // The restore-point routes are how a damaged document is repaired; they must still answer.
    const points = await call(`/api/docs/${doc.id}/restore-points`, { cookie });
    expect(points.status).toBe(200);

    const client = await connect(doc.id, cookie);
    await client.synced;
    await eventually(() => expect(client.events).toContainEqual({ type: "limit", code: "DOCUMENT_UNREADABLE" }));
    client.close();
  });

  it("never saves the empty document over the damaged state", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie, "Kept");
    await runInDurableObject(documentStub(doc.id), async (instance) => {
      instance.document.getXmlFragment(CONTENT_FIELD).insert(0, [new Y.XmlText("worth keeping")]);
      await instance.onSave();
    });
    await damage(doc.id);

    // Through the router, so the object starts the way a request starts it (`onLoad` runs).
    expect((await call(`/api/docs/${doc.id}/restore-points`, { cookie })).status).toBe(200);
    await runInDurableObject(documentStub(doc.id), async (instance) => {
      await instance.onSave();
    });
    const stored = await runInDurableObject(documentStub(doc.id), (_instance, state) =>
      state.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM doc_state WHERE seq = 0").one(),
    );
    // Still the damaged bytes, not an empty document written over them.
    expect(new Uint8Array(stored.data)).toEqual(new Uint8Array([9, 9, 9, 9, 9]));
  });

  it("comes back when a restore point is restored", async () => {
    const { cookie } = await enroll();
    const doc = await createDoc(cookie, "Repaired");
    await runInDurableObject(documentStub(doc.id), async (instance) => {
      instance.document.getXmlFragment(CONTENT_FIELD).insert(0, [new Y.XmlText("the good version")]);
      await instance.onSave();
    });
    const point = await (
      await call(`/api/docs/${doc.id}/restore-points`, { body: { label: "good" }, cookie })
    ).json<{ id: string }>();
    await damage(doc.id);

    const restored = await call(`/api/docs/${doc.id}/restore-points/${point.id}/restore`, { body: {}, cookie });
    expect(restored.status).toBe(200);
    await runInDurableObject(documentStub(doc.id), (instance) => {
      expect(instance.document.getXmlFragment(CONTENT_FIELD).toString()).toContain("the good version");
    });
  });
});
