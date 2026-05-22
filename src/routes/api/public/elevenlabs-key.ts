// SECURITY NOTE: This endpoint exposes the ElevenLabs API key to the
// browser to enable direct uploads, which bypasses Lovable preview's
// fragile multipart proxy. Acceptable because this site has a single
// authenticated user. Before opening to additional users:
// 1. Rotate the ElevenLabs key
// 2. Move the ElevenLabs call back server-side, hosted off Lovable
//    preview (Vercel/Netlify production deploy)
// 3. Delete this endpoint
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export const Route = createFileRoute("/api/public/elevenlabs-key")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async () => {
        const key = process.env.ELEVENLABS_API_KEY;
        if (!key) {
          return new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }), {
            status: 500,
            headers: { "content-type": "application/json", ...CORS },
          });
        }
        return new Response(JSON.stringify({ key }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
        });
      },
    },
  },
});
