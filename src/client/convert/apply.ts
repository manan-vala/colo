import type { Editor, JSONContent } from "@tiptap/core";
import type * as Y from "yjs";
import { SETTINGS_KEYS, SETTINGS_MAP, readPageSettings } from "../../shared/doc-schema";
import { updatePageSettings } from "../collab/usePageSettings";
import { clearThreads, importThreads, type Author } from "../comments/model";
import { prepareImage } from "../editor/images/compress";
import { uploadImageBlob } from "../editor/images/upload";
import { NoteList, PENDING_IMAGE, type ImportedDocument } from "./model";

/**
 * Putting an imported file into a document: images are uploaded to it, then content, page
 * settings, title and comment threads are applied in the open editor, outside undo history
 * (Ctrl+Z must not empty the document).
 */

const IMAGE_FAILED = "Some images could not be uploaded and were left out";

/** Uploads the file's images to the document and points the content at them. */
export async function uploadImportedImages(docId: string, imported: ImportedDocument): Promise<ImportedDocument> {
  const notes = new NoteList();
  for (const note of imported.notes) notes.add(note.kind, note.message, note.count);
  const sources = new Map<string, { src: string; width: number; height: number }>();
  for (const [key, blob] of imported.images) {
    try {
      const prepared = await prepareImage(blob);
      sources.set(key, { src: await uploadImageBlob(docId, prepared.blob), width: prepared.width, height: prepared.height });
    } catch {
      notes.add("dropped", IMAGE_FAILED);
    }
  }
  return { ...imported, content: withUploadedImages(imported.content, sources), images: new Map(), notes: notes.list() };
}

function withUploadedImages(node: JSONContent, sources: Map<string, { src: string; width: number; height: number }>): JSONContent {
  if (node.type === "image") {
    const src = String(node.attrs?.src ?? "");
    if (!src.startsWith(PENDING_IMAGE)) return node;
    const uploaded = sources.get(src.slice(PENDING_IMAGE.length));
    if (!uploaded) return { type: "paragraph" };
    // The file's display size wins; the natural size is used when it had none.
    const width = Number(node.attrs?.width) || uploaded.width;
    const height = Number(node.attrs?.height) || uploaded.height;
    return { ...node, attrs: { ...node.attrs, src: uploaded.src, width, height } };
  }
  if (!node.content) return node;
  return { ...node, content: node.content.map((child) => withUploadedImages(child, sources)) };
}

/**
 * Replaces the document with the imported one. Comment authors from the file become the
 * importing member when the names match; others keep their names.
 */
export function applyImport(editor: Editor, doc: Y.Doc, imported: ImportedDocument, me: Author): void {
  editor.chain().setMeta("addToHistory", false).setContent(imported.content).run();
  const settings = doc.getMap(SETTINGS_MAP);
  const current = readPageSettings((key) => settings.get(key));
  updatePageSettings(doc, { ...current, ...imported.settings });
  if (imported.title.trim()) settings.set(SETTINGS_KEYS.title, imported.title.trim());
  clearThreads(doc);
  importThreads(
    doc,
    imported.threads.map((thread) => ({
      ...thread,
      comments: thread.comments.map((comment) => ({
        ...comment,
        author: comment.author === me.name ? me : { id: `imported:${comment.author}`, name: comment.author },
      })),
    })),
  );
}
