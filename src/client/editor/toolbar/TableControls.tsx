import type { Editor } from "@tiptap/react";
import { Table2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WithTooltip } from "./controls";

const GRID = 8;

/** The size a grid cell stands for, from the element under a finger; null for anything else. */
function sizeOf(element: Element | null): { rows: number; cols: number } | null {
  const cell = element?.closest<HTMLElement>("[data-rows]");
  if (!cell) return null;
  return { rows: Number(cell.dataset.rows), cols: Number(cell.dataset.cols) };
}

export function insertTable(editor: Editor, rows: number, cols: number) {
  editor.chain().focus().insertTable({ rows, cols, withHeaderRow: false }).run();
}

/** Google Docs-style grid picker for inserting a table. */
export function TableGridPicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState({ rows: 1, cols: 1 });
  /** A touch that already picked on lifting; the click that follows it must not pick again. */
  const picked = useRef(false);
  /** The size a finger is over. `pointerup` from a touch carries no useful coordinates. */
  const touching = useRef<{ rows: number; cols: number } | null>(null);
  return (
    <div className="grid gap-2">
      <div
        role="grid"
        aria-label="Table size"
        // touch-none: without it the browser reads a finger dragged across the grid as a pan,
        // takes the gesture over and sends `pointercancel` — the drag never finishes.
        className="grid touch-none gap-0.5"
        style={{ gridTemplateColumns: `repeat(${GRID}, 1.1rem)` }}
        // A touch pointer is captured by the cell it went down on, so no other cell ever sees
        // `pointerenter` and the preview would stay where the finger landed. Releasing the
        // capture and reading the cell under the finger makes dragging out a size work as it
        // does with a mouse.
        onPointerDown={(event) => {
          picked.current = false;
          if (event.pointerType === "mouse") return;
          // The implicit capture belongs to the cell the finger went down on, not to the grid.
          const cell = event.target as Element;
          if (cell.hasPointerCapture?.(event.pointerId)) cell.releasePointerCapture(event.pointerId);
          touching.current = sizeOf(cell);
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "mouse" || event.buttons === 0) return;
          const size = sizeOf(document.elementFromPoint(event.clientX, event.clientY));
          if (!size) return;
          touching.current = size;
          setHover(size);
        }}
        // Lifting picks the size the finger ended on. The click that follows a touch lands on
        // the cell the finger went *down* on, which is the wrong one after a drag.
        onPointerUp={(event) => {
          if (event.pointerType === "mouse") return;
          const size = touching.current;
          touching.current = null;
          if (!size) return;
          picked.current = true;
          onPick(size.rows, size.cols);
        }}
      >
        {Array.from({ length: GRID * GRID }, (_, index) => {
          const rows = Math.floor(index / GRID) + 1;
          const cols = (index % GRID) + 1;
          const selected = rows <= hover.rows && cols <= hover.cols;
          return (
            <button
              key={index}
              type="button"
              aria-label={`${rows} by ${cols}`}
              data-selected={selected}
              data-rows={rows}
              data-cols={cols}
              className="size-4 rounded-[2px] border border-foreground/20 data-[selected=true]:border-primary data-[selected=true]:bg-primary/20"
              // Pointer events, not mouse: on a touch screen onMouseEnter never fires, so the
              // highlight and the "N × M" label below never lit up at all. Dragging from here
              // to another cell is the grid's job, above.
              onPointerEnter={() => setHover({ rows, cols })}
              onPointerDown={() => setHover({ rows, cols })}
              onFocus={() => setHover({ rows, cols })}
              onClick={() => {
                // The lift already picked (possibly a different cell, if the finger moved).
                if (picked.current) return;
                onPick(rows, cols);
              }}
            />
          );
        })}
      </div>
      <p className="text-center text-sm text-muted-foreground tabular-nums">
        {hover.cols} × {hover.rows}
      </p>
    </div>
  );
}

export function InsertTableButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WithTooltip label="Insert table">
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Insert table" onMouseDown={(event) => event.preventDefault()}>
            <Table2 />
          </Button>
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent className="w-auto p-3" align="start" onOpenAutoFocus={(event) => event.preventDefault()}>
        <TableGridPicker
          onPick={(rows, cols) => {
            insertTable(editor, rows, cols);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Shown in the toolbar while the cursor is inside a table. */
export function TableActionsMenu({ editor }: { editor: Editor }) {
  const run = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => command(editor.chain().focus()).run();
  const can = editor.can();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="secondary" size="sm" className="shrink-0" onMouseDown={(event) => event.preventDefault()}>
          <Table2 data-icon="inline-start" />
          Table
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuItem onSelect={() => run((c) => c.addRowBefore())}>Insert row above</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((c) => c.addRowAfter())}>Insert row below</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((c) => c.addColumnBefore())}>Insert column left</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((c) => c.addColumnAfter())}>Insert column right</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!can.mergeCells()} onSelect={() => run((c) => c.mergeCells())}>
          Merge cells
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!can.splitCell()} onSelect={() => run((c) => c.splitCell())}>
          Unmerge cells
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((c) => c.toggleHeaderRow())}>Toggle header row</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run((c) => c.deleteRow())}>Delete row</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((c) => c.deleteColumn())}>Delete column</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => run((c) => c.deleteTable())}>
          Delete table
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
