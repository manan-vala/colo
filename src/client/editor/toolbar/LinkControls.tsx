import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { ExternalLink, Link2, Pencil, Unlink } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { isSafeLink, normalizeLink } from "../extensions";
import { ToolButton } from "./controls";

/**
 * Toolbar button + popover for inserting or editing a link (Ctrl/⌘+K), and a bubble menu
 * shown when the cursor is inside a link, as in Google Docs.
 */
export function LinkControls({ editor, active, open, onOpenChange }: {
  editor: Editor;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectionEmpty, setSelectionEmpty] = useState(true);

  useEffect(() => {
    if (!open) return;
    editor.commands.extendMarkRange("link");
    const { from, to, empty } = editor.state.selection;
    setSelectionEmpty(empty);
    setText(empty ? "" : editor.state.doc.textBetween(from, to, " "));
    setUrl((editor.getAttributes("link").href as string | undefined) ?? "");
    setError(null);
  }, [open, editor]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    if (!isSafeLink(url)) {
      setError("Only web, email and phone links are allowed.");
      return;
    }
    const href = normalizeLink(url);
    const chain = editor.chain().focus();
    if (selectionEmpty) {
      const label = text.trim() || href;
      chain
        .insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] })
        .unsetMark("link")
        .run();
    } else {
      chain.extendMarkRange("link").setLink({ href }).run();
    }
    onOpenChange(false);
  };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverAnchor asChild>
          <span className="inline-flex">
            <ToolButton label="Insert link" shortcut="Mod-K" active={active} onClick={() => onOpenChange(true)}>
              <Link2 />
            </ToolButton>
          </span>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-80">
          <form className="grid gap-2" onSubmit={submit} aria-label="Link">
            {selectionEmpty && (
              <Input aria-label="Link text" placeholder="Text" value={text} onChange={(e) => setText(e.target.value)} />
            )}
            <Input
              autoFocus
              aria-label="Link address"
              placeholder="Paste or type a link"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!url.trim()}>
                Apply
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>

      <BubbleMenu
        editor={editor}
        pluginKey="linkBubble"
        shouldShow={({ editor: e }) => e.isActive("link") && e.state.selection.empty && !open}
        options={{ placement: "bottom-start" }}
        className="flex items-center gap-1 rounded-md border bg-popover px-2 py-1 text-sm shadow-md"
      >
        <LinkBubble editor={editor} onEdit={() => onOpenChange(true)} />
      </BubbleMenu>
    </>
  );
}

function LinkBubble({ editor, onEdit }: { editor: Editor; onEdit: () => void }) {
  const href = (editor.getAttributes("link").href as string | undefined) ?? "";
  return (
    <>
      <a
        href={isSafeLink(href) ? href : undefined}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="flex max-w-56 items-center gap-1 truncate text-[#1a73e8] hover:underline"
      >
        <ExternalLink className="size-3.5 shrink-0" />
        <span className="truncate">{href}</span>
      </a>
      <ToolButton label="Edit link" onClick={onEdit}>
        <Pencil />
      </ToolButton>
      <ToolButton label="Remove link" onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}>
        <Unlink />
      </ToolButton>
    </>
  );
}
