import type { Editor } from "@tiptap/react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEFAULT_FONT_SIZE, DOCUMENT_FONTS, FONT_SIZES, fontLabel, parsePoints } from "../fonts";
import { WithTooltip } from "./controls";

export const PARAGRAPH_STYLES = [
  { level: 0, label: "Normal text", className: "text-sm" },
  { level: 1, label: "Heading 1", className: "text-xl font-semibold" },
  { level: 2, label: "Heading 2", className: "text-lg font-semibold" },
  { level: 3, label: "Heading 3", className: "text-base font-semibold" },
  { level: 4, label: "Heading 4", className: "text-sm font-semibold" },
] as const;

export function applyParagraphStyle(editor: Editor, level: number) {
  const chain = editor.chain().focus();
  if (level === 0) chain.setParagraph().run();
  else chain.setHeading({ level: level as 1 | 2 | 3 | 4 }).run();
}

function MenuTrigger({ label, tooltip, width }: { label: string; tooltip: string; width: string }) {
  return (
    <WithTooltip label={tooltip}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={tooltip}
          className={`${width} shrink-0 justify-between gap-1 px-2 font-normal`}
          onMouseDown={(event) => event.preventDefault()}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
    </WithTooltip>
  );
}

export function StyleMenu({ editor, heading }: { editor: Editor; heading: number }) {
  const current = PARAGRAPH_STYLES.find((style) => style.level === heading) ?? PARAGRAPH_STYLES[0];
  return (
    <DropdownMenu modal={false}>
      <MenuTrigger label={current.label} tooltip="Styles" width="w-32" />
      <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuRadioGroup value={String(heading)} onValueChange={(value) => applyParagraphStyle(editor, Number(value))}>
          {PARAGRAPH_STYLES.map((style) => (
            <DropdownMenuRadioItem key={style.level} value={String(style.level)} className={style.className}>
              {style.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FontMenu({ editor, fontFamily }: { editor: Editor; fontFamily: string | undefined }) {
  return (
    <DropdownMenu modal={false}>
      <MenuTrigger label={fontLabel(fontFamily)} tooltip="Font" width="w-36" />
      <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuRadioGroup
          value={fontFamily ?? DOCUMENT_FONTS[0].family}
          onValueChange={(family) => editor.chain().focus().setFontFamily(family).run()}
        >
          {DOCUMENT_FONTS.map((font) => (
            <DropdownMenuRadioItem
              key={font.label}
              value={font.family}
              style={{ fontFamily: font.family }}
            >
              {font.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FontSizeControl({ editor, fontSize }: { editor: Editor; fontSize: string | undefined }) {
  const points = parsePoints(fontSize);
  const setSize = (size: number) =>
    size === DEFAULT_FONT_SIZE
      ? editor.chain().focus().unsetFontSize().run()
      : editor.chain().focus().setFontSize(`${size}pt`).run();
  const smaller = [...FONT_SIZES].reverse().find((size) => size < points);
  const larger = FONT_SIZES.find((size) => size > points);

  return (
    <div className="flex shrink-0 items-center">
      <WithTooltip label="Decrease font size" shortcut="Mod-Shift-,">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Decrease font size"
          disabled={smaller === undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => smaller !== undefined && setSize(smaller)}
        >
          <Minus />
        </Button>
      </WithTooltip>
      <DropdownMenu modal={false}>
        <WithTooltip label="Font size">
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Font size"
              className="w-10 justify-center px-1 font-normal tabular-nums"
              onMouseDown={(event) => event.preventDefault()}
            >
              {points}
            </Button>
          </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent align="center" className="min-w-16" onCloseAutoFocus={(event) => event.preventDefault()}>
          {FONT_SIZES.map((size) => (
            <DropdownMenuItem key={size} onSelect={() => setSize(size)} className="justify-center tabular-nums">
              {size}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <WithTooltip label="Increase font size" shortcut="Mod-Shift-.">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Increase font size"
          disabled={larger === undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => larger !== undefined && setSize(larger)}
        >
          <Plus />
        </Button>
      </WithTooltip>
    </div>
  );
}

export const ZOOM_LEVELS = [50, 75, 90, 100, 125, 150, 200];

export function ZoomMenu({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }) {
  return (
    <DropdownMenu modal={false}>
      <MenuTrigger label={`${zoom}%`} tooltip="Zoom" width="w-20" />
      <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuRadioGroup value={String(zoom)} onValueChange={(value) => onZoom(Number(value))}>
          {ZOOM_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={String(level)}>
              {level}%
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
