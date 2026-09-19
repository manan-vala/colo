import type { JSONContent } from "@tiptap/core";

/**
 * Word has no list or quote containers: a list is a run of numbered paragraphs, a quote a run
 * of paragraphs in a quote style. The body reader emits flat blocks tagged with what they belong
 * to; these functions group them into Colo's nested nodes.
 */

export type ListKind = "bullet" | "ordered" | "task";

export interface Block {
  node: JSONContent;
  list?: { kind: ListKind; level: number; start: number; checked?: boolean };
  /** Consecutive blocks with the same group become one blockquote or code block. */
  group?: "quote" | "code";
}

const LIST_TYPES: Record<ListKind, string> = { bullet: "bulletList", ordered: "orderedList", task: "taskList" };

export function groupBlocks(blocks: Block[]): JSONContent[] {
  const out: JSONContent[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.list) {
      const [list, next] = buildList(blocks, i, block.list.level);
      out.push(list);
      i = next;
    } else if (block.group) {
      let end = i;
      while (end < blocks.length && blocks[end].group === block.group && !blocks[end].list) end++;
      out.push(block.group === "quote" ? quote(blocks.slice(i, end)) : codeBlock(blocks.slice(i, end)));
      i = end;
    } else {
      out.push(block.node);
      i++;
    }
  }
  return out;
}

/** Builds one list from `start`, nesting deeper items under the item before them. */
function buildList(blocks: Block[], start: number, level: number): [JSONContent, number] {
  const first = blocks[start].list!;
  const type = LIST_TYPES[first.kind];
  const list: JSONContent = { type, content: [] };
  if (first.kind === "ordered" && first.start !== 1) list.attrs = { start: first.start };
  let i = start;
  while (i < blocks.length) {
    const item = blocks[i].list;
    if (!item || item.level < level) break;
    if (item.level > level) {
      const [nested, next] = buildList(blocks, i, item.level);
      const parent = list.content!.at(-1) ?? emptyItem(first.kind, list.content!);
      parent.content!.push(nested);
      i = next;
      continue;
    }
    if (LIST_TYPES[item.kind] !== type) break;
    list.content!.push({
      type: item.kind === "task" ? "taskItem" : "listItem",
      ...(item.kind === "task" ? { attrs: { checked: item.checked ?? false } } : {}),
      content: [asParagraph(blocks[i].node)],
    });
    i++;
  }
  return [list, i];
}

/** A list that starts deeper than its first level still needs an item to hang from. */
function emptyItem(kind: ListKind, items: JSONContent[]): JSONContent {
  const item: JSONContent = {
    type: kind === "task" ? "taskItem" : "listItem",
    ...(kind === "task" ? { attrs: { checked: false } } : {}),
    content: [{ type: "paragraph" }],
  };
  items.push(item);
  return item;
}

/** List items start with a paragraph; a heading in a list keeps its text as a paragraph. */
function asParagraph(node: JSONContent): JSONContent {
  if (node.type === "paragraph") return node;
  return { type: "paragraph", content: node.content };
}

function quote(blocks: Block[]): JSONContent {
  return { type: "blockquote", content: blocks.map((block) => asParagraph(block.node)) };
}

/** Code blocks hold plain text: lines joined, marks dropped. */
function codeBlock(blocks: Block[]): JSONContent {
  const text = blocks.map((block) => plainText(block.node)).join("\n");
  return text ? { type: "codeBlock", content: [{ type: "text", text }] } : { type: "codeBlock" };
}

function plainText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(plainText).join("");
}
