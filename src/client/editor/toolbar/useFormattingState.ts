import { useEditorState, type Editor } from "@tiptap/react";

export type Alignment = "left" | "center" | "right" | "justify";

export interface FormattingState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  subscript: boolean;
  superscript: boolean;
  /** 0 for normal text. */
  heading: number;
  fontFamily: string | undefined;
  fontSize: string | undefined;
  color: string | undefined;
  highlight: string | undefined;
  link: boolean;
  align: Alignment;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  inTable: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/** Everything the toolbar and menus need, recomputed only when it changes. */
export function useFormattingState(editor: Editor | null): FormattingState | null {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const textStyle = e.getAttributes("textStyle");
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        subscript: e.isActive("subscript"),
        superscript: e.isActive("superscript"),
        heading: [1, 2, 3, 4].find((level) => e.isActive("heading", { level })) ?? 0,
        fontFamily: textStyle.fontFamily as string | undefined,
        fontSize: textStyle.fontSize as string | undefined,
        color: textStyle.color as string | undefined,
        highlight: e.getAttributes("highlight").color as string | undefined,
        link: e.isActive("link"),
        align: (["center", "right", "justify"] as const).find((a) => e.isActive({ textAlign: a })) ?? "left",
        bulletList: e.isActive("bulletList"),
        orderedList: e.isActive("orderedList"),
        taskList: e.isActive("taskList"),
        inTable: e.isActive("table"),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      } satisfies FormattingState;
    },
  });
}
