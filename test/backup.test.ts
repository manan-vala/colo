import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CONTENT_FIELD, SETTINGS_KEYS, SETTINGS_MAP } from "../src/shared/doc-schema";
import {
  BACKUP_BATCH_BYTES,
  BACKUP_VERSION,
  type BackupRecord,
  type DocumentSummary,
  type RestoreBackupResponse,
  type UploadImageResponse,
} from "../src/shared/protocol";
import type { Document } from "../src/worker/document";
import { STATE_CHUNK_BYTES } from "../src/worker/storage";
import { ADMIN_TOKEN, ORIGIN, call, enroll } from "./helpers/api";
import { connect, eventually } from "./helpers/yclient";

const documentStub = (id: string) => env.DOCUMENT.getByName(id) as DurableObjectStub<Document>;

/** A one-pixel PNG: enough for the signature check in `uploadImage`. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(56).fill(7)]);

async function newDoc(cookie: string, title?: string): Promise<DocumentSummary> {
  const response = await call("/api/docs", { body: title === undefined ? {} : { title }, cookie });
  expect(response.status).toBe(201);
  return response.json<DocumentSummary>();
}

function uploadImage(docId: string, cookie: string, body = PNG) {
  return exports.default.fetch(`${ORIGIN}/api/docs/${docId}/images`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "image/png" },
    body,
  });
}

/** Writes some content and waits for it to reach the object, then saves it to SQLite. */
async function writeContent(docId: string, cookie: string, text: string) {
  const client = await connect(docId, cookie);
  await client.synced;
  client.doc.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, text);
  client.close();
  await runInDurableObject(documentStub(docId), async (instance) => {
    await eventually(() => expect(instance.document.getMap(SETTINGS_MAP).get(SETTINGS_KEYS.title)).toBe(text));
    await instance.onSave();
  });
}

async function exportBackup(cookie: string): Promise<{ status: number; text: string; records: BackupRecord[] }> {
  const response = await call("/api/export", { cookie });
  const text = await response.text();
  const records = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as BackupRecord);
  return { status: response.status, text, records };
}

