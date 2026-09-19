import type { AnyExtension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { CONTENT_FIELD } from "../../shared/doc-schema";
import type { Collaboration as CollaborationState } from "../collab/useCollaboration";
import { CommentMark } from "../comments/comment-mark";
import { DocsFormatting } from "./extensions/docs-shortcuts";
import { Indent } from "./extensions/indent";
import { ColoImage } from "./images";
import { PageBreak, PagedTableView, Pagination } from "./pages";

/** Link protocols the editor accepts; anything else (javascript:, data:, …) is rejected. */
export const LINK_PROTOCOLS = ["http", "https", "mailto", "tel"];

/** True for http(s), mailto and tel links, including scheme-less ones like "example.com". */
export function isSafeLink(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return !scheme || LINK_PROTOCOLS.includes(scheme[1].toLowerCase());
}

/** Adds https:// to scheme-less web addresses. */
export function normalizeLink(url: string): string {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/\//, "")}`;
}

/**
 * The document schema and editing behaviour (plan F5) without collaboration: the live editor
 * adds Yjs on top, and the import/export converters use it on its own, so both always agree on
 * what a document can contain.
 */
export function documentExtensions(docId: string): AnyExtension[] {
  return [
    StarterKit.configure({
      // Collaboration brings Yjs-aware undo/redo, so Tiptap's own history is disabled.
      undoRedo: false,
      // The styles menu, outline and CSS offer four levels; pasted h5/h6 become paragraphs.
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        protocols: LINK_PROTOCOLS,
        isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && isSafeLink(url),
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      },
    }),
    TextStyleKit.configure({ lineHeight: false, backgroundColor: false }),
    Highlight.configure({ multicolor: true }),
    // Images share paragraph alignment, so the alignment buttons work on a selected image.
    TextAlign.configure({ types: ["heading", "paragraph", "image"], alignments: ["left", "center", "right", "justify"] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true, lastColumnResizable: false, View: PagedTableView } }),
    Subscript,
    Superscript,
    Indent,
    DocsFormatting,
    PageBreak,
    Pagination,
    CommentMark,
    ColoImage.configure({ docId }),
  ];
}

/** The live editor: the document extensions bound to a collaborative Yjs document. */
export function buildExtensions(collab: CollaborationState): AnyExtension[] {
  return [
    ...documentExtensions(collab.docId),
    Placeholder.configure({ placeholder: "Start typing…" }),
    Collaboration.configure({ document: collab.doc, field: CONTENT_FIELD }),
    CollaborationCaret.configure({ provider: collab.provider, user: collab.user }),
  ];
}
