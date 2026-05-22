import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY is not configured" }), {
            status: 500, headers: { "content-type": "application/json" },
          });
        }
        try {
          const inForm = await request.formData();
          const file = inForm.get("file");
          if (!(file instanceof Blob)) {
            return new Response(JSON.stringify({ error: "Missing 'file' field" }), {
              status: 400, headers: { "content-type": "application/json" },
            });
          }
          const filename = (inForm.get("filename") as string) || "audio.mp3";

          const fd = new FormData();
          fd.append("file", file, filename);
          fd.append("model_id", "scribe_v2");
          fd.append("diarize", "false");
          fd.append("tag_audio_events", "false");

          const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
            method: "POST",
            headers: { "xi-api-key": apiKey },
            body: fd,
          });
          if (!res.ok) {
            const err = await res.text();
            return new Response(JSON.stringify({ error: `ElevenLabs ${res.status}: ${err.slice(0, 300)}` }), {
              status: 502, headers: { "content-type": "application/json" },
            });
          }
          const json = (await res.json()) as {
            text?: string;
            words?: Array<{ text: string; start: number; end: number; type?: string }>;
          };
          const words = (json.words ?? [])
            .filter((w) => (w.type ?? "word") === "word" && typeof w.start === "number")
            .map((w) => ({ text: w.text, start: w.start, end: w.end }));
          return new Response(JSON.stringify({ words, text: json.text ?? "" }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Transcription failed" }), {
            status: 500, headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
