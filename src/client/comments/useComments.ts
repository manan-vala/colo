import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { findAnchors, threadsAt, type Anchor } from "./anchors";
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

export interface CommentsState {
  author: Author;
  threads: Thread[];
  /** Open threads with text in the document, in document order. */
  anchored: { thread: Thread; anchor: Anchor }[];
  /** Open threads whose text was deleted. */
  detached: Thread[];
  resolved: Thread[];
  anchors: Map<string, Anchor>;
  activeId: string | null;
  draft: Draft | null;
  error: string | null;
}

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
  setActive: (threadId: string | null) => void;
}

export type Comments = CommentsState & CommentsActions;

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

/** Thread anchors, recomputed at most once a frame after the document changes. */
function useAnchors(editor: Editor): Anchor[] {
  const [anchors, setAnchors] = useState(() => findAnchors(editor.state.doc));
  useEffect(() => {
    let frame = 0;
    const onUpdate = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setAnchors(findAnchors(editor.state.doc)));
    };
    editor.on("transaction", onUpdate);
    setAnchors(findAnchors(editor.state.doc));
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", onUpdate);
    };
  }, [editor]);
  return anchors;
}

/**
 * Comment threads for one open document (plan F7): what the margin and the comments panel
 * show, and the actions they offer. Threads are shared through Yjs; which thread is active and
 * the comment being written are local to this browser.
 */
export function useComments(editor: Editor, doc: Y.Doc, author: Author): Comments {
  const threads = useThreads(doc);
  const anchorList = useAnchors(editor);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const anchors = useMemo(() => new Map(anchorList.map((a) => [a.threadId, a])), [anchorList]);
  const { anchored, detached, resolved } = useMemo(() => {
    const byId = new Map(threads.map((t) => [t.id, t]));
    return {
      anchored: anchorList.flatMap((anchor) => {
        const thread = byId.get(anchor.threadId);
        return thread && !thread.resolved ? [{ thread, anchor }] : [];
      }),
      detached: threads.filter((t) => !t.resolved && !anchors.has(t.id)),
      resolved: threads.filter((t) => t.resolved),
    };
  }, [threads, anchorList, anchors]);

  // Moving the cursor into commented text activates its thread, as clicking it does.
  const openIds = useMemo(() => new Set(anchored.map((a) => a.thread.id)), [anchored]);
  useEffect(() => {
    const onSelection = () => {
      const here = threadsAt(editor.state.selection.$from).filter((id) => openIds.has(id));
      setActiveId((current) => {
        if (current && here.includes(current)) return current;
        if (here.length > 0) return here[0];
        return draft ? draft.threadId : null;
      });
    };
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, openIds, draft]);

  const start = useCallback(() => {
    const { from, to, empty } = editor.state.selection;
    if (empty) return false;
    const range = trackRange(editor.state, from, to);
    if (!range) return false;
    const threadId = newId();
    setDraft({ threadId, range, quote: editor.state.doc.textBetween(from, to, " ") });
    setActiveId(threadId);
    setError(null);
    return true;
  }, [editor]);

  const post = useCallback(
    (body: string) => {
      if (!draft) return false;
      const range = resolveRange(editor.state, draft.range);
      if (!range) {
        setError("The text you selected was deleted.");
        return false;
      }
      if (!createThread(doc, draft.threadId, { quote: draft.quote, body, author })) return false;
      editor.commands.setComment(draft.threadId, range);
      setDraft(null);
      setError(null);
      return true;
    },
    [draft, editor, doc, author],
  );

  const cancel = useCallback(() => {
    setDraft(null);
    setError(null);
    setActiveId((current) => (current === draft?.threadId ? null : current));
  }, [draft]);

  const focus = useCallback(
    (threadId: string) => {
      setActiveId(threadId);
      const anchor = findAnchors(editor.state.doc).find((a) => a.threadId === threadId);
      if (anchor) editor.chain().setTextSelection(anchor.from).scrollIntoView().run();
    },
    [editor],
  );

  const remove = useCallback(
    (threadId: string, commentId: string) => {
      const thread = threads.find((t) => t.id === threadId);
      if (thread && isThreadStart(thread, commentId)) {
        editor.commands.unsetComment(threadId);
        deleteThread(doc, threadId);
      } else {
        deleteComment(doc, threadId, commentId);
      }
    },
    [threads, editor, doc],
  );

  return {
    author,
    threads,
    anchored,
    detached,
    resolved,
    anchors,
    activeId,
    draft,
    error,
    start,
    post,
    cancel,
    reply: useCallback((threadId: string, body: string) => addReply(doc, threadId, author, body), [doc, author]),
    edit: useCallback((threadId: string, commentId: string, body: string) => editComment(doc, threadId, commentId, body), [doc]),
    remove,
    resolve: useCallback(
      (threadId: string) => {
        setResolved(doc, threadId, author);
        setActiveId((current) => (current === threadId ? null : current));
      },
      [doc, author],
    ),
    reopen: useCallback((threadId: string) => setResolved(doc, threadId, null), [doc]),
    focus,
    setActive: setActiveId,
  };
}
