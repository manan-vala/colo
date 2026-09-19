import type { Editor } from "@tiptap/core";
import { type ApiError, type UploadImageResponse } from "../../../shared/protocol";
import { resolvePosition, trackPosition } from "../../collab/tracked-range";
import { prepareImage } from "./compress";

const UPLOAD_ERRORS: Record<string, string> = {
  IMAGE_TOO_LARGE: "That image is larger than 1 MB even after compression.",
  UNSUPPORTED_IMAGE: "Only PNG, JPEG, WebP and GIF images can be added.",
  DOCUMENT_IMAGES_FULL: "This document has no room for more images.",
  UNAUTHORIZED: "You were signed out; sign in again to add images.",
};

/** Uploads one prepared image to the document and returns its URL. */
export async function uploadImageBlob(docId: string, blob: Blob): Promise<string> {
  const response = await fetch(`/api/docs/${docId}/images`, {
    method: "POST",
    headers: { "Content-Type": blob.type },
    body: blob,
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as Partial<ApiError>;
    throw new Error(UPLOAD_ERRORS[error.error ?? ""] ?? "The image could not be uploaded.");
  }
  return ((await response.json()) as UploadImageResponse).url;
}

/** Image files among pasted or dropped files. */
export function imageFiles(files: FileList | null | undefined): File[] {
  return [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
}

/**
 * Compresses and uploads images, then inserts them where they were added. The other person may
 * edit meanwhile, so the place is kept as a Yjs relative position rather than a number.
 */
export async function insertImageFiles(
  editor: Editor,
  files: File[],
  options: { docId: string; at: number; onError: (message: string) => void },
): Promise<void> {
  const place = trackPosition(editor.state, options.at);
  const images: { src: string; width: number; height: number }[] = [];
  for (const file of files) {
    try {
      const prepared = await prepareImage(file);
      images.push({ src: await uploadImageBlob(options.docId, prepared.blob), width: prepared.width, height: prepared.height });
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "The image could not be added.");
    }
  }
  if (images.length === 0 || editor.isDestroyed) return;
  const at = (place !== null ? resolvePosition(editor.state, place) : null) ?? editor.state.selection.from;
  editor
    .chain()
    .insertContentAt(at, images.map((attrs) => ({ type: "image", attrs })))
    .run();
}
