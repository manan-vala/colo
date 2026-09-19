import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COMMENTS_MAP, CONTENT_FIELD, SETTINGS_KEYS, SETTINGS_MAP } from "../src/shared/doc-schema";
import {
  LIMITS,
  type DocumentSummary,
  type ListRestorePointsResponse,
  type RestorePoint,
  type RestoreResponse,
} from "../src/shared/protocol";
import type { Document } from "../src/worker/document";
import { AUTO_POINT_INTERVAL, createPoint, listPoints, replaceState } from "../src/worker/restore-points";
import { ulid } from "../src/worker/http";
import { call, enroll } from "./helpers/api";
import { connect, eventually } from "./helpers/yclient";

const documentStub = (id: string) => env.DOCUMENT.getByName(id) as DurableObjectStub<Document>;

/** Replaces the document's content with one paragraph per string. */
function setParagraphs(doc: Y.Doc, texts: string[]) {
  const content = doc.getXmlFragment(CONTENT_FIELD);
  doc.transact(() => {
    content.delete(0, content.length);
    content.insert(
      0,
      texts.map((text) => {
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText(text)]);
        return paragraph;
      }),
    );
  });
}

const contentOf = (doc: Y.Doc) => doc.getXmlFragment(CONTENT_FIELD).toString();

function addThread(doc: Y.Doc, id: string, body: string) {
  const thread = new Y.Map<unknown>();
  thread.set("quote", body);
  doc.getMap(COMMENTS_MAP).set(id, thread);
}

/** A second replica that receives every update of `doc`, like the other person's browser. */
function replicaOf(doc: Y.Doc): Y.Doc {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  doc.on("update", (update: Uint8Array) => Y.applyUpdate(replica, update));
  return replica;
}

describe("replaceState", () => {
  it("rewinds text, comments and settings, and the change reaches other replicas", () => {
    const doc = new Y.Doc();
    setParagraphs(doc, ["Hello", "World"]);
    doc.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, "One");
    addThread(doc, "t1", "first thread");
    const snapshot = Y.encodeStateAsUpdate(doc);
    const expected = contentOf(doc);

    const other = replicaOf(doc);
    setParagraphs(doc, ["Rewritten entirely"]);
    doc.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, "Two");
    doc.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.pagination, false);
    doc.getMap(COMMENTS_MAP).delete("t1");
    addThread(doc, "t2", "later thread");

    replaceState(doc, snapshot);
    for (const replica of [doc, other]) {
      expect(contentOf(replica)).toBe(expected);
      expect(replica.getMap(SETTINGS_MAP).toJSON()).toEqual({ [SETTINGS_KEYS.title]: "One" });
      expect([...replica.getMap(COMMENTS_MAP).keys()]).toEqual(["t1"]);
      expect((replica.getMap(COMMENTS_MAP).get("t1") as Y.Map<unknown>).get("quote")).toBe("first thread");
    }
  });

  it("clears top-level types that did not exist yet when the point was taken", () => {
    const doc = new Y.Doc();
    setParagraphs(doc, ["Only text"]);
    const snapshot = Y.encodeStateAsUpdate(doc);
    addThread(doc, "t1", "added later");
    doc.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, "Named later");

    replaceState(doc, snapshot);
    expect(doc.getMap(COMMENTS_MAP).size).toBe(0);
    expect(doc.getMap(SETTINGS_MAP).size).toBe(0);
    expect(contentOf(doc)).toBe("<paragraph>Only text</paragraph>");
  });

  it("can be undone by restoring the state from before the restore", () => {
    const doc = new Y.Doc();
    setParagraphs(doc, ["Version one"]);
    const one = Y.encodeStateAsUpdate(doc);
    setParagraphs(doc, ["Version two"]);
    addThread(doc, "t2", "on version two");
    const two = Y.encodeStateAsUpdate(doc);

    replaceState(doc, one);
    expect(contentOf(doc)).toBe("<paragraph>Version one</paragraph>");
    replaceState(doc, two);
    expect(contentOf(doc)).toBe("<paragraph>Version two</paragraph>");
    expect([...doc.getMap(COMMENTS_MAP).keys()]).toEqual(["t2"]);
  });
});

