import { NS, attr, child, children, intAttr, val } from "./xml";

/** A list level as Colo sees it: bullets, numbers, or no list at all. */
export interface ListLevel {
  kind: "bullet" | "ordered";
  start: number;
  /** A single-level list: Word nests those by style ("List Bullet 2") or indentation. */
  singleLevel: boolean;
}

interface AbstractLevel {
  format: string;
  start: number;
}

/** numbering.xml: num → abstract definition (with overrides) → level format and start. */
export class Numbering {
  private readonly abstracts = new Map<string, { single: boolean; levels: Map<number, AbstractLevel> }>();
  private readonly nums = new Map<string, { abstractId: string; startOverrides: Map<number, number> }>();

  constructor(numbering: Document | null) {
    const root = numbering?.documentElement;
    if (!root) return;
    for (const abstract of children(root, NS.w, "abstractNum")) {
      const id = attr(abstract, NS.w, "abstractNumId");
      if (id === null) continue;
      const levels = new Map<number, AbstractLevel>();
      for (const lvl of children(abstract, NS.w, "lvl")) {
        levels.set(intAttr(lvl, NS.w, "ilvl") ?? 0, {
          format: val(lvl, "numFmt") ?? "decimal",
          start: intAttr(child(lvl, NS.w, "start"), NS.w, "val") ?? 1,
        });
      }
      this.abstracts.set(id, { single: val(abstract, "multiLevelType") === "singleLevel", levels });
    }
    for (const num of children(root, NS.w, "num")) {
      const id = attr(num, NS.w, "numId");
      const abstractId = val(num, "abstractNumId");
      if (id === null || abstractId === null) continue;
      const startOverrides = new Map<number, number>();
      for (const override of children(num, NS.w, "lvlOverride")) {
        const start = intAttr(child(override, NS.w, "startOverride"), NS.w, "val");
        if (start !== null) startOverrides.set(intAttr(override, NS.w, "ilvl") ?? 0, start);
      }
      this.nums.set(id, { abstractId, startOverrides });
    }
  }

  /** The list level for a paragraph's numId/ilvl, or null when it is not a visible list. */
  level(numId: string | undefined, ilvl: number): ListLevel | null {
    if (numId === undefined || numId === "0") return null;
    const num = this.nums.get(numId);
    const abstract = num ? this.abstracts.get(num.abstractId) : undefined;
    const level = abstract?.levels.get(ilvl) ?? abstract?.levels.get(0);
    if (!num || !abstract || !level || level.format === "none") return null;
    return {
      kind: level.format === "bullet" ? "bullet" : "ordered",
      start: num.startOverrides.get(ilvl) ?? level.start,
      singleLevel: abstract.single,
    };
  }
}
