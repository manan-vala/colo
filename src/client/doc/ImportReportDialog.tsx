import { CircleCheck, CircleMinus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ImportNote } from "../convert/model";

export interface ImportReport {
  fileName: string;
  notes: ImportNote[];
  /** True when the file replaced an existing document (its old version is a restore point). */
  replaced: boolean;
}

/**
 * Shown after an import: what came across in another form and what was left out, so nothing is
 * lost silently. Files that converted completely say so.
 */
export function ImportReportDialog({ report, onClose }: { report: ImportReport | null; onClose: () => void }) {
  const converted = report?.notes.filter((note) => note.kind === "converted") ?? [];
  const dropped = report?.notes.filter((note) => note.kind === "dropped") ?? [];
  return (
    <Dialog open={report !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Imported “{report?.fileName}”</DialogTitle>
          <DialogDescription>
            {report?.notes.length ? "Most of the file came across. A few things were changed or left out:" : "Everything in the file came across."}
          </DialogDescription>
        </DialogHeader>
        {converted.length > 0 && <NoteList title="Changed to fit Colo" icon={<RefreshCw className="size-4 text-muted-foreground" />} notes={converted} />}
        {dropped.length > 0 && <NoteList title="Left out" icon={<CircleMinus className="size-4 text-muted-foreground" />} notes={dropped} />}
        {report?.replaced && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <CircleCheck className="mt-0.5 size-4 shrink-0" />
            The previous version is saved in File → Restore points.
          </p>
        )}
        <DialogFooter>
          <Button onClick={onClose}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoteList({ title, icon, notes }: { title: string; icon: React.ReactNode; notes: ImportNote[] }) {
  return (
    <section aria-label={title} className="grid gap-1.5">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </h3>
      <ul className="grid gap-1 pl-6 text-sm text-muted-foreground">
        {notes.map((note) => (
          <li key={note.message}>
            {note.message}
            {note.count > 1 && <span className="tabular-nums"> ({note.count})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
