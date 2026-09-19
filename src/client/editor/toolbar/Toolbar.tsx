import type { Editor } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  IndentDecrease,
  IndentIncrease,
  Italic,
  MessageSquarePlus,
  List,
  ListChecks,
  ListOrdered,
  PanelLeft,
  Printer,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ColorMenu } from "./ColorMenu";
import { ToolButton, ToolSeparator, WithTooltip, shortcutLabel } from "./controls";
import { LinkControls } from "./LinkControls";
import { InsertTableButton, TableActionsMenu } from "./TableControls";
import { FontMenu, FontSizeControl, StyleMenu, ZoomMenu } from "./TextMenus";
import { useFormattingState, type Alignment } from "./useFormattingState";

const ALIGNMENTS: { value: Alignment; label: string; shortcut: string; Icon: typeof AlignLeft }[] = [
  { value: "left", label: "Left align", shortcut: "Mod-Shift-L", Icon: AlignLeft },
  { value: "center", label: "Centre align", shortcut: "Mod-Shift-E", Icon: AlignCenter },
  { value: "right", label: "Right align", shortcut: "Mod-Shift-R", Icon: AlignRight },
  { value: "justify", label: "Justify", shortcut: "Mod-Shift-J", Icon: AlignJustify },
];

export interface ToolbarProps {
  editor: Editor;
  zoom: number;
  onZoom: (zoom: number) => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  linkOpen: boolean;
  onLinkOpenChange: (open: boolean) => void;
  onAddComment: () => void;
}

/** The Google Docs-style formatting toolbar. Scrolls horizontally on narrow screens. */
export function Toolbar({ editor, zoom, onZoom, outlineOpen, onToggleOutline, linkOpen, onLinkOpenChange, onAddComment }: ToolbarProps) {
  const state = useFormattingState(editor);
  if (!state) return null;
  const chain = () => editor.chain().focus();
  const align = ALIGNMENTS.find((a) => a.value === state.align) ?? ALIGNMENTS[0];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex items-center gap-0.5 overflow-x-auto rounded-full bg-muted px-2 py-1 [scrollbar-width:none]"
    >
      <ToolButton label="Show outline" active={outlineOpen} onClick={onToggleOutline}>
        <PanelLeft />
      </ToolButton>
      <ToolSeparator />
      <ToolButton label="Undo" shortcut="Mod-Z" disabled={!state.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 />
      </ToolButton>
      <ToolButton label="Redo" shortcut="Mod-Y" disabled={!state.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 />
      </ToolButton>
      <ToolButton label="Print" shortcut="Mod-P" onClick={() => window.print()}>
        <Printer />
      </ToolButton>
      <ZoomMenu zoom={zoom} onZoom={onZoom} />
      <ToolSeparator />
      <StyleMenu editor={editor} heading={state.heading} />
      <ToolSeparator />
      <FontMenu editor={editor} fontFamily={state.fontFamily} />
      <ToolSeparator />
      <FontSizeControl editor={editor} fontSize={state.fontSize} />
      <ToolSeparator />
      <ToolButton label="Bold" shortcut="Mod-B" active={state.bold} onClick={() => chain().toggleBold().run()}>
        <Bold />
      </ToolButton>
      <ToolButton label="Italic" shortcut="Mod-I" active={state.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic />
      </ToolButton>
      <ToolButton label="Underline" shortcut="Mod-U" active={state.underline} onClick={() => chain().toggleUnderline().run()}>
        <Underline />
      </ToolButton>
      <ToolButton label="Strikethrough" shortcut="Mod-Shift-S" active={state.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough />
      </ToolButton>
      <ColorMenu editor={editor} kind="text" value={state.color} />
      <ColorMenu editor={editor} kind="highlight" value={state.highlight} />
      <ToolSeparator />
      <LinkControls editor={editor} active={state.link} open={linkOpen} onOpenChange={onLinkOpenChange} />
      <ToolButton label="Add comment" shortcut="Mod-Alt-M" disabled={!state.hasSelection} onClick={onAddComment}>
        <MessageSquarePlus />
      </ToolButton>
      <InsertTableButton editor={editor} />
      {state.inTable && <TableActionsMenu editor={editor} />}
      <ToolSeparator />
      <DropdownMenu modal={false}>
        <WithTooltip label="Align">
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Align" onMouseDown={(event) => event.preventDefault()}>
              <align.Icon />
            </Button>
          </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
          {ALIGNMENTS.map(({ value, label, shortcut, Icon }) => (
            <DropdownMenuItem
              key={value}
              data-active={state.align === value}
              className="data-[active=true]:bg-accent"
              onSelect={() => chain().setTextAlign(value).run()}
            >
              <Icon />
              {label}
              <DropdownMenuShortcut>{shortcutLabel(shortcut)}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolButton label="Checklist" shortcut="Mod-Shift-9" active={state.taskList} onClick={() => chain().toggleTaskList().run()}>
        <ListChecks />
      </ToolButton>
      <ToolButton label="Bulleted list" shortcut="Mod-Shift-8" active={state.bulletList} onClick={() => chain().toggleBulletList().run()}>
        <List />
      </ToolButton>
      <ToolButton label="Numbered list" shortcut="Mod-Shift-7" active={state.orderedList} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered />
      </ToolButton>
      <ToolButton label="Decrease indent" shortcut="Shift-Tab" onClick={() => chain().outdent().run()}>
        <IndentDecrease />
      </ToolButton>
      <ToolButton label="Increase indent" shortcut="Tab" onClick={() => chain().indent().run()}>
        <IndentIncrease />
      </ToolButton>
      <ToolSeparator />
      <ToolButton label="Clear formatting" shortcut="Mod-\" onClick={() => chain().clearFormatting().run()}>
        <RemoveFormatting />
      </ToolButton>
    </div>
  );
}
