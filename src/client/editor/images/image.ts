import Image from "@tiptap/extension-image";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { IMAGE_PATH } from "../../../shared/protocol";
import { PENDING_IMAGE } from "../../convert/model";
import { ImageView } from "./image-view";
import { imageFiles, insertImageFiles } from "./upload";

export interface ImageStorage {
  /** Where upload failures are reported; set by the document screen. */
  onError: (message: string) => void;
  /** Uploads files and inserts them at the cursor (Insert → Image, the toolbar). */
  insertFiles: (files: File[]) => void;
}

declare module "@tiptap/core" {
  interface Storage {
    image: ImageStorage;
  }
}

/** A Colo image path from an `src` (relative or on this origin), or null for anything else. */
export function ownImagePath(src: string | null): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, location.origin);
    return url.origin === location.origin && IMAGE_PATH.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

/**
 * The `src` an image may have in the document: a Colo image path, or while a file is being
 * imported (never in the live editor) a placeholder for an image not uploaded yet.
 */
function acceptedSource(src: string | null, acceptPending: boolean): string | null {
  if (acceptPending && src?.startsWith(PENDING_IMAGE)) return src;
  return ownImagePath(src);
}

const positiveInt = (value: string | null) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Images (plan F8): block images stored with the document and served by its Durable Object.
 * `width`/`height` are the displayed size; alignment is the `textAlign` attribute shared with
 * paragraphs, so the toolbar's alignment buttons work on a selected image.
 *
 * Only Colo's own image URLs are accepted from pasted HTML: other sources would be third-party
 * requests (and are blocked by the CSP anyway). Pasted or dropped image files are uploaded.
 */
export const ColoImage = Image.extend<{ docId: string; acceptPending: boolean }, ImageStorage>({
  draggable: true,

  addOptions() {
    return { ...this.parent!(), inline: false, allowBase64: false, resize: false, docId: "", acceptPending: false };
  },

  addStorage() {
    return { onError: () => {}, insertFiles: () => {} };
  },

  onCreate() {
    this.storage.insertFiles = (files) => {
      void insertImageFiles(this.editor, files, {
        docId: this.options.docId,
        at: this.editor.state.selection.from,
        onError: (message) => this.storage.onError(message),
      });
    };
  },

  addAttributes() {
    const source = (element: HTMLElement) => acceptedSource(element.getAttribute("src"), this.options.acceptPending);
    return {
      src: { default: null, parseHTML: source },
      alt: { default: null },
      width: { default: null, parseHTML: (element) => positiveInt(element.getAttribute("width")) },
      height: { default: null, parseHTML: (element) => positiveInt(element.getAttribute("height")) },
    };
  },

  parseHTML() {
    const accepted = (element: HTMLElement) => acceptedSource(element.getAttribute("src"), this.options.acceptPending);
    return [{ tag: "img[src]", getAttrs: (element) => (accepted(element) ? null : false) }];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => new ImageView(node, editor, getPos);
  },

  addProseMirrorPlugins() {
    const { editor, options, storage } = this;
    const insert = (files: File[], at: number) =>
      void insertImageFiles(editor, files, { docId: options.docId, at, onError: (message) => storage.onError(message) });
    return [
      new Plugin({
        key: new PluginKey("colo-image-upload"),
        props: {
          handlePaste: (view, event) => {
            const files = imageFiles(event.clipboardData?.files);
            if (files.length === 0) return false;
            insert(files, view.state.selection.from);
            return true;
          },
          handleDrop: (view, event, _slice, moved) => {
            const files = moved ? [] : imageFiles(event.dataTransfer?.files);
            if (files.length === 0) return false;
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
            insert(files, at);
            return true;
          },
        },
      }),
    ];
  },
});
