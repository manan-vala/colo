import { IMAGE_TYPES, LIMITS, imagePath, isImageType, isUlid, type ImageType, type UploadImageResponse } from "../shared/protocol";
import { HttpError, isoNow, json, ulid } from "./http";

/**
 * Images stored in the Document object's SQLite (plan §2.3), one row per image. The browser
 * compresses before uploading; the object only checks type, signature and size.
 */

/** Uploaded images never change (a new upload gets a new ID), so browsers may keep them. */
const IMAGE_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** The type a file's first bytes say it is, or null for anything else (SVG, HTML, …). */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  return null;
}

/** `POST /api/docs/:id/images`: the raw image as the body, its type as `Content-Type`. */
export async function uploadImage(sql: SqlStorage, docId: string, memberId: string, request: Request): Promise<Response> {
  const declared = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!isImageType(declared)) {
    throw new HttpError(415, "UNSUPPORTED_IMAGE", `Images must be one of ${IMAGE_TYPES.join(", ")}`);
  }
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > LIMITS.imageBytes) throw new HttpError(413, "IMAGE_TOO_LARGE");
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.byteLength > LIMITS.imageBytes) throw new HttpError(413, "IMAGE_TOO_LARGE");
  if (data.byteLength === 0 || sniffImageType(data) !== declared) {
    throw new HttpError(415, "UNSUPPORTED_IMAGE", "The file is not the image type it claims to be");
  }
  const stored = sql.exec<{ total: number | null }>("SELECT SUM(bytes) AS total FROM images").one().total ?? 0;
  if (stored + data.byteLength > LIMITS.documentImageBytes) {
    throw new HttpError(413, "DOCUMENT_IMAGES_FULL", "This document has no room for more images");
  }

  const id = ulid();
  sql.exec(
    "INSERT INTO images (id, mime, bytes, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    declared,
    data.byteLength,
    data.buffer,
    isoNow(),
    memberId,
  );
  return json({ id, url: imagePath(docId, id) } satisfies UploadImageResponse, { status: 201 });
}

/** `GET /api/docs/:id/images/:imageId` */
export function serveImage(sql: SqlStorage, imageId: string): Response {
  const row = isUlid(imageId)
    ? sql.exec<{ mime: string; data: ArrayBuffer }>("SELECT mime, data FROM images WHERE id = ?", imageId).toArray()[0]
    : undefined;
  if (!row) throw new HttpError(404, "NOT_FOUND");
  return new Response(row.data, {
    headers: { "Content-Type": row.mime, "Cache-Control": IMAGE_CACHE_CONTROL, "Content-Disposition": "inline" },
  });
}
