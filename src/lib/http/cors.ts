// Shared CORS headers for the public API routes.
//
// Default behavior (no ALLOWED_ORIGINS env var) is `*`, which preserves the
// previous behavior and the Lovable preview cross-origin flow. Set
// ALLOWED_ORIGINS to a comma-separated list of origins
// (e.g. "https://your-domain.com,https://www.your-domain.com") to lock the
// endpoints to just those origins.
export function corsHeaders(request: Request, methods: string): Record<string, string> {
  const configured = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const requestOrigin = request.headers.get("origin") || "";
  let allowOrigin = "*";
  if (configured.length > 0) {
    // Reflect the caller's origin only when it is explicitly allowed; otherwise
    // fall back to the first configured origin so the response is never `*`.
    allowOrigin = configured.includes(requestOrigin) ? requestOrigin : configured[0];
  }

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": methods,
    "access-control-allow-headers":
      "content-type, authorization, x-asset-id, x-asset-ext, x-content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}
