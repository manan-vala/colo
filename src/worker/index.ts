export { Workspace } from "./workspace";

// Mirrors public/_headers, which Cloudflare does not apply to Worker responses (§6).
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

export default {
  async fetch(request, env) {
    // run_worker_first only routes /api/* here; everything else is served by Static Assets.
    if (!new URL(request.url).pathname.startsWith("/api/")) {
      return withSecurityHeaders(new Response("Not found", { status: 404 }));
    }
    const stub = env.WORKSPACE.getByName("default", { locationHint: "apac" });
    const response = await stub.fetch(request);
    return response.webSocket ? response : withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
