import { isDocumentId } from "../shared/protocol";
import { IDENTITY_HEADER, encodeIdentity } from "./documents";

export { Document } from "./document";
export { Workspace } from "./workspace";

// Mirrors public/_headers, which Cloudflare does not apply to Worker responses (§6.3).
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // run_worker_first only routes /api/* here; everything else is served by Static Assets.
    if (!url.pathname.startsWith("/api/")) return jsonError(404, "NOT_FOUND");
    if (!hasTrustedOrigin(request, url, env)) return jsonError(403, "BAD_ORIGIN");

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

    const response = await workspace.fetch(request);
    return response.webSocket ? response : withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
