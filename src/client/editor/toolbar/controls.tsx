import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Formats "Mod-Shift-X" as "Ctrl+Shift+X" or "⌘⇧X". */
export function shortcutLabel(shortcut: string): string {
  const parts = shortcut.split("-");
  if (isMac) {
    return parts.map((p) => ({ Mod: "⌘", Shift: "⇧", Alt: "⌥" })[p] ?? p.toUpperCase()).join("");
  }
  return parts.map((p) => (p === "Mod" ? "Ctrl" : p.length === 1 ? p.toUpperCase() : p)).join("+");
}

export function WithTooltip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut && <span className="opacity-70">{shortcutLabel(shortcut)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

type ToolButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  label: string;
  shortcut?: string;
  active?: boolean;
};

/** Icon button for the formatting toolbar. Keeps focus in the editor when clicked. */
export function ToolButton({ label, shortcut, active, children, ...props }: ToolButtonProps) {
  return (
    <WithTooltip label={label} shortcut={shortcut}>
      <Button
        type="button"
        variant={active ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(event) => event.preventDefault()}
        {...props}
      >
        {children}
      </Button>
    </WithTooltip>
  );
}

export function ToolSeparator() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}
