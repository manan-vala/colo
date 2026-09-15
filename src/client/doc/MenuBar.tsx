import type { Editor } from "@tiptap/react";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar";
import type { DocumentSummary } from "../../shared/protocol";
import { api } from "../api";
import { shortcutLabel } from "../editor/toolbar/controls";
import { TableGridPicker, insertTable } from "../editor/toolbar/TableControls";
import { PARAGRAPH_STYLES, ZOOM_LEVELS, applyParagraphStyle } from "../editor/toolbar/TextMenus";
import { useFormattingState } from "../editor/toolbar/useFormattingState";
import { navigate } from "../router";

export const TITLE_INPUT_ID = "document-title";

export interface MenuBarProps {
  editor: Editor;
  zoom: number;
  onZoom: (zoom: number) => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  onInsertLink: () => void;
  onError: (message: string) => void;
}

/** Menu commands focus the editor; stop Radix from moving focus back to the menu trigger. */
const keepEditorFocus = (event: Event) => event.preventDefault();

function Shortcut({ keys }: { keys: string }) {
  return <MenubarShortcut>{shortcutLabel(keys)}</MenubarShortcut>;
}

/** File / Edit / View / Insert / Format, as in Google Docs. Later milestones add items. */
export function MenuBar({ editor, zoom, onZoom, outlineOpen, onToggleOutline, onInsertLink, onError }: MenuBarProps) {
  const state = useFormattingState(editor);
  if (!state) return null;
  const chain = () => editor.chain().focus();

  const newDocument = async () => {
    try {
      const doc = await api<DocumentSummary>("/api/docs", { body: {} });
      navigate(`/d/${doc.id}`);
    } catch {
      onError("Could not create a document.");
    }
  };

  return (
    <Menubar className="h-auto border-none bg-transparent p-0 shadow-none">
      <MenubarMenu>
        <MenubarTrigger className="px-2 py-0.5 font-normal">File</MenubarTrigger>
        <MenubarContent onCloseAutoFocus={keepEditorFocus}>
          <MenubarItem onSelect={newDocument}>New document</MenubarItem>
          <MenubarItem
            onSelect={() => {
              const input = document.getElementById(TITLE_INPUT_ID) as HTMLInputElement | null;
              setTimeout(() => input?.select(), 0);
            }}
          >
            Rename
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => navigate("/")}>All documents</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className="px-2 py-0.5 font-normal">Edit</MenubarTrigger>
        <MenubarContent onCloseAutoFocus={keepEditorFocus}>
          <MenubarItem disabled={!state.canUndo} onSelect={() => chain().undo().run()}>
            Undo <Shortcut keys="Mod-Z" />
          </MenubarItem>
          <MenubarItem disabled={!state.canRedo} onSelect={() => chain().redo().run()}>
            Redo <Shortcut keys="Mod-Y" />
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => chain().selectAll().run()}>
            Select all <Shortcut keys="Mod-A" />
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className="px-2 py-0.5 font-normal">View</MenubarTrigger>
        <MenubarContent onCloseAutoFocus={keepEditorFocus}>
          <MenubarCheckboxItem checked={outlineOpen} onCheckedChange={onToggleOutline}>
            Show outline
          </MenubarCheckboxItem>
          <MenubarSub>
            <MenubarSubTrigger>Zoom</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarRadioGroup value={String(zoom)} onValueChange={(value) => onZoom(Number(value))}>
                {ZOOM_LEVELS.map((level) => (
                  <MenubarRadioItem key={level} value={String(level)}>
                    {level}%
                  </MenubarRadioItem>
                ))}
              </MenubarRadioGroup>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className="px-2 py-0.5 font-normal">Insert</MenubarTrigger>
        <MenubarContent onCloseAutoFocus={keepEditorFocus}>
          <MenubarItem onSelect={onInsertLink}>
            Link <Shortcut keys="Mod-K" />
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger>Table</MenubarSubTrigger>
            <MenubarSubContent className="p-3">
              <TableGridPicker onPick={(rows, cols) => insertTable(editor, rows, cols)} />
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem onSelect={() => chain().toggleTaskList().run()}>Checklist</MenubarItem>
          <MenubarItem onSelect={() => chain().setHorizontalRule().run()}>Horizontal line</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger className="px-2 py-0.5 font-normal">Format</MenubarTrigger>
        <MenubarContent onCloseAutoFocus={keepEditorFocus}>
          <MenubarSub>
            <MenubarSubTrigger>Text</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarCheckboxItem checked={state.bold} onCheckedChange={() => chain().toggleBold().run()}>
                Bold <Shortcut keys="Mod-B" />
              </MenubarCheckboxItem>
              <MenubarCheckboxItem checked={state.italic} onCheckedChange={() => chain().toggleItalic().run()}>
                Italic <Shortcut keys="Mod-I" />
              </MenubarCheckboxItem>
              <MenubarCheckboxItem checked={state.underline} onCheckedChange={() => chain().toggleUnderline().run()}>
                Underline <Shortcut keys="Mod-U" />
              </MenubarCheckboxItem>
              <MenubarCheckboxItem checked={state.strike} onCheckedChange={() => chain().toggleStrike().run()}>
                Strikethrough <Shortcut keys="Mod-Shift-S" />
              </MenubarCheckboxItem>
              <MenubarSeparator />
              <MenubarCheckboxItem checked={state.superscript} onCheckedChange={() => chain().toggleSuperscript().run()}>
                Superscript <Shortcut keys="Mod-." />
              </MenubarCheckboxItem>
              <MenubarCheckboxItem checked={state.subscript} onCheckedChange={() => chain().toggleSubscript().run()}>
                Subscript <Shortcut keys="Mod-," />
              </MenubarCheckboxItem>
              <MenubarSeparator />
              <MenubarItem onSelect={() => chain().stepFontSize(1).run()}>
                Increase font size <Shortcut keys="Mod-Shift-." />
              </MenubarItem>
              <MenubarItem onSelect={() => chain().stepFontSize(-1).run()}>
                Decrease font size <Shortcut keys="Mod-Shift-," />
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger>Paragraph styles</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarRadioGroup value={String(state.heading)} onValueChange={(value) => applyParagraphStyle(editor, Number(value))}>
                {PARAGRAPH_STYLES.map((style) => (
                  <MenubarRadioItem key={style.level} value={String(style.level)}>
                    {style.label}
                  </MenubarRadioItem>
                ))}
              </MenubarRadioGroup>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger>Align &amp; indent</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarRadioGroup value={state.align} onValueChange={(value) => chain().setTextAlign(value).run()}>
                <MenubarRadioItem value="left">
                  Left <Shortcut keys="Mod-Shift-L" />
                </MenubarRadioItem>
                <MenubarRadioItem value="center">
                  Centre <Shortcut keys="Mod-Shift-E" />
                </MenubarRadioItem>
                <MenubarRadioItem value="right">
                  Right <Shortcut keys="Mod-Shift-R" />
                </MenubarRadioItem>
                <MenubarRadioItem value="justify">
                  Justified <Shortcut keys="Mod-Shift-J" />
                </MenubarRadioItem>
              </MenubarRadioGroup>
              <MenubarSeparator />
              <MenubarItem onSelect={() => chain().indent().run()}>Increase indent</MenubarItem>
              <MenubarItem onSelect={() => chain().outdent().run()}>Decrease indent</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger>Bullets &amp; numbering</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarCheckboxItem checked={state.bulletList} onCheckedChange={() => chain().toggleBulletList().run()}>
                Bulleted list <Shortcut keys="Mod-Shift-8" />
              </MenubarCheckboxItem>
              <MenubarCheckboxItem checked={state.orderedList} onCheckedChange={() => chain().toggleOrderedList().run()}>
                Numbered list <Shortcut keys="Mod-Shift-7" />
              </MenubarCheckboxItem>
              <MenubarCheckboxItem checked={state.taskList} onCheckedChange={() => chain().toggleTaskList().run()}>
                Checklist <Shortcut keys="Mod-Shift-9" />
              </MenubarCheckboxItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem onSelect={() => chain().clearFormatting().run()}>
            Clear formatting <Shortcut keys="Mod-\" />
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
