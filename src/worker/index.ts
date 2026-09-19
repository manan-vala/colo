import { isDocumentId } from "../shared/protocol";
import { IDENTITY_HEADER, encodeIdentity } from "./documents";

export { Document } from "./document";
export { Workspace } from "./workspace";

// Mirrors public/_headers, which Cloudflare does not apply to Worker responses (§6.3).
// style-src allows inline styles: rich-text marks (colour, font, size), table column widths and
// Radix menus render them. script-src stays 'self', which also blocks inline event handlers.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  if (!secured.headers.has("Cache-Control")) {
    secured.headers.set("Cache-Control", "no-store");
  }
  return secured;
}

function jsonError(status: number, error: string): Response {
  return withSecurityHeaders(Response.json({ error }, { status }));
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Cross-site request and WebSocket hijacking protection (§4.1): state-changing requests and
 * upgrades must come from Colo's own origin. The admin API is called by a script with a
 * bearer token instead, so it is exempt.
 */
function hasTrustedOrigin(request: Request, url: URL, env: Env): boolean {
  const needsOrigin =
    (UNSAFE_METHODS.has(request.method) && !url.pathname.startsWith("/api/admin/")) ||
    request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  return !needsOrigin || request.headers.get("Origin") === env.ORIGIN;
}

/**
 * The export is the one GET worth protecting from cross-site triggering: a single request
 * returns every document, every image and both members' addresses.
 *
 * `Origin` is no use here — browsers omit it on same-origin GETs — so this reads `Sec-Fetch-Site`,
 * which they send on every request and which a page cannot forge. A client that sends neither
 * (the backup script, curl) is not a browser being steered by someone else's page, so it passes.
 * CORS and `SameSite=Strict` already stop a cross-site read; this stops it being fetched at all.
 */
function isCrossSiteExport(request: Request, url: URL, env: Env): boolean {
  if (url.pathname !== "/api/export") return false;
  const site = request.headers.get("Sec-Fetch-Site");
  const origin = request.headers.get("Origin");
  if (origin && origin !== env.ORIGIN) return true;
  return site !== null && site !== "same-origin" && site !== "none";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // run_worker_first only routes /api/* here; everything else is served by Static Assets.
    if (!url.pathname.startsWith("/api/")) return jsonError(404, "NOT_FOUND");
    if (!hasTrustedOrigin(request, url, env)) return jsonError(403, "BAD_ORIGIN");
    if (isCrossSiteExport(request, url, env)) return jsonError(403, "BAD_ORIGIN");

    const workspace = env.WORKSPACE.getByName("default", { locationHint: "apac" });

    const socket = /^\/api\/docs\/([^/]+)\/ws$/.exec(url.pathname);
    if (socket) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return jsonError(426, "UPGRADE_REQUIRED");
      if (!isDocumentId(socket[1])) return jsonError(404, "NOT_FOUND");
      const auth = await workspace.authorizeDocument(request.headers.get("Cookie"), socket[1]);
      if (!auth.ok) return jsonError(auth.status, auth.error);
      // Only the Worker sets the identity header; anything a client sent is replaced.
      const headers = new Headers(request.headers);
      headers.set(IDENTITY_HEADER, encodeIdentity(auth.identity));
      return env.DOCUMENT.getByName(socket[1], { locationHint: "apac" }).fetch(new Request(request, { headers }));
    }

    // Images and restore points are served by the document's own object (plan §4.1).
    const documentRoute = /^\/api\/docs\/([^/]+)\/(?:images|restore-points)(?:\/|$)/.exec(url.pathname);
    if (documentRoute) {
      if (!isDocumentId(documentRoute[1])) return jsonError(404, "NOT_FOUND");
      const auth = await workspace.authorizeRequest(request.headers.get("Cookie"), documentRoute[1]);
      if (!auth.ok) return jsonError(auth.status, auth.error);
      const headers = new Headers(request.headers);
      headers.set(IDENTITY_HEADER, encodeIdentity(auth.identity));
      const document = env.DOCUMENT.getByName(documentRoute[1], { locationHint: "apac" });
      return withSecurityHeaders(await document.fetch(new Request(request, { headers })));
    }

    const response = await workspace.fetch(request);
    return response.webSocket ? response : withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
