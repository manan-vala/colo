import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { findAnchors, threadsAt } from "./anchors";
import {
  addReply,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  isThreadStart,
  newId,
  readThreads,
  setResolved,
  threadsMap,
  type Author,
  type Thread,
} from "./model";
import { resolveRange, trackRange, type TrackedRange } from "./tracked-range";

/** A comment being written: its thread does not exist until it is posted. */
export interface Draft {
  threadId: string;
  quote: string;
  range: TrackedRange;
}

/**
 * What the comments UI shows. It changes when a thread, the set of anchored threads, the active
 * thread or the draft changes — not on every keystroke.
 */
export interface CommentsState {
  author: Author;
  /** Open threads with text in the document, in document order (positions come from the DOM). */
  anchored: Thread[];
  /** Open threads whose text was deleted. */
  detached: Thread[];
  resolved: Thread[];
  activeId: string | null;
  draft: Draft | null;
  error: string | null;
}

/** Stable for the life of the document screen, so cards can skip re-rendering. */
export interface CommentsActions {
  /** Starts a comment on the selected text; returns false when nothing is selected. */
  start: () => boolean;
  post: (body: string) => boolean;
  cancel: () => void;
  reply: (threadId: string, body: string) => boolean;
  edit: (threadId: string, commentId: string, body: string) => boolean;
  /** Deletes one comment; deleting the first comment deletes the whole thread. */
  remove: (threadId: string, commentId: string) => void;
  resolve: (threadId: string) => void;
  reopen: (threadId: string) => void;
  /** Makes a thread active and selects its text in the document. */
  focus: (threadId: string) => void;
}

/** Subscribes to the thread map; the snapshot only changes when a thread changes. */
function useThreads(doc: Y.Doc): Thread[] {
  const store = useMemo(() => {
    const map = threadsMap(doc);
    let snapshot = readThreads(doc);
    return {
      subscribe: (onChange: () => void) => {
        const observer = () => {
          snapshot = readThreads(doc);
          onChange();
        };
        map.observeDeep(observer);
        return () => map.unobserveDeep(observer);
      },
      snapshot: () => snapshot,
    };
  }, [doc]);
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

/** IDs of the threads with text in the document, in document order. */
type AnchorSummary = string[];

function summarizeAnchors(editor: Editor): AnchorSummary {
  return findAnchors(editor.state.doc).map((anchor) => anchor.threadId);
}

const sameSummary = (a: AnchorSummary, b: AnchorSummary) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Which threads have text in the document, in order. Checked at most once a frame after the
 * document changes; ordinary typing leaves the result (and React) untouched.
 */
function useAnchorSummary(editor: Editor): AnchorSummary {
  const [summary, setSummary] = useState(() => summarizeAnchors(editor));
  useEffect(() => {
    let frame = 0;
    const update = () => setSummary((current) => {
      const next = summarizeAnchors(editor);
      return sameSummary(current, next) ? current : next;
    });
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    editor.on("transaction", onTransaction);
    update();
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", onTransaction);
    };
  }, [editor]);
  return summary;
}

/**
 * Comment threads for one open document (plan F7). Threads are shared through Yjs; which thread
 * is active and the comment being written are local to this browser.
 */
export function useComments(editor: Editor, doc: Y.Doc, author: Author): { state: CommentsState; actions: CommentsActions } {
  const threads = useThreads(doc);
  const summary = useAnchorSummary(editor);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lists = useMemo(() => {
    const byId = new Map(threads.map((t) => [t.id, t]));
    const anchoredIds = new Set(summary);
    return {
      anchored: summary.flatMap((threadId) => {
        const thread = byId.get(threadId);
        return thread && !thread.resolved ? [thread] : [];
      }),
      detached: threads.filter((t) => !t.resolved && !anchoredIds.has(t.id)),
      resolved: threads.filter((t) => t.resolved),
    };
  }, [threads, summary]);

  // The latest values, for actions that must stay the same object between renders.
  const latest = useRef({ threads, draft, author });
  latest.current = { threads, draft, author };

  // Moving the cursor into commented text activates its thread, as clicking it does.
  const openIds = useMemo(() => new Set(lists.anchored.map((thread) => thread.id)), [lists.anchored]);
  useEffect(() => {
    const onSelection = () => {
      const here = threadsAt(editor.state.selection.$from).filter((id) => openIds.has(id));
      setActiveId((current) => {
        if (current && here.includes(current)) return current;
        if (here.length > 0) return here[0];
        return latest.current.draft?.threadId ?? null;
      });
    };
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, openIds]);

  const actions = useMemo<CommentsActions>(() => {
    const me = () => latest.current.author;
    return {
      start: () => {
        const { from, to, empty } = editor.state.selection;
        if (empty) return false;
        const range = trackRange(editor.state, from, to);
        if (!range) return false;
        const threadId = newId();
        setDraft({ threadId, range, quote: editor.state.doc.textBetween(from, to, " ") });
        setActiveId(threadId);
        setError(null);
        return true;
      },
      post: (body) => {
        const current = latest.current.draft;
        if (!current) return false;
        const range = resolveRange(editor.state, current.range);
        if (!range) {
          setError("The text you selected was deleted.");
          return false;
        }
        if (!createThread(doc, current.threadId, { quote: current.quote, body, author: me() })) return false;
        editor.commands.setComment(current.threadId, range);
        setDraft(null);
        setError(null);
        return true;
      },
      cancel: () => {
        const current = latest.current.draft;
        setDraft(null);
        setError(null);
        setActiveId((active) => (active === current?.threadId ? null : active));
      },
      reply: (threadId, body) => addReply(doc, threadId, me(), body),
      edit: (threadId, commentId, body) => editComment(doc, threadId, commentId, body),
      remove: (threadId, commentId) => {
        const thread = latest.current.threads.find((t) => t.id === threadId);
        if (thread && isThreadStart(thread, commentId)) {
          editor.commands.unsetComment(threadId);
          deleteThread(doc, threadId);
        } else {
          deleteComment(doc, threadId, commentId);
        }
      },
      resolve: (threadId) => {
        setResolved(doc, threadId, me());
        setActiveId((active) => (active === threadId ? null : active));
      },
      reopen: (threadId) => setResolved(doc, threadId, null),
      focus: (threadId) => {
        setActiveId(threadId);
        const anchor = findAnchors(editor.state.doc).find((a) => a.threadId === threadId);
        if (anchor) editor.chain().setTextSelection(anchor.from).scrollIntoView().run();
      },
    };
  }, [editor, doc]);

  const state = useMemo<CommentsState>(
    () => ({ author, ...lists, activeId, draft, error }),
    [author, lists, activeId, draft, error],
  );
  return { state, actions };
}
