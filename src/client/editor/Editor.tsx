import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Heading1, Heading2, Italic, List, ListOrdered, Redo2, Strikethrough, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { CONTENT_FIELD } from "../../shared/doc-schema";
import { Button } from "@/components/ui/button";
import type { Collaboration as CollaborationState } from "../collab/useCollaboration";

/** Collaborative Tiptap editor (M2: essential formatting; the full Docs-style toolbar is M3). */
export function Editor({ collab, readOnly }: { collab: CollaborationState; readOnly: boolean }) {
  const editor = useEditor(
    {
      // Tiptap's injected <style> would violate the CSP; its CSS ships in index.css.
      injectCSS: false,
      editable: !readOnly,
      extensions: [
        // Collaboration brings Yjs-aware undo/redo, so Tiptap's own history is disabled.
        StarterKit.configure({ undoRedo: false }),
        Placeholder.configure({ placeholder: "Start typing…" }),
        Collaboration.configure({ document: collab.doc, field: CONTENT_FIELD }),
        CollaborationCaret.configure({ provider: collab.provider, user: collab.user }),
      ],
      editorProps: { attributes: { class: "colo-editor", "aria-label": "Document" } },
    },
    [collab.doc, collab.provider],
  );

  return (
    <div className="flex flex-col">
      <Toolbar editor={editor} />
      <div className="px-2 py-6 sm:px-6">
        <div className="mx-auto min-h-[70vh] max-w-[816px] rounded-sm bg-background px-6 py-10 shadow-sm ring-1 ring-foreground/10 sm:px-16">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: TiptapEditor | null }) {
  const state = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive("bold"),
            italic: editor.isActive("italic"),
            strike: editor.isActive("strike"),
            h1: editor.isActive("heading", { level: 1 }),
            h2: editor.isActive("heading", { level: 2 }),
            bullet: editor.isActive("bulletList"),
            ordered: editor.isActive("orderedList"),
            canUndo: editor.can().undo(),
            canRedo: editor.can().redo(),
          }
        : null,
  });
  if (!editor || !state) return null;
  const chain = () => editor.chain().focus();

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b bg-background/95 px-3 py-1.5 backdrop-blur"
    >
      <Tool label="Undo" onClick={() => chain().undo().run()} disabled={!state.canUndo}>
        <Undo2 />
      </Tool>
      <Tool label="Redo" onClick={() => chain().redo().run()} disabled={!state.canRedo}>
        <Redo2 />
      </Tool>
      <span className="mx-1 h-5 w-px bg-border" />
      <Tool label="Heading 1" active={state.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()}>
        <Heading1 />
      </Tool>
      <Tool label="Heading 2" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2 />
      </Tool>
      <span className="mx-1 h-5 w-px bg-border" />
      <Tool label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}>
        <Bold />
      </Tool>
      <Tool label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic />
      </Tool>
      <Tool label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough />
      </Tool>
      <span className="mx-1 h-5 w-px bg-border" />
      <Tool label="Bulleted list" active={state.bullet} onClick={() => chain().toggleBulletList().run()}>
        <List />
      </Tool>
      <Tool label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered />
      </Tool>
    </div>
  );
}

function Tool(props: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant={props.active ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      disabled={props.disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}