async function newDoc(cookie: string): Promise<string> {
  return (await (await call("/api/docs", { body: {}, cookie })).json<DocumentSummary>()).id;
}

describe("restore points API", () => {
  it("saves a named point and restores it for everyone connected, keeping a pre-restore copy", async () => {
    const { cookie } = await enroll("alex@example.com", "Alex");
    const docId = await newDoc(cookie);
    const alex = await connect(docId, cookie);
    const bea = await connect(docId, cookie);
    await Promise.all([alex.synced, bea.synced]);

    setParagraphs(alex.doc, ["Draft one"]);
    addThread(alex.doc, "t1", "keep me");
    await eventually(() => expect(contentOf(bea.doc)).toBe("<paragraph>Draft one</paragraph>"));

    const created = await call(`/api/docs/${docId}/restore-points`, { body: { label: "  Draft   1 " }, cookie });
    expect(created.status).toBe(201);
    const point = await created.json<RestorePoint>();
    expect(point).toMatchObject({ kind: "named", label: "Draft 1", createdBy: { displayName: "Alex" } });

    setParagraphs(bea.doc, ["Draft two"]);
    bea.doc.getMap(COMMENTS_MAP).delete("t1");
    addThread(bea.doc, "t2", "newer");
    await eventually(() => expect(contentOf(alex.doc)).toBe("<paragraph>Draft two</paragraph>"));

    const restored = await call(`/api/docs/${docId}/restore-points/${point.id}/restore`, { body: {}, cookie });
    expect(restored.status).toBe(200);
    const result = await restored.json<RestoreResponse>();
    expect(result.restored.id).toBe(point.id);
    expect(result.saved).toMatchObject({ kind: "pre-restore", label: "Before restoring “Draft 1”" });

    for (const client of [alex, bea]) {
      await eventually(() => {
        expect(contentOf(client.doc)).toBe("<paragraph>Draft one</paragraph>");
        expect([...client.doc.getMap(COMMENTS_MAP).keys()]).toEqual(["t1"]);
        expect(client.events).toContainEqual({ type: "restored", by: "Alex", at: point.createdAt });
      });
    }

    // The restore is saved at once, and the pre-restore copy holds what it replaced.
    await runInDurableObject(documentStub(docId), async (instance, state) => {
      const saved = new Y.Doc();
      const rows = state.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM doc_state ORDER BY seq").toArray();
      Y.applyUpdate(saved, new Uint8Array(rows[0].data));
      expect(contentOf(saved)).toBe("<paragraph>Draft one</paragraph>");
      expect(instance.document.getMap(COMMENTS_MAP).has("t2")).toBe(false);
    });
    const list = await (await call(`/api/docs/${docId}/restore-points`, { cookie })).json<ListRestorePointsResponse>();
    expect(list.points.map((p) => p.kind)).toEqual(["pre-restore", "named"]);

    // Restoring the pre-restore copy brings the later version back.
    expect((await call(`/api/docs/${docId}/restore-points/${result.saved.id}/restore`, { body: {}, cookie })).status).toBe(200);
    await eventually(() => {
      expect(contentOf(bea.doc)).toBe("<paragraph>Draft two</paragraph>");
      expect([...bea.doc.getMap(COMMENTS_MAP).keys()]).toEqual(["t2"]);
    });
    alex.close();
    bea.close();
  });

  it("saves an import point before a file replaces the document", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    const response = await call(`/api/docs/${docId}/restore-points`, { body: { label: "Before importing “a.docx”", kind: "import" }, cookie });
    expect(response.status).toBe(201);
    expect(await response.json<RestorePoint>()).toMatchObject({ kind: "import", label: "Before importing “a.docx”" });
    // Only named and import points can be created on request.
    const other = await call(`/api/docs/${docId}/restore-points`, { body: { label: "x", kind: "pre-restore" }, cookie });
    expect((await other.json<RestorePoint>()).kind).toBe("named");
  });

  it("validates names, point IDs, sessions and origins", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    const path = `/api/docs/${docId}/restore-points`;
    expect((await call(path, { body: { label: "   " }, cookie })).status).toBe(400);
    expect((await call(path, { body: { label: "x".repeat(LIMITS.restorePointLabelLength + 1) }, cookie })).status).toBe(400);
    expect((await call(path, { body: { label: 7 }, cookie })).status).toBe(400);
    expect((await call(`${path}/01ARZ3NDEKTSV4RRFFQ69G5FAV/restore`, { body: {}, cookie })).status).toBe(404);
    expect((await call(`${path}/nope/restore`, { body: {}, cookie })).status).toBe(404);
    expect((await call(path)).status).toBe(401);
    expect((await call(path, { body: { label: "x" }, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(`${path}/x/y/z`, { cookie })).status).toBe(404);
  });
});

