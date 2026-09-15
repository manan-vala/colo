import { FileText, LoaderCircle, LogOut, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LIMITS, type DocumentSummary, type ListDocumentsResponse, type Member } from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import logo from "../assets/logo.svg";
import documentsBanner from "../assets/documents-banner.webp";
import { ApiRequestError, api } from "../api";
import { timeAgo } from "../lib/time";
import { navigate } from "../router";

export function Home({ member, onSignOut, onSessionEnded }: { member: Member; onSignOut: () => void; onSessionEnded: () => void }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiRequestError && err.status === 401) onSessionEnded();
      else setError(err instanceof Error ? err.message : "Something went wrong");
    },
    [onSessionEnded],
  );

  const load = useCallback(() => {
    api<ListDocumentsResponse>("/api/docs")
      .then((body) => setDocuments(body.documents))
      .catch(handleError);
  }, [handleError]);

  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const doc = await api<DocumentSummary>("/api/docs", { body: {} });
      navigate(`/d/${doc.id}`);
    } catch (err) {
      handleError(err);
      setCreating(false);
    }
  };

  const visible = (documents ?? []).filter((doc) => doc.title.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="min-h-svh bg-muted/40">
      <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3">
        <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <img src={logo} alt="" className="size-5" />
          Colo
        </span>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:inline">{member.displayName}</span>
          <Button variant="outline" size="sm" onClick={onSignOut}>
            <LogOut data-icon="inline-start" />
            Sign out
          </Button>
        </div>
      </header>

      <div className="h-40 w-full overflow-hidden sm:h-48">
        <img src={documentsBanner} alt="" className="size-full object-cover" />
      </div>

      <main className="mx-auto grid max-w-3xl gap-4 px-4 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-2xl font-semibold tracking-tight">Documents</h1>
          <input
            type="search"
            aria-label="Filter documents by title"
            placeholder="Filter by title"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="h-8 w-44 rounded-md border bg-background px-2.5 text-sm outline-none focus:border-ring"
          />
          <Button onClick={create} disabled={creating}>
            {creating ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
            New document
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {documents === null ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-background px-4 py-10 text-center text-muted-foreground">
            {documents.length === 0 ? "No documents yet. Create the first one." : "No documents match that filter."}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border bg-background">
            {visible.map((doc) => (
              <DocumentRow key={doc.id} doc={doc} onChanged={load} onError={handleError} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function DocumentRow({ doc, onChanged, onError }: { doc: DocumentSummary; onChanged: () => void; onError: (err: unknown) => void }) {
  const [mode, setMode] = useState<"view" | "rename" | "confirm-delete">("view");
  const [title, setTitle] = useState(doc.title);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setMode("view");
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "rename") {
    return (
      <li className="flex items-center gap-2 px-4 py-3">
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => api(`/api/docs/${doc.id}`, { method: "PATCH", body: { title } }));
          }}
        >
          <input
            autoFocus
            aria-label="New title"
            value={title}
            maxLength={LIMITS.titleLength}
            onChange={(event) => setTitle(event.target.value)}
            className="h-8 flex-1 rounded-md border px-2.5 text-sm outline-none focus:border-ring"
          />
          <Button type="submit" size="sm" disabled={busy}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <FileText className="size-5 shrink-0 text-muted-foreground" />
      <a
        href={`/d/${doc.id}`}
        className="min-w-0 flex-1"
        onClick={(event) => {
          event.preventDefault();
          navigate(`/d/${doc.id}`);
        }}
      >
        <span className="block truncate font-medium">{doc.title}</span>
        <span className="block text-sm text-muted-foreground">
          Edited {timeAgo(doc.updatedAt)} by {doc.updatedBy.displayName}
        </span>
      </a>
      {mode === "confirm-delete" ? (
        <div className="flex items-center gap-2">
          <span className="text-sm">Delete?</span>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => run(() => api(`/api/docs/${doc.id}`, { method: "DELETE" }))}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label={`Rename ${doc.title}`} title="Rename" onClick={() => setMode("rename")}>
            <Pencil />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Delete ${doc.title}`} title="Delete" onClick={() => setMode("confirm-delete")}>
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  );
}
