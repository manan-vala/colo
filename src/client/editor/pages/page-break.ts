import { Node, canInsertNode, isNodeSelection, mergeAttributes } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

/** Matches page break nodes in the editor DOM; the paginator sizes the top-level ones. */
export const PAGE_BREAK_SELECTOR = "[data-page-break]";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      /** Inserts a page break; the content after it starts on the next page. */
      setPageBreak: () => ReturnType;
    };
  }
}

/**
 * A manual page break (Insert → Page break, Ctrl/⌘+Enter). It stores nothing but its position:
 * on paged screens the paginator stretches it to the end of its page, in print it forces a
 * sheet break, and in a continuous document it is drawn as a labelled rule.
 */
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: "div[data-page-break]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-page-break": "", class: "colo-page-break" })];
  },

  addCommands() {
    return {
      // Same placement rules as Tiptap's horizontal rule: split the paragraph at the cursor and
      // leave the cursor at the start of the next page.
      setPageBreak:
        () =>
        ({ chain, state }) => {
          if (!canInsertNode(state, state.schema.nodes[this.name])) return false;
          const { selection } = state;
          const current = chain();
          if (isNodeSelection(selection)) current.insertContentAt(selection.$to.pos, { type: this.name });
          else current.insertContent({ type: this.name });
          return current
            .command(({ tr, dispatch }) => {
              if (!dispatch) return true;
              const { $to } = tr.selection;
              const after = $to.nodeAfter;
              if (after?.isTextblock) tr.setSelection(TextSelection.create(tr.doc, $to.pos + 1));
              else if (after?.isBlock) tr.setSelection(NodeSelection.create(tr.doc, $to.pos));
              else if (!after) {
                const end = $to.end();
                tr.insert(end, state.schema.nodes.paragraph.create());
                tr.setSelection(TextSelection.create(tr.doc, end + 1));
              }
              tr.scrollIntoView();
              return true;
            })
            .run();
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => this.editor.commands.setPageBreak(),
    };
  },
});
