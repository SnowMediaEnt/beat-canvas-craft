import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-requested-with",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

export const Route = createFileRoute("/api/public/transcribe")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),

      POST: async ({ request }) => {
        const ts = new Date().toISOString();
        const ct = request.headers.get("content-type") || "";
        const cl = request.headers.get("content-length") || "?";
        console.log(`[transcribe ${ts}] POST received | content-length=${cl} | content-type=${ct.slice(0, 80)}`);

        const apiKey = process.env.ELEVENLABS_API_KEY;
        console.log(`[transcribe ${ts}] ELEVENLABS_API_KEY present: ${Boolean(apiKey)}`);
        if (!apiKey) {
          return json({ error: "ELEVENLABS_API_KEY is not configured on the server" }, 500);
        }

        try {
          let inForm: FormData;
          try {
            inForm = await request.formData();
            console.log(`[transcribe ${ts}] FormData parsed OK | keys=${[...inForm.keys()].join(",")}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[transcribe ${ts}] FormData parse FAILED: ${msg}`);
            return json({ error: `Failed to parse upload: ${msg}`, stage: "formdata" }, 400);
          }

          const file = inForm.get("file");
          if (!(file instanceof Blob)) {
            console.warn(`[transcribe ${ts}] Missing 'file' field`);
            return json({ error: "Missing 'file' field in upload" }, 400);
          }
          const filename = (inForm.get("filename") as string) || "audio.mp3";
          console.log(`[transcribe ${ts}] file size=${file.size} bytes, filename=${filename}, type=${file.type}`);

          if (file.size > 100 * 1024 * 1024) {
            return json({ error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 100MB.` }, 413);
          }

          const fd = new FormData();
          fd.append("file", file, filename);
          fd.append("model_id", "scribe_v1");
          fd.append("timestamps_granularity", "word");
          fd.append("diarize", "false");
          fd.append("tag_audio_events", "false");

          console.log(`[transcribe ${ts}] -> POST https://api.elevenlabs.io/v1/speech-to-text (scribe_v1)`);
          const t0 = Date.now();
          const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
            method: "POST",
            headers: { "xi-api-key": apiKey },
            body: fd,
          });
          const dt = Date.now() - t0;
          console.log(`[transcribe ${ts}] <- ElevenLabs ${res.status} in ${dt}ms`);

          if (!res.ok) {
            const err = await res.text();
            console.error(`[transcribe ${ts}] ElevenLabs error body: ${err.slice(0, 500)}`);
            return json({ error: `ElevenLabs ${res.status}: ${err.slice(0, 500)}` }, 502);
          }

          const data = (await res.json()) as {
            text?: string;
            words?: Array<{ text: string; start: number; end: number; type?: string }>;
          };
          const words = (data.words ?? [])
            .filter((w) => (w.type ?? "word") === "word" && typeof w.start === "number")
            .map((w) => ({ text: w.text, start: w.start, end: w.end }));
          console.log(`[transcribe ${ts}] SUCCESS — ${words.length} words returned`);
          return json({ words, text: data.text ?? "" }, 200);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const stack = e instanceof Error ? e.stack : undefined;
          console.error(`[transcribe ${ts}] UNCAUGHT: ${msg}\n${stack}`);
          return json({ error: msg, stack: stack?.split("\n").slice(0, 5).join("\n") }, 500);
        }
      },
    },
  },
});
