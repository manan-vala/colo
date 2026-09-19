import type { Editor } from "@tiptap/react";
import { Baseline, Highlighter, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WithTooltip } from "./controls";

/** A compact Google Docs-like palette: greys, then vivid colours and two lighter/darker rows. */
export const PALETTE = [
  ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff"],
  ["#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff"],
  ["#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc", "#e6b8af"],
  ["#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0", "#dd7e6b"],
  ["#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#1155cc", "#0b5394", "#351c75", "#741b47", "#85200c"],
];

type Kind = "text" | "highlight";

export function ColorMenu({ editor, kind, value }: { editor: Editor; kind: Kind; value: string | undefined }) {
  const [open, setOpen] = useState(false);
  const label = kind === "text" ? "Text colour" : "Highlight colour";
  const Icon = kind === "text" ? Baseline : Highlighter;

  const apply = (color: string | null) => {
    const chain = editor.chain().focus();
    if (kind === "text") (color ? chain.setColor(color) : chain.unsetColor()).run();
    else (color ? chain.setHighlight({ color }) : chain.unsetHighlight()).run();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WithTooltip label={label}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="relative flex-col gap-0"
            onMouseDown={(event) => event.preventDefault()}
          >
            <Icon className="size-4" />
            <span
              aria-hidden
              className="absolute bottom-1 left-1.5 right-1.5 h-0.5 rounded-full"
              style={{ backgroundColor: value ?? (kind === "text" ? "#000000" : "transparent") }}
            />
          </Button>
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent className="w-auto p-2" align="start" onOpenAutoFocus={(event) => event.preventDefault()}>
        <Button type="button" variant="ghost" size="sm" className="mb-1 w-full justify-start" onClick={() => apply(null)}>
          <X data-icon="inline-start" />
          {kind === "text" ? "Reset colour" : "None"}
        </Button>
        <div role="listbox" aria-label={label} className="grid grid-cols-10 gap-1">
          {PALETTE.flat().map((color) => (
            <button
              key={color}
              type="button"
              role="option"
              aria-selected={value?.toLowerCase() === color}
              aria-label={color}
              title={color}
              className="size-5 rounded-sm ring-1 ring-foreground/15 hover:scale-110 aria-selected:ring-2 aria-selected:ring-primary"
              style={{ backgroundColor: color }}
              onClick={() => apply(color)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
