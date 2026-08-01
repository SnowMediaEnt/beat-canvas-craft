// Public trigger for Plex access enforcement, so expiries are applied even
// when nobody has the dashboard open. Protected by the per-install enforce
// key (shown in the Plex dashboard settings). Point any scheduler at it:
//   GET /api/public/plex-enforce?key=<enforce_key>
// e.g. cron-job.org, UptimeRobot, GitHub Actions cron — every 10-15 minutes.
import { createFileRoute } from "@tanstack/react-router";

import { runEnforcement } from "@/lib/plex/plex-enforce.server";
import { getSettings } from "@/lib/plex/plex-store.server";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });
}

async function handleEnforce(request: Request): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key");
  if (!key) return json({ error: "Missing key" }, 401);

  let expected: string;
  try {
    expected = (await getSettings()).enforce_key;
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Settings unavailable" }, 500);
  }
  if (key !== expected) return json({ error: "Invalid key" }, 403);

  try {
    const result = await runEnforcement("http");
    return json(result, 200);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Enforcement failed" }, 500);
  }
}

export const Route = createFileRoute("/api/public/plex-enforce")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => handleEnforce(request),
      POST: async ({ request }) => handleEnforce(request),
    },
  },
});
