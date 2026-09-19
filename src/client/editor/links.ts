/** Link rules shared by the editor and the import/export converters. */

/** Link protocols the editor accepts; anything else (javascript:, data:, …) is rejected. */
export const LINK_PROTOCOLS = ["http", "https", "mailto", "tel"];

/** True for http(s), mailto and tel links, including scheme-less ones like "example.com". */
export function isSafeLink(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return !scheme || LINK_PROTOCOLS.includes(scheme[1].toLowerCase());
}

/** Adds https:// to scheme-less web addresses. */
export function normalizeLink(url: string): string {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/\//, "")}`;
}