function restore(body: string, options: { token?: string; overwrite?: boolean } = {}) {
  const { token = ADMIN_TOKEN, overwrite = false } = options;
  return exports.default.fetch(`${ORIGIN}/api/admin/restore${overwrite ? "?overwrite=1" : ""}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
    body,
  });
}

const only = <T extends BackupRecord["type"]>(records: BackupRecord[], type: T) =>
  records.filter((record): record is Extract<BackupRecord, { type: T }> => record.type === type);

/**
 * Storage is shared between the tests in a file, so a backup holds every document made so far.
 * This rebuilds one covering just the documents a test cares about — which is also what a
 * restore sees: whatever records it is handed, in file order.
 */
function backupOf(records: BackupRecord[], docIds: string[]): string {
  const wanted = new Set(docIds);
  const lines = records.filter((record) => {
    switch (record.type) {
      case "colo-backup":
      case "member":
        return true;
      case "document":
        return wanted.has(record.id);
      case "state":
      case "image":
      case "commit":
        return wanted.has(record.doc);
      case "end":
        return false;
    }
  });
  return [...lines.map((record) => JSON.stringify(record)), JSON.stringify({ type: "end", documents: docIds.length })]
    .join("\n")
    .concat("\n");
}

describe("backup export", () => {
  it("requires a session, refuses cross-site fetches, and answers only GET", async () => {
    const { cookie } = await enroll();
    expect((await call("/api/export")).status).toBe(401);
    expect((await call("/api/export", { method: "POST", body: {}, cookie })).status).toBe(405);

    // A browser omits Origin on a same-origin GET, so the export reads Sec-Fetch-Site instead.
    const fetchSite = (site: string) => call("/api/export", { cookie, headers: { "Sec-Fetch-Site": site } });
    expect((await fetchSite("same-origin")).status).toBe(200);
    expect((await fetchSite("cross-site")).status).toBe(403);
    expect((await fetchSite("same-site")).status).toBe(403);
    expect((await call("/api/export", { cookie, headers: { Origin: "https://evil.example" } })).status).toBe(403);
    // A script sends neither header; it is not a browser being steered by someone else's page.
    expect((await call("/api/export", { cookie })).status).toBe(200);
  });

  it("carries the header, members, the document index and each document's state and images", async () => {
    const { cookie, memberId } = await enroll("keeper@example.com", "Keeper");
    const kept = await newDoc(cookie, "Kept");
    await writeContent(kept.id, cookie, "Kept");
    const image = await (await uploadImage(kept.id, cookie)).json<UploadImageResponse>();

    const { status, records } = await exportBackup(cookie);
    expect(status).toBe(200);

    const [header, ...rest] = records;
    expect(header).toMatchObject({ type: "colo-backup", version: BACKUP_VERSION, origin: ORIGIN });
    expect(rest.filter((r) => r.type === "colo-backup")).toHaveLength(0);

    expect(only(records, "member")).toContainEqual(
      expect.objectContaining({ id: memberId, email: "keeper@example.com", displayName: "Keeper", disabledAt: null }),
    );
    expect(only(records, "document")).toContainEqual(
      expect.objectContaining({ id: kept.id, title: "Kept", deletedAt: null }),
    );
    expect(only(records, "state").filter((r) => r.doc === kept.id)).toHaveLength(1);
    expect(only(records, "image").filter((r) => r.doc === kept.id)).toMatchObject([
      { id: image.id, mime: "image/png", bytes: PNG.length },
    ]);
    expect(only(records, "commit")).toContainEqual({ type: "commit", doc: kept.id, chunks: 1 });
    // The last line proves the export ran to the end rather than being cut short part-way.
    expect(records.at(-1)).toEqual({ type: "end", documents: only(records, "document").length });
  });

  it("keeps soft-deleted documents so a restore brings back the same trash", async () => {
    const { cookie } = await enroll();
    const kept = await newDoc(cookie, "Kept");
    const binned = await newDoc(cookie, "Binned");
    expect((await call(`/api/docs/${binned.id}`, { method: "DELETE", cookie })).status).toBe(200);

    const documents = only((await exportBackup(cookie)).records, "document");
    expect(documents.map((d) => d.id)).toEqual(expect.arrayContaining([kept.id, binned.id]));
    expect(documents.find((d) => d.id === binned.id)?.deletedAt).toEqual(expect.any(String));
    expect(documents.find((d) => d.id === kept.id)?.deletedAt).toBeNull();
  });

  it("never writes passkeys or sessions into a file someone downloads", async () => {
    const { cookie } = await enroll("secret@example.com", "Secret");
    await newDoc(cookie);
    const { text, records } = await exportBackup(cookie);

    // An allow-list, so adding a record type to the union without thinking fails here.
    const allowed = ["colo-backup", "member", "document", "state", "image", "commit", "end"];
    expect([...new Set(records.map((r) => r.type))].filter((type) => !allowed.includes(type))).toEqual([]);
    expect(text).not.toContain("public_key");
    expect(text).not.toContain("credential");
    // Nor may the live session token appear, in a file that lands in someone's Downloads folder.
    expect(text).not.toContain(cookie.split("=")[1]);
  });

  it("exports a large document as the rows it is stored in", async () => {
    const { cookie } = await enroll();
    const doc = await newDoc(cookie);
    const client = await connect(doc.id, cookie);
    await client.synced;
    client.close();

    await runInDurableObject(documentStub(doc.id), async (instance) => {
      instance.document.getText("big").insert(0, "x".repeat(STATE_CHUNK_BYTES * 2 + 10));
      await instance.onSave();
    });

    const { records } = await exportBackup(cookie);
    const states = only(records, "state").filter((s) => s.doc === doc.id);
    expect(states.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(only(records, "commit")).toContainEqual({ type: "commit", doc: doc.id, chunks: 3 });
  });
});

describe("backup restore", () => {
  it("refuses anything but a valid admin token", async () => {
    expect((await restore("", { token: "wrong" })).status).toBe(401);
    const response = await exports.default.fetch(`${ORIGIN}/api/admin/restore`, { method: "POST", body: "" });
    expect(response.status).toBe(401);
  });

  it("refuses to write over a workspace that already has documents", async () => {
    const { cookie } = await enroll();
    const doc = await newDoc(cookie, "Mine");
    const text = backupOf((await exportBackup(cookie)).records, [doc.id]);

    const refused = await restore(text);
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: string }>()).error).toBe("WORKSPACE_NOT_EMPTY");
    expect((await restore(text, { overwrite: true })).status).toBe(200);
  });

  it("refuses a batch larger than one request may carry", async () => {
    const line = JSON.stringify({ type: "colo-backup", version: BACKUP_VERSION, createdAt: "", origin: "", schema: {} });
    expect((await restore(`${line}\n${" ".repeat(BACKUP_BATCH_BYTES)}`)).status).toBe(413);
  });

  it("rejects a version it cannot read, a newer schema, and lines that are not JSON", async () => {
    const header = (fields: object) => JSON.stringify({ type: "colo-backup", createdAt: "", origin: "", ...fields });
    expect((await restore(header({ version: BACKUP_VERSION + 1, schema: {} }))).status).toBe(400);

    const newer = await restore(header({ version: BACKUP_VERSION, schema: { workspace: 99 } }), { overwrite: true });
    expect(newer.status).toBe(409);
    expect((await newer.json<{ error: string }>()).error).toBe("SCHEMA_TOO_NEW");

    expect((await restore("not json")).status).toBe(400);
    expect((await restore(JSON.stringify({ type: "nonsense" }))).status).toBe(400);
  });

  it("names what is wrong with a damaged line instead of failing as a server error", async () => {
    const { cookie } = await enroll();
    const doc = await newDoc(cookie);
    const header = JSON.stringify({ type: "colo-backup", version: BACKUP_VERSION, createdAt: "", origin: "", schema: {} });
    const send = (record: object) => restore([header, JSON.stringify(record)].join("\n"), { overwrite: true });

    const damaged = await send({ type: "state", doc: doc.id, seq: 0, data: "not base64!!" });
    expect(damaged.status).toBe(400);
    expect((await damaged.json<{ error: string }>()).error).toBe("INVALID_BACKUP");

    // A document whose author is not in the backup: SQLite does not enforce the key, and the
    // summary query inner-joins members, so it would otherwise just vanish from the list.
    const orphan = await send({
      type: "document",
      id: doc.id,
      title: "Orphan",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "01M2Y0000000000000000000AA",
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "01M2Y0000000000000000000AA",
      deletedAt: null,
    });
    expect(orphan.status).toBe(400);
    expect((await orphan.json<{ message: string }>()).message).toContain("not a member in this backup");
  });

  it("checks restored images the way it checks uploaded ones", async () => {
    const { cookie } = await enroll();
    const doc = await newDoc(cookie);
    const image = (mime: string, data: string) =>
      restore(
        [
          JSON.stringify({ type: "colo-backup", version: BACKUP_VERSION, createdAt: "", origin: "", schema: {} }),
          JSON.stringify({ type: "image", doc: doc.id, id: doc.id, mime, bytes: 0, createdAt: "x", createdBy: "x", data }),
        ].join("\n"),
        { overwrite: true },
      );

    // PNG bytes declared as a GIF, and an SVG smuggled in as a PNG: both refused on their bytes.
    expect((await image("image/gif", btoa(String.fromCharCode(...PNG)))).status).toBe(415);
    expect((await image("image/png", btoa("<svg onload=alert(1)>"))).status).toBe(415);
    expect((await image("image/svg+xml", btoa("<svg/>"))).status).toBe(400);
  });

  it("puts back titles, content, images and the deleted flag, keeping document ids", async () => {
    const { cookie } = await enroll("owner@example.com", "Owner");
    const doc = await newDoc(cookie, "Original");
    await writeContent(doc.id, cookie, "Original");
    const image = await (await uploadImage(doc.id, cookie)).json<UploadImageResponse>();
    const binned = await newDoc(cookie, "Binned");
    await call(`/api/docs/${binned.id}`, { method: "DELETE", cookie });

    const text = backupOf((await exportBackup(cookie)).records, [doc.id, binned.id]);

    // Now wreck it: rename, change the content and drop the image.
    expect((await call(`/api/docs/${doc.id}`, { method: "PATCH", body: { title: "Wrecked" }, cookie })).status).toBe(200);
    await runInDurableObject(documentStub(doc.id), async (instance, state) => {
      instance.document.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, "Wrecked");
      instance.document.getXmlFragment(CONTENT_FIELD).insert(0, [new Y.XmlElement("paragraph")]);
      await instance.onSave();
      state.storage.sql.exec("DELETE FROM images");
    });
    expect((await exports.default.fetch(`${ORIGIN}${image.url}`, { headers: { Cookie: cookie } })).status).toBe(404);

    const response = await restore(text, { overwrite: true });
    expect(response.status).toBe(200);
    expect(await response.json<RestoreBackupResponse>()).toMatchObject({ documents: 2 });

    const listed = await (await call(`/api/docs/${doc.id}`, { cookie })).json<DocumentSummary>();
    expect(listed.title).toBe("Original");
    expect((await call(`/api/docs/${binned.id}`, { cookie })).status).toBe(404);

    await runInDurableObject(documentStub(doc.id), async (instance) => {
      expect(instance.document.getMap(SETTINGS_MAP).get(SETTINGS_KEYS.title)).toBe("Original");
      expect(instance.document.getXmlFragment(CONTENT_FIELD).length).toBe(0);
    });

    // The id survived, so the image's own URL still resolves — the reason ids are never reminted.
    const served = await exports.default.fetch(`${ORIGIN}${image.url}`, { headers: { Cookie: cookie } });
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it("does not count a restore as an edit", async () => {
    const { cookie } = await enroll("editor@example.com", "Editor");
    const doc = await newDoc(cookie, "As backed up");
    await writeContent(doc.id, cookie, "As backed up");
    const before = await (await call(`/api/docs/${doc.id}`, { cookie })).json<DocumentSummary>();
    const text = backupOf((await exportBackup(cookie)).records, [doc.id]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await restore(text, { overwrite: true })).status).toBe(200);

    // Committing applies the state to the live document, which looks like an edit to the update
    // observer — and a restored title would push immediately. The index must keep the backup's
    // own "last edited" rather than being stamped with the time of the restore.
    await runInDurableObject(documentStub(doc.id), async (instance) => {
      await instance.onSave();
    });
    const after = await (await call(`/api/docs/${doc.id}`, { cookie })).json<DocumentSummary>();
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.updatedBy.displayName).toBe(before.updatedBy.displayName);
  });

  it("is idempotent: applying the same backup twice leaves the same workspace", async () => {
    const { cookie } = await enroll();
    const doc = await newDoc(cookie, "Once");
    await writeContent(doc.id, cookie, "Once");
    const text = backupOf((await exportBackup(cookie)).records, [doc.id]);

    expect((await restore(text, { overwrite: true })).status).toBe(200);
    expect((await restore(text, { overwrite: true })).status).toBe(200);

    const after = only((await exportBackup(cookie)).records, "document").filter((d) => d.id === doc.id);
    expect(after).toHaveLength(1);
    expect(after[0].title).toBe("Once");
  });
});

describe("backup integrity", () => {
  it("names the line of the file a damaged record is on, blank lines included", async () => {
    const { cookie } = await enroll();
    const doc = await newDoc(cookie, "Lines");
    const text = backupOf((await exportBackup(cookie)).records, [doc.id]);
    const lines = text.trimEnd().split("\n");
    // A blank line, then a damaged one: line 3 of the file, but only the 2nd non-blank line.
    const damaged = [lines[0], "", "{ not json", ...lines.slice(1)].join("\n");

    const response = await restore(damaged, { overwrite: true });
    expect(response.status).toBe(400);
    expect((await response.json<{ message: string }>()).message).toBe("Line 3 is not JSON");
  });

  it("fails a backup of a multi-chunk document that is saved while it streams", async () => {
    const { cookie } = await enroll();
    const doc = await newDoc(cookie, "Big");
    // Two chunks, so the export reads the state with more than one statement.
    await runInDurableObject(documentStub(doc.id), async (instance) => {
      instance.document.getXmlFragment(CONTENT_FIELD);
      const text = new Y.Text();
      instance.document.getMap("filler").set("text", text);
      text.insert(0, "x".repeat(STATE_CHUNK_BYTES + 10));
      await instance.onSave();
    });

    const torn = await runInDurableObject(documentStub(doc.id), async (instance) => {
      const response = await instance.fetch(
        new Request("https://document.internal/export", { method: "POST", body: "{}" }),
      );
      const reader = response.body!.getReader();
      await reader.read(); // the first chunk is out; the document is now mid-export
      await instance.onSave(); // …and someone's typing gets saved underneath it
      try {
        for (;;) if ((await reader.read()).done) break;
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(torn).toContain("was edited while it was being exported");
  });

  it("keeps the whole-document image cap when restoring", async () => {
    const { cookie } = await enroll();
    const doc = await newDoc(cookie, "Full");
    const image = {
      type: "image" as const,
      doc: doc.id,
      id: "01JBZZZZZZZZZZZZZZZZZZZZZZ",
      mime: "image/png" as const,
      bytes: PNG.byteLength,
      createdAt: new Date().toISOString(),
      createdBy: "someone",
      data: btoa(String.fromCharCode(...PNG)),
    };
    await runInDurableObject(documentStub(doc.id), (instance, state) => {
      // A document already at its image quota, without storing 200 MB to get there.
      state.storage.sql.exec(
        "INSERT INTO images (id, mime, bytes, data, created_at, created_by) VALUES (?, 'image/png', ?, ?, ?, 'someone')",
        "01JBYYYYYYYYYYYYYYYYYYYYYY",
        200_000_000,
        PNG.buffer,
        new Date().toISOString(),
      );
      void instance;
    });

    const response = await restore(
      `${JSON.stringify(image)}\n`,
      { overwrite: true },
    );
    expect(response.status).toBe(413);
    expect((await response.json<{ error: string }>()).error).toBe("DOCUMENT_IMAGES_FULL");
  });
});