describe("IDs", () => {
  it("sort in creation order even within one millisecond", () => {
    const ids = Array.from({ length: 200 }, () => ulid(1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("automatic points and retention", () => {
  it("never keeps an empty document", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    await runInDurableObject(documentStub(docId), async (instance, state) => {
      (instance as unknown as { lastPointAt: number }).lastPointAt = 0;
      setParagraphs(instance.document, ["First words"]);
      await instance.onSave();
      expect(listPoints(state.storage.sql)).toHaveLength(0);
    });
  });

  it("takes a point of the last saved state once 30 minutes have passed", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    await runInDurableObject(documentStub(docId), async (instance, state) => {
      const sql = state.storage.sql;
      const self = instance as unknown as { lastPointAt: number };
      setParagraphs(instance.document, ["Saved before"]);
      await instance.onSave();

      self.lastPointAt = Date.now() - AUTO_POINT_INTERVAL - 1;
      setParagraphs(instance.document, ["Edited after"]);
      await instance.onSave();
      const points = listPoints(sql);
      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({ kind: "auto", createdBy: null });

      setParagraphs(instance.document, ["Edited again"]);
      await instance.onSave();
      expect(listPoints(sql)).toHaveLength(1);
    });
  });

  it("keeps at most 50 points, dropping automatic ones before named ones", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    await runInDurableObject(documentStub(docId), async (_instance, state) => {
      const snapshot = new Uint8Array([0]);
      for (let i = 0; i < 5; i++) createPoint(state.storage, { kind: "named", label: `n${i}`, state: snapshot });
      for (let i = 0; i < 60; i++) createPoint(state.storage, { kind: "auto", state: snapshot });
      const points = listPoints(state.storage.sql);
      expect(points).toHaveLength(LIMITS.restorePoints);
      expect(points.filter((p) => p.kind === "named")).toHaveLength(5);
      const chunks = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM restore_point_chunks").one().n;
      expect(chunks).toBe(LIMITS.restorePoints);
    });
  });

  it("never drops the point it has just saved, even when every other point is named", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    await runInDurableObject(documentStub(docId), async (_instance, state) => {
      const snapshot = new Uint8Array([0]);
      for (let i = 0; i < LIMITS.restorePoints; i++) createPoint(state.storage, { kind: "named", label: `n${i}`, state: snapshot });
      const copy = createPoint(state.storage, { kind: "pre-restore", state: snapshot });
      const points = listPoints(state.storage.sql);
      expect(points).toHaveLength(LIMITS.restorePoints);
      expect(points.map((p) => p.id)).toContain(copy.id);
      expect(points.map((p) => p.label)).not.toContain("n0"); // the oldest named point goes
    });
  });
});
