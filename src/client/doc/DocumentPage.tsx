import { ArrowLeft, CloudOff, LoaderCircle } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { DEFAULT_TITLE, SETTINGS_KEYS, SETTINGS_MAP } from "../../shared/doc-schema";
import { LIMITS, type DocumentSummary, type Member } from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import { ApiRequestError, api } from "../api";
import { useCollaboration, type Collaboration, type Presence } from "../collab/useCollaboration";
import { DocumentEditor } from "./DocumentEditor";
import { TITLE_INPUT_ID } from "./MenuBar";
import { timeAgo } from "../lib/time";
import { navigate } from "../router";

export function DocumentPage({ docId, member, onSessionEnded }: { docId: string; member: Member; onSessionEnded: () => void }) {
  const [summary, setSummary] = useState<DocumentSummary | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    api<DocumentSummary>(`/api/docs/${docId}`)
      .then(setSummary)
      .catch((error) => {
        if (error instanceof ApiRequestError && error.status === 401) onSessionEnded();
        else setMissing(true);
      });
  }, [docId, onSessionEnded]);

  if (missing) return <Gone title="Document not found" message="It may have been deleted." />;
  if (!summary) return <Loading />;
  return <OpenDocument key={docId} docId={docId} member={member} initialTitle={summary.title} onSessionEnded={onSessionEnded} />;
}

function OpenDocument(props: { docId: string; member: Member; initialTitle: string; onSessionEnded: () => void }) {
  const collab = useCollaboration(props.docId, props.member);
  const [notice, setNotice] = useState<string | null>(null);
  const { onSessionEnded } = props;
  const ended = collab?.ended;

  useEffect(() => {
    if (ended === "session-expired") onSessionEnded();
  }, [ended, onSessionEnded]);

  if (!collab) return <Loading />;
  if (collab.ended === "document-deleted") {
    return <Gone title="This document was deleted" message="Someone deleted it while it was open." />;
  }

  // Keep the editor mounted through reconnects: Yjs keeps local edits and sends them when the
  // socket is back. Unmounting would drop keystrokes and focus.
  if (!collab.everSynced && collab.connection !== "offline") return <Loading />;

  const titleBar = (
    <>
      <div className="flex items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="All documents" title="All documents" onClick={() => navigate("/")}>
          <ArrowLeft />
        </Button>
        <TitleField collab={collab} fallback={props.initialTitle} />
        <span className="hidden md:inline">
          <SaveIndicator collab={collab} />
        </span>
        <div className="ml-auto flex items-center gap-2">
          <PresenceAvatars people={collab.presence} />
        </div>
      </div>
      {(collab.notice || notice) && (
        <p role="status" className="mt-1 rounded-md bg-amber-50 px-3 py-1.5 text-sm text-amber-900">
          {collab.notice ?? notice}
        </p>
      )}
    </>
  );

  return <DocumentEditor collab={collab} titleBar={titleBar} onError={setNotice} />;
}

/** The title lives in the Yjs document, so both people see renames as they type. */
function TitleField({ collab, fallback }: { collab: Collaboration; fallback: string }) {
  const settings = collab.doc.getMap(SETTINGS_MAP);
  const title = useSyncExternalStore(
    (onChange) => {
      settings.observe(onChange);
      return () => settings.unobserve(onChange);
    },
    () => (settings.get(SETTINGS_KEYS.title) as string | undefined) ?? fallback,
  );

  useEffect(() => {
    document.title = `${title || DEFAULT_TITLE} – Colo`;
    return () => {
      document.title = "Colo";
    };
  }, [title]);

  return (
    <input
      id={TITLE_INPUT_ID}
      aria-label="Document title"
      className="min-w-0 max-w-md flex-1 rounded-md border border-transparent bg-transparent px-2 py-0.5 text-lg outline-none hover:border-border focus:border-ring"
      value={title}
      maxLength={LIMITS.titleLength}
      placeholder={DEFAULT_TITLE}
      onChange={(event) => settings.set(SETTINGS_KEYS.title, event.target.value)}
      onBlur={(event) => {
        if (!event.target.value.trim()) settings.set(SETTINGS_KEYS.title, DEFAULT_TITLE);
      }}
    />
  );
}

function SaveIndicator({ collab }: { collab: Collaboration }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  let text: string;
  if (collab.connection === "offline") text = "Offline — changes will sync when reconnected";
  else if (collab.connection === "paused") text = "Paused while the tab was hidden";
  else if (collab.connection === "connecting") text = "Connecting…";
  else if (collab.save === "saving") text = "Saving…";
  else if (collab.savedAt) text = `All changes saved · ${timeAgo(collab.savedAt)}`;
  else text = "All changes saved";

  return (
    <span data-testid="save-status" className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">
      {collab.connection === "offline" && <CloudOff className="size-4" />}
      {text}
    </span>
  );
}

function PresenceAvatars({ people }: { people: Presence[] }) {
  return (
    <ul className="flex -space-x-1.5" aria-label="People in this document">
      {people.map((person) => (
        <li key={person.clientId}>
          <span
            title={person.isSelf ? `${person.name} (you)` : person.name}
            className="flex size-8 items-center justify-center rounded-full border-2 border-background text-xs font-semibold text-white"
            style={{ backgroundColor: person.color }}
          >
            {initials(person.name)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
    </div>
  );
}

function Gone({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={() => navigate("/")}>
        Back to documents
      </Button>
    </main>
  );
}
