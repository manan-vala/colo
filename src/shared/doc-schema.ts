/** Structure of the Yjs document behind every Colo document (plan §3.3). */

/** `Y.XmlFragment` holding the Tiptap/ProseMirror content. */
export const CONTENT_FIELD = "content";

/** `Y.Map` of document settings. */
export const SETTINGS_MAP = "settings";

export const SETTINGS_KEYS = {
  title: "title",
} as const;

export const DEFAULT_TITLE = "Untitled document";
