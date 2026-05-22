import { createServerFn } from "@tanstack/react-start";

export interface TranscribedWord {
  text: string;
  start: number;
  end: number;
}

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((input: { audioBase64: string; filename: string; mime: string }) => input)
  .handler(async ({ data }): Promise<{ words: TranscribedWord[]; text: string }> => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

    const bytes = Buffer.from(data.audioBase64, "base64");
    const blob = new Blob([bytes], { type: data.mime || "audio/mpeg" });

    const fd = new FormData();
    fd.append("file", blob, data.filename || "audio.mp3");
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
      throw new Error(`ElevenLabs Scribe error ${res.status}: ${err.slice(0, 300)}`);
    }
    const json = (await res.json()) as { text?: string; words?: Array<{ text: string; start: number; end: number; type?: string }> };
    const words = (json.words ?? [])
      .filter((w) => (w.type ?? "word") === "word" && typeof w.start === "number")
      .map((w) => ({ text: w.text, start: w.start, end: w.end }));
    return { words, text: json.text ?? "" };
  });
