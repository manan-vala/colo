import { useEffect, useState } from "react";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import { CLOSE_CODES, type ControlEvent, type Member, memberColor } from "../../shared/protocol";

/** How long a hidden tab stays connected before it disconnects (plan §9.3). */
export const HIDDEN_DISCONNECT_MS = 5 * 60_000;
/** How long a passing notice (a reconnect, a restore) stays on screen. */
const NOTICE_MS = 8000;

export type ConnectionStatus = "connecting" | "connected" | "offline" | "paused";
export type SaveStatus = "idle" | "saving" | "saved";
export type EndReason = "session-expired" | "document-deleted" | null;

export interface Presence {
  clientId: number;
  name: string;
  color: string;
  isSelf: boolean;
}

export interface Collaboration {
  docId: string;
  doc: Y.Doc;
  provider: YProvider;
  user: { name: string; color: string };
  connection: ConnectionStatus;
  save: SaveStatus;
  savedAt: Date | null;
  synced: boolean;
  /** True once the first sync completed; stays true through reconnects so the editor stays mounted. */
  everSynced: boolean;
  presence: Presence[];
  ended: EndReason;
  notice: string | null;
}

type Status = Omit<Collaboration, "docId" | "doc" | "provider" | "user">;

const INITIAL_STATUS: Status = {
  connection: "connecting",
  save: "idle",
  savedAt: null,
  synced: false,
  everSynced: false,
  presence: [],
  ended: null,
  notice: null,
};

/**
 * One Yjs document + provider per mounted document page, with status, presence and lifecycle
 * rules. Both are created inside the effect so a remount (including React StrictMode's double
 * effects) never reuses a destroyed provider. Returns null until they exist.
 */
export function useCollaboration(docId: string, member: Member): Collaboration | null {
  const [session, setSession] = useState<{ doc: Y.Doc; provider: YProvider } | null>(null);
  const [status, setStatus] = useState<Status>(INITIAL_STATUS);
  const { id: memberId, displayName } = member;

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new YProvider(location.host, docId, doc, {
      prefix: `/api/docs/${docId}/ws`,
      protocol: location.protocol === "https:" ? "wss" : "ws",
      maxBackoffTime: 30_000,
      connect: false,
    });
    // Deferred: Yjs and awareness events can fire while the editor component is rendering
    // (Tiptap creates the editor during render), and React forbids updating a parent then.
    const update = (patch: Partial<Status>) =>
      queueMicrotask(() => setStatus((current) => ({ ...current, ...patch })));

    let lastLocalEdit = 0;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    /** Shows a notice; unless it is sticky (the document is read-only), it clears itself. */
    const showNotice = (notice: string, sticky = false) => {
      clearTimeout(noticeTimer);
      update({ notice });
      if (!sticky) noticeTimer = setTimeout(() => update({ notice: null }), NOTICE_MS);
    };
    let paused = false;

    const onStatus = ({ status }: { status: string }) => {
      if (paused) return;
      update({ connection: status === "connected" ? "connected" : status === "connecting" ? "connecting" : "offline" });
    };
    const onSync = (synced: boolean) => update(synced ? { synced, everSynced: true } : { synced });
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === provider) return;
      lastLocalEdit = Date.now();
      update({ save: "saving" });
    };
    const onCustom = (raw: string) => {
      let event: ControlEvent;
      try {
        event = JSON.parse(raw) as ControlEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case "saved":
          // A save only covers edits the server had received; very recent edits trigger another save.
          update(Date.now() - lastLocalEdit > 250 ? { save: "saved", savedAt: new Date(event.at) } : { savedAt: new Date(event.at) });
          break;
        case "session-expired":
        case "document-deleted":
          provider.shouldConnect = false;
          update({ ended: event.type });
          break;
        case "limit":
          if (event.code === "DOCUMENT_TOO_LARGE") showNotice("This document has reached its size limit and is now read-only.", true);
          else showNotice("Connection reset by the server; reconnecting.");
          break;
      }
    };
    const onClose = (event: CloseEvent) => {
      if (event.code === CLOSE_CODES.sessionExpired || event.code === CLOSE_CODES.documentDeleted) {
        provider.shouldConnect = false;
      }
    };
    const onAwareness = () => {
      const people: Presence[] = [];
      for (const [clientId, state] of provider.awareness.getStates()) {
        const person = (state as { user?: { name?: string; color?: string } }).user;
        if (person?.name) {
          people.push({ clientId, name: person.name, color: person.color ?? "#888", isSelf: clientId === doc.clientID });
        }
      }
      update({ presence: people });
    };
    const onVisibility = () => {
      clearTimeout(hiddenTimer);
      if (document.visibilityState === "hidden") {
        hiddenTimer = setTimeout(() => {
          paused = true;
          provider.disconnect();
          update({ connection: "paused" });
        }, HIDDEN_DISCONNECT_MS);
      } else if (paused) {
        paused = false;
        update({ connection: "connecting" });
        void provider.connect();
      }
    };

    provider.on("status", onStatus);
    provider.on("sync", onSync);
    provider.on("custom-message", onCustom);
    provider.on("connection-close", onClose);
    provider.awareness.on("change", onAwareness);
    doc.on("update", onUpdate);
    document.addEventListener("visibilitychange", onVisibility);

    setStatus(INITIAL_STATUS);
    setSession({ doc, provider });
    void provider.connect();

    return () => {
      clearTimeout(hiddenTimer);
      clearTimeout(noticeTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      doc.off("update", onUpdate);
      provider.awareness.off("change", onAwareness);
      provider.off("status", onStatus);
      provider.off("sync", onSync);
      provider.off("custom-message", onCustom);
      provider.off("connection-close", onClose);
      provider.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [docId]);

  if (!session) return null;
  return { docId, ...session, user: { name: displayName, color: memberColor(memberId) }, ...status };
}
