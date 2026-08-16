// SECURITY NOTE: This endpoint hands the ElevenLabs API key to the browser so
// transcription can upload directly to ElevenLabs (bypassing Lovable preview's
// fragile multipart proxy). It now requires a valid signed-in session, so it is
// no longer reachable anonymously — but any signed-in user's browser can still
// read the key. Before opening this app to untrusted/end users:
// 1. Rotate the ElevenLabs key (assume the old one is already public).
// 2. Move the ElevenLabs call fully server-side and delete this endpoint, so
//    the key never reaches any browser.
import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders } from "@/lib/http/cors";
import { requireBearerAuth } from "@/integrations/supabase/require-auth";

const METHODS = "GET, OPTIONS";

export const Route = createFileRoute("/api/public/elevenlabs-key")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) =>
        new Response(null, { status: 204, headers: corsHeaders(request, METHODS) }),
      GET: async ({ request }) => {
        const cors = corsHeaders(request, METHODS);

        const auth = await requireBearerAuth(request);
        if (!auth.ok) {
          return new Response(JSON.stringify({ error: auth.message }), {
            status: auth.status,
            headers: { "content-type": "application/json", ...cors },
          });
        }

        const key = process.env.ELEVENLABS_API_KEY;
        if (!key) {
          return new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }), {
            status: 500,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        return new Response(JSON.stringify({ key }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...cors },
        });
      },
    },
  },
});
