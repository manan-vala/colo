import { ArrowLeft, CloudOff, LoaderCircle } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { DEFAULT_TITLE, SETTINGS_KEYS, SETTINGS_MAP } from "../../shared/doc-schema";
import { LIMITS, type DocumentSummary, type Member } from "../../shared/protocol";
import { Avatar } from "@/components/avatar";
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

  // Notices are hints ("Select some text…"); they go away by themselves.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!collab) return <Loading />;
  if (collab.ended === "document-deleted") {
    return <Gone title="This document was deleted" message="Someone deleted it while it was open." />;
  }

  // Keep the editor mounted through reconnects: Yjs keeps local edits and sends them when the
  // socket is back. Unmounting would drop keystrokes and focus.
  if (!collab.everSynced && collab.connection !== "offline") return <Loading />;

  const renderTitleBar = (actions: ReactNode) => (
    <>
      <div className="flex items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="All documents" title="All documents" onClick={() => navigate("/")}>
          <ArrowLeft />
        </Button>
        <TitleField collab={collab} fallback={props.initialTitle} />
        <SaveIndicator collab={collab} />
        <div className="ml-auto flex items-center gap-2">
          {actions}
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

  return <DocumentEditor collab={collab} member={props.member} renderTitleBar={renderTitleBar} onError={setNotice} />;
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

/**
 * Save and connection state. Phones go offline far more than laptops, so this is never hidden —
 * only shortened: the full sentence from `sm` up, a word below it, where the title bar has to
 * fit a back button, the title, the status and the avatars across 390 px.
 */
function SaveIndicator({ collab }: { collab: Collaboration }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  let text: string;
  let short: string;
  if (collab.connection === "offline") {
    text = "Offline — changes will sync when reconnected";
    short = "Offline";
  } else if (collab.connection === "paused") {
    text = "Paused while the tab was hidden";
    short = "Paused";
  } else if (collab.connection === "connecting") {
    text = short = "Connecting…";
  } else if (collab.save === "saving") {
    text = short = "Saving…";
  } else {
    text = collab.savedAt ? `All changes saved · ${timeAgo(collab.savedAt)}` : "All changes saved";
    short = "Saved";
  }

  return (
    <span
      data-testid="save-status"
      className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground"
      aria-live="polite"
      title={text}
    >
      {collab.connection === "offline" && <CloudOff className="size-4" />}
      {/* One sentence for assistive tech, whatever the screen is showing; the two visible spans
          are hidden from it so the status is not announced twice. */}
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="hidden md:inline">
        {text}
      </span>
      <span aria-hidden="true" className="md:hidden">
        {short}
      </span>
    </span>
  );
}

function PresenceAvatars({ people }: { people: Presence[] }) {
  return (
    <ul className="flex -space-x-1.5" aria-label="People in this document">
      {people.map((person) => (
        <li key={person.clientId}>
          <Avatar
            name={person.name}
            color={person.color}
            title={person.isSelf ? `${person.name} (you)` : person.name}
            className="border-2 border-background"
          />
        </li>
      ))}
    </ul>
  );
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
