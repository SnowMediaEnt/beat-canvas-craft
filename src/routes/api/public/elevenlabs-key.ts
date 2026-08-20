// Server-side ElevenLabs speech-to-text proxy.
//
// SECURITY: this endpoint used to return the raw ELEVENLABS_API_KEY to the
// browser (CORS *), which exposed the private key to anyone on the internet —
// they could scrape it and bill the owner's ElevenLabs account. It now runs the
// transcription server-side so the key NEVER leaves the server. GET returns
// 410 Gone so any stale client that still asks for the key fails closed instead
// of leaking it.
//
// Follow-ups (not blockers for the key fix): this route is still
// unauthenticated because the app has no user accounts — add rate limiting /
// auth before opening to more users. Also rotate ELEVENLABS_API_KEY once, since
// the previous key was reachable from any deployed instance and must be treated
// as compromised.
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });

export const Route = createFileRoute("/api/public/elevenlabs-key")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),

      // The key is no longer exposed. Fail closed for any client still asking.
      GET: async () =>
        json({ error: "Gone. This endpoint no longer returns the API key. POST audio to transcribe." }, 410),

      POST: async ({ request }) => {
        const key = process.env.ELEVENLABS_API_KEY;
        if (!key) return json({ error: "ELEVENLABS_API_KEY not configured" }, 500);

        let inbound: FormData;
        try {
          inbound = await request.formData();
        } catch {
          return json({ error: "Expected multipart/form-data with a 'file' field" }, 400);
        }

        const file = inbound.get("file");
        if (!(file instanceof File) && !(file instanceof Blob)) {
          return json({ error: "Missing 'file'" }, 400);
        }

        // Rebuild the multipart body server-side and forward to ElevenLabs with
        // the server-held key. Pass through the tuning fields the client sends.
        const fd = new FormData();
        fd.append("file", file, (file as File).name || "audio");
        fd.append("model_id", String(inbound.get("model_id") || "scribe_v2"));
        fd.append("timestamps_granularity", String(inbound.get("timestamps_granularity") || "word"));
        fd.append("diarize", String(inbound.get("diarize") || "false"));
        fd.append("tag_audio_events", String(inbound.get("tag_audio_events") || "false"));

        let upstream: Response;
        try {
          upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
            method: "POST",
            headers: { "xi-api-key": key },
            body: fd,
          });
        } catch (e) {
          return json({ error: "Transcription upstream failed", detail: String(e) }, 502);
        }

        // Relay ElevenLabs' response verbatim (same JSON shape the client parsed
        // before), but never the key.
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
            "cache-control": "no-store",
            ...CORS,
          },
        });
      },
    },
  },
});
