import { useState, type FormEvent } from "react";
import {
  HEADER_FOOTER_MAX_LENGTH,
  MARGIN_LIMITS,
  MIN_CONTENT_MM,
  PAGE_SIZES,
  fitsPage,
  type HeaderFooterText,
  type PageMargins,
  type PageSettings,
  type PageSizeName,
} from "../../shared/doc-schema";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";

const MARGIN_FIELDS: { key: keyof PageMargins; label: string }[] = [
  { key: "top", label: "Top" },
  { key: "bottom", label: "Bottom" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
];

/**
 * File → Page setup: paper, orientation, margins, header and footer text, and pages versus a
 * continuous document. Settings are shared with everyone in the document.
 */
export function PageSetupDialog({ open, onOpenChange, settings, onApply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: PageSettings;
  onApply: (settings: PageSettings) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        {/* Remounted on every open so the form starts from the current settings. */}
        {open && <PageSetupForm settings={settings} onCancel={() => onOpenChange(false)} onApply={onApply} />}
      </DialogContent>
    </Dialog>
  );
}

function PageSetupForm({ settings, onCancel, onApply }: {
  settings: PageSettings;
  onCancel: () => void;
  onApply: (settings: PageSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [margins, setMargins] = useState(() => mapMargins(settings.margins, String));

  const parsedMargins = parseMargins(margins);
  const fits = parsedMargins !== null && fitsPage({ ...draft, margins: parsedMargins });
  const error =
    parsedMargins === null
      ? `Margins must be between ${MARGIN_LIMITS.min} and ${MARGIN_LIMITS.max} mm.`
      : !fits
        ? `Margins must leave at least ${MIN_CONTENT_MM / 10} cm of text area in each direction.`
        : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (parsedMargins && fits) onApply({ ...draft, margins: parsedMargins });
  };
  const setText = (part: "header" | "footer", side: keyof HeaderFooterText, value: string) =>
    setDraft((d) => ({ ...d, [part]: { ...d[part], [side]: value } }));

  return (
    <form onSubmit={submit} className="grid gap-5" aria-label="Page setup">
      <DialogHeader>
        <DialogTitle>Page setup</DialogTitle>
        <DialogDescription>Applies to everyone editing this document.</DialogDescription>
      </DialogHeader>

      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="page-setup-pages" className="grid gap-0.5">
          Pages
          <span className="text-xs font-normal text-muted-foreground">Off shows one continuous page.</span>
        </Label>
        <Switch id="page-setup-pages" checked={draft.pagination} onCheckedChange={(pagination) => setDraft((d) => ({ ...d, pagination }))} />
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Paper size</legend>
        <RadioGroup value={draft.pageSize} onValueChange={(value) => setDraft((d) => ({ ...d, pageSize: value as PageSizeName }))}>
          {(Object.keys(PAGE_SIZES) as PageSizeName[]).map((size) => (
            <Label key={size} className="font-normal">
              <RadioGroupItem value={size} />
              {PAGE_SIZES[size].label}
            </Label>
          ))}
        </RadioGroup>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Orientation</legend>
        <RadioGroup
          className="flex gap-6"
          value={draft.orientation}
          onValueChange={(value) => setDraft((d) => ({ ...d, orientation: value as PageSettings["orientation"] }))}
        >
          <Label className="font-normal">
            <RadioGroupItem value="portrait" />
            Portrait
          </Label>
          <Label className="font-normal">
            <RadioGroupItem value="landscape" />
            Landscape
          </Label>
        </RadioGroup>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Margins (mm)</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {MARGIN_FIELDS.map(({ key, label }) => (
            <Label key={key} className="grid gap-1 font-normal">
              {label}
              <Input
                type="number"
                inputMode="decimal"
                min={MARGIN_LIMITS.min}
                max={MARGIN_LIMITS.max}
                step="0.1"
                value={margins[key]}
                onChange={(event) => setMargins((m) => ({ ...m, [key]: event.target.value }))}
              />
            </Label>
          ))}
        </div>
      </fieldset>

      {(["header", "footer"] as const).map((part) => (
        <fieldset key={part} className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{part === "header" ? "Header" : "Footer"}</legend>
          <div className="grid grid-cols-2 gap-3">
            {(["left", "right"] as const).map((side) => (
              <Label key={side} className="grid gap-1 font-normal">
                {side === "left" ? "Left" : "Right"}
                <Input
                  value={draft[part][side]}
                  maxLength={HEADER_FOOTER_MAX_LENGTH}
                  placeholder={part === "footer" && side === "right" ? "Page {page} of {total}" : ""}
                  onChange={(event) => setText(part, side, event.target.value)}
                />
              </Label>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="-mt-3 text-xs text-muted-foreground">
        Type <code>{"{page}"}</code> for the page number and <code>{"{total}"}</code> for the number of pages.
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={error !== null}>
          OK
        </Button>
      </DialogFooter>
    </form>
  );
}

function mapMargins<T>(margins: PageMargins, map: (value: number) => T): Record<keyof PageMargins, T> {
  return { top: map(margins.top), bottom: map(margins.bottom), left: map(margins.left), right: map(margins.right) };
}

function parseMargins(values: Record<keyof PageMargins, string>): PageMargins | null {
  const margins: PageMargins = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const { key } of MARGIN_FIELDS) {
    const value = Number(values[key]);
    if (values[key].trim() === "" || !Number.isFinite(value) || value < MARGIN_LIMITS.min || value > MARGIN_LIMITS.max) return null;
    margins[key] = Math.round(value * 10) / 10;
  }
  return margins;
}
