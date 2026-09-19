import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LIMITS, type DocumentSummary, type UploadImageResponse } from "../src/shared/protocol";
import { fitWithin } from "../src/client/editor/images/size";
import { sniffImageType } from "../src/worker/images";
import { ORIGIN, call, enroll } from "./helpers/api";

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Just enough of each format for the signature check, padded to `size` bytes. */
function fakeImage(type: string, size = 64): Uint8Array {
  const head: Record<string, number[]> = {
    "image/webp": [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")],
    "image/png": [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a],
    "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
    "image/gif": ascii("GIF89a"),
    "image/svg+xml": ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  };
  const bytes = new Uint8Array(Math.max(size, head[type].length));
  bytes.set(head[type]);
  return bytes;
}

function upload(docId: string, cookie: string, body: Uint8Array, type: string, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { Cookie: cookie, "Content-Type": type };
  if (origin) headers.Origin = origin;
  return exports.default.fetch(`${ORIGIN}/api/docs/${docId}/images`, { method: "POST", headers, body });
}

async function newDoc(cookie: string): Promise<string> {
  return (await (await call("/api/docs", { body: {}, cookie })).json<DocumentSummary>()).id;
}

describe("image signatures", () => {
  it("recognises the allowed types and nothing else", () => {
    for (const type of ["image/webp", "image/png", "image/jpeg", "image/gif"]) expect(sniffImageType(fakeImage(type))).toBe(type);
    expect(sniffImageType(fakeImage("image/svg+xml"))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("browser-side scaling", () => {
  it("scales the longest side down to the limit and never scales up", () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1000, 5000, 2048)).toEqual({ width: 410, height: 2048 });
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10_000, 1, 2048)).toEqual({ width: 2048, height: 1 });
  });
});

describe("image API", () => {
  it("stores each allowed type and serves it back with long private caching", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    for (const type of ["image/webp", "image/png", "image/jpeg", "image/gif"]) {
      const bytes = fakeImage(type, 1000);
      const response = await upload(docId, cookie, bytes, type);
      expect(response.status).toBe(201);
      const { id, url } = await response.json<UploadImageResponse>();
      expect(url).toBe(`/api/docs/${docId}/images/${id}`);

      const image = await call(url, { cookie });
      expect(image.status).toBe(200);
      expect(image.headers.get("Content-Type")).toBe(type);
      expect(image.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
      expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    }
  });

  it("refuses SVG, mislabelled files and oversized images", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    expect((await upload(docId, cookie, fakeImage("image/svg+xml"), "image/svg+xml")).status).toBe(415);
    // An SVG (or HTML) body labelled as PNG is caught by the signature check.
    expect((await upload(docId, cookie, fakeImage("image/svg+xml"), "image/png")).status).toBe(415);
    expect((await upload(docId, cookie, fakeImage("image/jpeg"), "image/png")).status).toBe(415);
    expect((await upload(docId, cookie, new Uint8Array(0), "image/png")).status).toBe(415);
    expect((await upload(docId, cookie, fakeImage("image/png", LIMITS.imageBytes + 1), "image/png")).status).toBe(413);
  });

  it("requires a session, Colo's origin and a live document", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    const png = fakeImage("image/png");
    expect((await upload(docId, "__Host-colo_session=forged", png, "image/png")).status).toBe(401);
    expect((await upload(docId, cookie, png, "image/png", "https://evil.example")).status).toBe(403);
    expect((await upload("not-a-document", cookie, png, "image/png")).status).toBe(404);

    const { url } = await (await upload(docId, cookie, png, "image/png")).json<UploadImageResponse>();
    expect((await call(url)).status).toBe(401);
    expect((await call(`/api/docs/${docId}/images/01ARZ3NDEKTSV4RRFFQ69G5FAV`, { cookie })).status).toBe(404);
    expect((await call(`/api/docs/${docId}/images/nope`, { cookie })).status).toBe(404);

    // An image belongs to its document: another document's path does not serve it.
    const other = await newDoc(cookie);
    expect((await call(url.replace(docId, other), { cookie })).status).toBe(404);

    expect((await call(`/api/docs/${docId}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await call(url, { cookie })).status).toBe(404);
  });

  it("keeps an image-heavy document's text state small and each image in one bounded row", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    const stub = env.DOCUMENT.getByName(docId);
    const stateBytes = () =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COALESCE(SUM(length(data)), 0) AS n FROM doc_state").one().n,
      );
    const before = await stateBytes();
    for (let i = 0; i < 30; i++) {
      expect((await upload(docId, cookie, fakeImage("image/webp", 900_000), "image/webp")).status).toBe(201);
    }
    expect(await stateBytes()).toBe(before);
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec<{ bytes: number; stored: number }>("SELECT bytes, length(data) AS stored FROM images").toArray();
      expect(rows).toHaveLength(30);
      for (const row of rows) expect(row.stored).toBe(row.bytes);
      expect(Math.max(...rows.map((row) => row.stored))).toBeLessThanOrEqual(LIMITS.imageBytes);
    });
  });

  it("stops accepting images when the document's image budget is used up", async () => {
    const { cookie } = await enroll();
    const docId = await newDoc(cookie);
    await runInDurableObject(env.DOCUMENT.getByName(docId), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO images (id, mime, bytes, data, created_at, created_by) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'image/png', ?, x'00', '', '')",
        LIMITS.documentImageBytes - 100,
      );
    });
    const response = await upload(docId, cookie, fakeImage("image/png", 1000), "image/png");
    expect(response.status).toBe(413);
    expect((await response.json<{ error: string }>()).error).toBe("DOCUMENT_IMAGES_FULL");
  });
});
