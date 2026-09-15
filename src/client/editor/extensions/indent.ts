import { Extension, type CommandProps, type Editor } from "@tiptap/core";

export const MAX_INDENT = 8;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indent: {
      /** Indents list items one level, or paragraphs and headings by one step. */
      indent: () => ReturnType;
      /** Reverses indent. */
      outdent: () => ReturnType;
    };
  }
}

/** Which list item type contains the selection, if any. */
function listItemType(editor: Editor): "taskItem" | "listItem" | null {
  if (editor.isActive("taskItem")) return "taskItem";
  if (editor.isActive("listItem")) return "listItem";
  return null;
}

/**
 * Google Docs-style indentation. Inside lists it nests items; elsewhere it adds an `indent`
 * level to paragraphs and headings, rendered as `data-indent` and styled in CSS.
 */
export const Indent = Extension.create({
  name: "indent",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => Math.min(MAX_INDENT, Number(element.getAttribute("data-indent")) || 0),
            renderHTML: (attributes) => (attributes.indent ? { "data-indent": String(attributes.indent) } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    const step =
      (delta: 1 | -1) =>
      () =>
      ({ editor, tr, state, dispatch }: CommandProps) => {
        const item = listItemType(editor);
        if (item) {
          return delta > 0 ? editor.commands.sinkListItem(item) : editor.commands.liftListItem(item);
        }
        let changed = false;
        const { from, to } = state.selection;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
          const current = (node.attrs.indent as number) ?? 0;
          const next = Math.max(0, Math.min(MAX_INDENT, current + delta));
          if (next !== current) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
            changed = true;
          }
          return false;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };

    return {
      indent: step(1),
      outdent: step(-1),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Tables use Tab to move between cells.
      Tab: () => (this.editor.isActive("table") ? false : this.editor.commands.indent()),
      "Shift-Tab": () => (this.editor.isActive("table") ? false : this.editor.commands.outdent()),
    };
  },
});
