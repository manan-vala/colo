/**
 * Vertical placement of comment cards in the margin, as in Google Docs: each card wants to sit
 * level with its anchor; cards may not overlap; the active card gets its ideal place and the
 * others make room above and below it.
 */

export interface RailItem {
  id: string;
  /** Top of the anchor, in rail coordinates. */
  anchorTop: number;
  height: number;
}

export const CARD_GAP = 8;

/** Returns each card's top, keyed by ID. Items must be in document order. */
export function layoutRail(items: RailItem[], activeId: string | null, gap = CARD_GAP): Map<string, number> {
  const tops = new Map<string, number>();
  if (items.length === 0) return tops;
  const pivot = Math.max(0, items.findIndex((item) => item.id === activeId));

  // The pivot (active card, or the first card) sits at its anchor.
  tops.set(items[pivot].id, items[pivot].anchorTop);

  // Cards below the pivot move down as far as they must.
  for (let i = pivot + 1; i < items.length; i++) {
    const above = items[i - 1];
    const floor = tops.get(above.id)! + above.height + gap;
    tops.set(items[i].id, Math.max(items[i].anchorTop, floor));
  }
  // Cards above the pivot move up as far as they must.
  for (let i = pivot - 1; i >= 0; i--) {
    const below = items[i + 1];
    const ceiling = tops.get(below.id)! - gap - items[i].height;
    tops.set(items[i].id, Math.min(items[i].anchorTop, ceiling));
  }
  return tops;
}
