import { Mark, mergeAttributes } from "@tiptap/core";
import { Fragment, Slice, type MarkType, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { COMMENT_MARK } from "./anchors";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    comment: {
      /** Anchors a thread to a range of text. */
      setComment: (threadId: string, range: { from: number; to: number }) => ReturnType;
      /** Removes a thread's anchor everywhere in the document. */
      unsetComment: (threadId: string) => ReturnType;
    };
  }
  interface Storage {
    comment: CommentStorage;
  }
}

export interface CommentStorage {
  /** Called for Ctrl/⌘+Alt+M; set by the document screen. */
  onAddComment: (() => void) | null;
}

/**
 * The mark that anchors a comment thread to text (plan §3.3). It stores only the thread ID;
 * the thread lives in the Yjs comments map. Marks of different threads may overlap, and typing
 * at the edge of commented text does not extend it.
 *
 * Adding and removing anchors is kept out of undo history: undoing your typing should not
 * detach a comment, and threads themselves are not undoable (as in Google Docs).
 * Highlighting is done by CSS (CommentStyles), so resolving a thread never touches the text.
 */
export const CommentMark = Mark.create<Record<string, never>, CommentStorage>({
  name: COMMENT_MARK,
  excludes: "",
  inclusive: false,
  spanning: true,

  addStorage() {
    return { onAddComment: null };
  },

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-comment-id"),
        renderHTML: (attributes) => ({ "data-comment-id": attributes.threadId as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "colo-comment" }), 0];
  },

  addCommands() {
    return {
      setComment:
        (threadId, { from, to }) =>
        ({ tr, dispatch }) => {
          if (from >= to) return false;
          if (dispatch) tr.addMark(from, to, this.type.create({ threadId })).setMeta("addToHistory", false);
          return true;
        },
      unsetComment:
        (threadId) =>
        ({ tr, dispatch }) => {
          const ranges: { from: number; to: number }[] = [];
          tr.doc.descendants((node, pos) => {
            if (node.isText && node.marks.some((m) => m.type === this.type && m.attrs.threadId === threadId)) {
              ranges.push({ from: pos, to: pos + node.nodeSize });
            }
          });
          if (ranges.length === 0) return false;
          if (dispatch) {
            for (const { from, to } of ranges) tr.removeMark(from, to, this.type.create({ threadId }));
            tr.setMeta("addToHistory", false);
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Alt-m": () => {
        this.storage.onAddComment?.();
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: new PluginKey("colo-comment-paste"),
        props: {
          // Pasted text never brings anchors with it: a copy would give one thread two places.
          transformPasted: (slice) => new Slice(stripMark(slice.content, type), slice.openStart, slice.openEnd),
        },
      }),
    ];
  },
});

function stripMark(fragment: Fragment, type: MarkType): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) nodes.push(node.mark(type.removeFromSet(node.marks)));
    else nodes.push(node.copy(stripMark(node.content, type)));
  });
  return Fragment.fromArray(nodes);
}
