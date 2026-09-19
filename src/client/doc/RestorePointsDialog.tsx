import { History, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  LIMITS,
  type ListRestorePointsResponse,
  type RestorePoint,
  type RestorePointKind,
  type RestoreResponse,
} from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiRequestError, api } from "../api";
import { timeAgo } from "../lib/time";

const KIND_LABELS: Record<RestorePointKind, string> = {
  auto: "Automatic",
  named: "Named version",
  "pre-restore": "Before a restore",
  import: "Before an import",
};

const formatTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export interface RestorePointsDialogProps {
  docId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * File → Restore points (plan F9): save a named version, or put the document back to an earlier
 * one. Restoring changes the document for both people and keeps the current version as a
 * "Before a restore" point, so a restore can itself be undone from this list.
 */
export function RestorePointsDialog({ docId, open, onOpenChange }: RestorePointsDialogProps) {
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPoints((await api<ListRestorePointsResponse>(`/api/docs/${docId}/restore-points`)).points);
    } catch (reason) {
      setError(describe(reason));
    }
  }, [docId]);

  useEffect(() => {
    if (!open) return;
    setPoints(null);
    setConfirming(null);
    setError(null);
    void load();
  }, [open, load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    void run(async () => {
      await api<RestorePoint>(`/api/docs/${docId}/restore-points`, { body: { label: name } });
      setName("");
      await load();
    });
  };

  const restore = (point: RestorePoint) =>
    void run(async () => {
      await api<RestoreResponse>(`/api/docs/${docId}/restore-points/${point.id}/restore`, { body: {} });
      // Both people see the change and a notice saying who restored it.
      onOpenChange(false);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Restore points</DialogTitle>
          <DialogDescription>
            Colo keeps a copy before each stretch of editing. Restoring a version changes the document for everyone and
            keeps the current version here.
          </DialogDescription>
        </DialogHeader>

        <form className="flex gap-2" onSubmit={save}>
          <Input
            aria-label="Restore point name"
            placeholder="Name this version, e.g. Sent to Sam"
            value={name}
            maxLength={LIMITS.restorePointLabelLength}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={busy || !name.trim()}>
            Save version
          </Button>
        </form>

        <div className="min-h-24 overflow-y-auto">
          {error && (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {points === null ? (
            <div className="flex justify-center py-6 text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" aria-label="Loading restore points" />
            </div>
          ) : points.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No restore points yet. One is kept automatically once you have been editing for a while.
            </p>
          ) : (
            <ul aria-label="Restore points" className="divide-y">
              {points.map((point) => (
                <li key={point.id} data-point-id={point.id} className="flex items-center gap-3 py-2.5">
                  <History className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{point.label ?? KIND_LABELS[point.kind]}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <time dateTime={point.createdAt} title={timeAgo(point.createdAt)}>
                        {formatTime(point.createdAt)}
                      </time>
                      {point.label && ` · ${KIND_LABELS[point.kind]}`}
                      {point.createdBy && ` · ${point.createdBy.displayName}`}
                    </p>
                  </div>
                  {confirming === point.id ? (
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => restore(point)}>
                        Confirm restore
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(point.id)}>
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function describe(reason: unknown): string {
  if (reason instanceof ApiRequestError) {
    if (reason.status === 401) return "You were signed out. Sign in again to use restore points.";
    if (reason.status === 404) return "That restore point no longer exists.";
    return reason.message;
  }
  return "Restore points could not be reached. Check your connection and try again.";
}
