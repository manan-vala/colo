import { cn } from "cn";

/** Up to two initials: "Alex Smith" → "AS". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/** A coloured circle with a person's initials (presence list, comments). */
export function Avatar({ name, color, className, title }: { name: string; color: string; className?: string; title?: string }) {
  return (
    <span
      title={title ?? name}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white", className)}
      style={{ backgroundColor: color }}
    >
      {initials(name) || "?"}
    </span>
  );
}
