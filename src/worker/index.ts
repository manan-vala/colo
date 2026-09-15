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

    const stub = env.WORKSPACE.getByName("default", { locationHint: "apac" });
    const response = await stub.fetch(request);
    return response.webSocket ? response : withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
