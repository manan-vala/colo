/**
 * Real pages (M4): page geometry, the paginator, page breaks and page-aware tables. Everything
 * here is presentation — the only thing stored in the shared document is the page break node
 * and the page settings in the Yjs settings map (plan §3.3).
 */
export { PAGE_GAP_PX, formatHeaderFooter, mmToPx, resolvePageLayout, type PageLayout } from "./layout";
export { PageBreak } from "./page-break";
export { Pagination, paginationKey, paginationState } from "./pagination";
export { PagedTableView } from "./table-view";
