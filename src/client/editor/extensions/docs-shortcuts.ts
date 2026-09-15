import { Extension, type CommandProps } from "@tiptap/core";
import { DEFAULT_FONT_SIZE, FONT_SIZES, parsePoints } from "../fonts";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docsFormatting: {
      /** Removes character formatting (keeps links), alignment and indentation, like Docs' "Clear formatting". */
      clearFormatting: () => ReturnType;
      /** Steps the font size to the next size in the toolbar list. */
      stepFontSize: (direction: 1 | -1) => ReturnType;
    };
  }
}

const CHARACTER_MARKS = ["bold", "italic", "underline", "strike", "subscript", "superscript", "highlight", "textStyle", "code"];

/** Commands and shortcuts matching Google Docs where Tiptap has no built-in equivalent. */
export const DocsFormatting = Extension.create({
  name: "docsFormatting",

  addCommands() {
    return {
      clearFormatting:
        () =>
        ({ chain }: CommandProps) => {
          let next = chain();
          for (const mark of CHARACTER_MARKS) next = next.unsetMark(mark, { extendEmptyMarkRange: true });
          return next.unsetTextAlign().resetAttributes("paragraph", "indent").resetAttributes("heading", "indent").run();
        },
      stepFontSize:
        (direction: 1 | -1) =>
        ({ editor, commands }: CommandProps) => {
          const points = parsePoints(editor.getAttributes("textStyle").fontSize as string | undefined);
          const next = direction > 0 ? FONT_SIZES.find((s) => s > points) : [...FONT_SIZES].reverse().find((s) => s < points);
          if (next === undefined) return false;
          return next === DEFAULT_FONT_SIZE ? commands.unsetFontSize() : commands.setFontSize(`${next}pt`);
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-\\": () => this.editor.commands.clearFormatting(),
      "Mod-Shift->": () => this.editor.commands.stepFontSize(1),
      "Mod-Shift-.": () => this.editor.commands.stepFontSize(1),
      "Mod-Shift-<": () => this.editor.commands.stepFontSize(-1),
      "Mod-Shift-,": () => this.editor.commands.stepFontSize(-1),
      "Mod-Alt-0": () => this.editor.commands.setParagraph(),
    };
  },
});
