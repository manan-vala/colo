import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COMMENT_LIMITS } from "../src/shared/doc-schema";
import { findAnchors, threadsAt } from "../src/client/comments/anchors";
import {
  addReply,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  isThreadStart,
  readThreads,
  setResolved,
  threadsMap,
} from "../src/client/comments/model";
import { commentStyles } from "../src/client/comments/highlight";
import { layoutRail } from "../src/client/comments/rail-layout";

const alex = { id: "M-ALEX", name: "Alex" };
const sam = { id: "M-SAM", name: "Sam" };

/** Two Yjs documents kept in sync, like two browsers behind the Document object. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (update: Uint8Array) => Y.applyUpdate(b, update));
  b.on("update", (update: Uint8Array) => Y.applyUpdate(a, update));
  return { a, b };
}

describe("comment threads", () => {
  it("creates a thread that the other person sees", () => {
    const { a, b } = pair();
    expect(createThread(a, "t1", { quote: "  the   quick\nfox ", body: " Looks good ", author: alex })).toBe(true);
    const [thread] = readThreads(b);
    expect(thread).toMatchObject({ id: "t1", quote: "the quick fox", createdBy: alex.id, createdByName: "Alex", resolved: false });
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({ authorId: alex.id, authorName: "Alex", body: "Looks good", deleted: false, editedAt: null });
  });

  it("rejects empty comments and bounds long ones", () => {
    const doc = new Y.Doc();
    expect(createThread(doc, "t1", { quote: "x", body: "   ", author: alex })).toBe(false);
    expect(readThreads(doc)).toHaveLength(0);
    createThread(doc, "t2", { quote: "q".repeat(500), body: "b".repeat(10_000), author: alex });
    const [thread] = readThreads(doc);
    expect(thread.comments[0].body.length).toBe(COMMENT_LIMITS.bodyLength);
    expect(thread.quote.length).toBe(COMMENT_LIMITS.quoteLength);
  });

  it("merges replies written at the same time by both people", () => {
    const { a, b } = pair();
    createThread(a, "t1", { quote: "x", body: "First", author: alex });
    // Disconnect, reply on both sides, then exchange state.
    const offlineA = new Y.Doc();
    const offlineB = new Y.Doc();
    Y.applyUpdate(offlineA, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(offlineB, Y.encodeStateAsUpdate(b));
    addReply(offlineA, "t1", alex, "From Alex");
    addReply(offlineB, "t1", sam, "From Sam");
    Y.applyUpdate(offlineA, Y.encodeStateAsUpdate(offlineB));
    Y.applyUpdate(offlineB, Y.encodeStateAsUpdate(offlineA));
    const bodies = (doc: Y.Doc) => readThreads(doc)[0].comments.map((c) => c.body);
    expect(bodies(offlineA)).toHaveLength(3);
    expect(bodies(offlineA)).toEqual(bodies(offlineB));
    expect(bodies(offlineA)).toEqual(expect.arrayContaining(["First", "From Alex", "From Sam"]));
  });

  it("edits and soft-deletes comments", () => {
    const doc = new Y.Doc();
    createThread(doc, "t1", { quote: "x", body: "First", author: alex });
    addReply(doc, "t1", sam, "Reply");
    const [first, reply] = readThreads(doc)[0].comments;
    expect(editComment(doc, "t1", reply.id, "Edited reply")).toBe(true);
    expect(editComment(doc, "t1", reply.id, "  ")).toBe(false);
    let thread = readThreads(doc)[0];
    expect(thread.comments[1]).toMatchObject({ body: "Edited reply" });
    expect(thread.comments[1].editedAt).not.toBeNull();

    deleteComment(doc, "t1", reply.id);
    thread = readThreads(doc)[0];
    expect(thread.comments[1]).toMatchObject({ body: "", deleted: true });
    expect(editComment(doc, "t1", reply.id, "Revived?")).toBe(false);
    expect(isThreadStart(thread, first.id)).toBe(true);
    expect(isThreadStart(thread, reply.id)).toBe(false);
  });

  it("resolves, reopens, reopens on reply, and deletes threads", () => {
    const doc = new Y.Doc();
    createThread(doc, "t1", { quote: "x", body: "First", author: alex });
    setResolved(doc, "t1", sam);
    expect(readThreads(doc)[0]).toMatchObject({ resolved: true, resolvedBy: sam.id, resolvedByName: "Sam" });
    setResolved(doc, "t1", null);
    expect(readThreads(doc)[0]).toMatchObject({ resolved: false, resolvedBy: null });
    setResolved(doc, "t1", sam);
    addReply(doc, "t1", alex, "Not done yet");
    expect(readThreads(doc)[0].resolved).toBe(false);
    deleteThread(doc, "t1");
    expect(readThreads(doc)).toHaveLength(0);
  });

  it("ignores malformed threads and comments written by a buggy client", () => {
    const doc = new Y.Doc();
    createThread(doc, "good", { quote: "x", body: "Fine", author: alex });
    doc.transact(() => {
      threadsMap(doc).set("not-a-map", "oops" as unknown as Y.Map<unknown>);
      const broken = new Y.Map<unknown>([["createdAt", "2026-01-01T00:00:00Z"]]);
      threadsMap(doc).set("no-comments", broken);
      const comments = threadsMap(doc).get("good")!.get("comments") as Y.Array<unknown>;
      comments.push([new Y.Map([["body", "no id"]])]);
    });
    const threads = readThreads(doc);
    expect(threads.map((t) => t.id)).toEqual(["good"]);
    expect(threads[0].comments).toHaveLength(1);
  });
});

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
  marks: {
    comment: { attrs: { threadId: {} }, excludes: "", inclusive: false },
    bold: {},
  },
});
const comment = (threadId: string) => schema.marks.comment.create({ threadId });

describe("comment anchors", () => {
  // "Hello brave new world" with t1 on "brave new" (bold inside) and t2 on "new world"; t3 later.
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [
      schema.text("Hello "),
      schema.text("brave ", [comment("t1")]),
      schema.text("new", [comment("t1"), comment("t2"), schema.marks.bold.create()]),
      schema.text(" world", [comment("t2")]),
    ]),
    schema.node("paragraph", null, [schema.text("Second "), schema.text("line", [comment("t3")]), schema.text(" and "), schema.text("more", [comment("t1")])]),
  ]);

  it("finds each thread's first range in document order, with overlapping threads", () => {
    const anchors = findAnchors(doc);
    expect(anchors.map((a) => a.threadId)).toEqual(["t1", "t2", "t3"]);
    const [t1, t2] = anchors;
    expect(doc.textBetween(t1.from, t1.to)).toBe("brave new");
    expect(doc.textBetween(t2.from, t2.to)).toBe("new world");
    // Text from a second, separate range is still part of the thread's text.
    expect(t1.text).toBe("brave newmore");
  });

  it("reports no anchor for a thread whose text is gone", () => {
    expect(findAnchors(schema.node("doc", null, [schema.node("paragraph", null, [schema.text("plain")])]))).toEqual([]);
  });

  it("finds the threads touching a cursor position", () => {
    const t1 = findAnchors(doc)[0];
    expect(threadsAt(doc.resolve(t1.from + 2))).toEqual(["t1"]);
    expect(threadsAt(doc.resolve(t1.from + 7)).sort()).toEqual(["t1", "t2"]);
    expect(threadsAt(doc.resolve(1))).toEqual([]);
  });
});

describe("comment rail layout", () => {
  const item = (id: string, anchorTop: number, height = 100) => ({ id, anchorTop, height });

  it("puts cards at their anchors when they fit", () => {
    const tops = layoutRail([item("a", 0), item("b", 200), item("c", 400)], null);
    expect([...tops.values()]).toEqual([0, 200, 400]);
  });

  it("pushes later cards down instead of overlapping", () => {
    const tops = layoutRail([item("a", 0), item("b", 20), item("c", 30)], null, 10);
    expect([...tops.values()]).toEqual([0, 110, 220]);
  });

  it("keeps the active card at its anchor and moves earlier cards up", () => {
    const tops = layoutRail([item("a", 0), item("b", 20), item("c", 30)], "c", 10);
    expect(tops.get("c")).toBe(30);
    expect(tops.get("b")).toBe(30 - 10 - 100);
    expect(tops.get("a")).toBe(30 - 2 * 110);
  });

  it("handles no cards and an unknown active card", () => {
    expect(layoutRail([], "x").size).toBe(0);
    expect(layoutRail([item("a", 50)], "missing").get("a")).toBe(50);
  });
});

describe("comment highlights", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("highlights open threads, the active one more strongly, only on screen", () => {
    const css = commentStyles([id, "other-1"], id);
    expect(css).toContain(`[data-comment-id="${id}"]`);
    expect(css).toContain('[data-comment-id="other-1"]');
    expect(css.match(/background-color/g)).toHaveLength(2);
    expect(css.startsWith("@media screen")).toBe(true);
  });

  it("emits nothing without open threads", () => {
    expect(commentStyles([], null)).toBe("");
  });

  it("never puts an unsafe thread ID into the stylesheet", () => {
    const css = commentStyles(['x"] { } body { display: none } [a="', id], null);
    expect(css).not.toContain("display: none");
    expect(css).toContain(id);
  });
});
