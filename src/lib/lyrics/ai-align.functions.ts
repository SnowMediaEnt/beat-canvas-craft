import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * AI-driven lyric alignment. Sends the user's lyric lines + the
 * transcribed word timestamps from ElevenLabs to the Lovable AI gateway
 * and asks the model to return start times for each user line, choosing
 * the best matching transcript moment even when wording differs.
 *
 * This is the "smart" path triggered when the user wraps their pasted
 * lyrics in quotes ("...") — they're telling us these are authoritative
 * lyrics and we should align them to the audio rather than overwrite.
 */
export const aiAlignLyrics = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        lines: z.array(z.string().min(1).max(500)).min(1).max(400),
        words: z
          .array(
            z.object({
              text: z.string().max(80),
              start: z.number().min(0).max(36000),
              end: z.number().min(0).max(36000),
            }),
          )
          .min(1)
          .max(8000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");

    // Compact transcript: "[t=12.34] word word word\n[t=15.10] ..."
    // Group words into ~6-word chunks so the prompt stays small.
    const chunks: { t: number; text: string }[] = [];
    let buf: typeof data.words = [];
    const flush = () => {
      if (!buf.length) return;
      chunks.push({
        t: +buf[0].start.toFixed(2),
        text: buf.map((w) => w.text).join(" "),
      });
      buf = [];
    };
    for (let i = 0; i < data.words.length; i++) {
      buf.push(data.words[i]);
      const prev = data.words[i];
      const next = data.words[i + 1];
      const gap = next ? next.start - prev.end : 0;
      if (buf.length >= 6 || gap > 0.6) flush();
    }
    flush();

    const transcript = chunks.map((c) => `[t=${c.t}] ${c.text}`).join("\n");
    const lyricsBlock = data.lines.map((l, i) => `${i + 1}. ${l}`).join("\n");

    const tool = {
      type: "function" as const,
      function: {
        name: "align_lyrics",
        description:
          "Return the best start time (seconds) for each user lyric line based on the transcript timestamps.",
        parameters: {
          type: "object",
          properties: {
            times: {
              type: "array",
              description:
                "Array of start times in seconds, one per input lyric line, in the SAME order as the numbered input. Must monotonically increase.",
              items: { type: "number", minimum: 0 },
            },
          },
          required: ["times"],
          additionalProperties: false,
        },
      },
    };

    const sys =
      "You align song lyrics to a transcript of the same audio. The user's lyrics are authoritative — they may differ in wording from what was transcribed (mishears, fillers, ad-libs missed). For each numbered lyric line, pick the timestamp from the transcript where that line BEGINS being sung. Use semantic matching, not exact word matching. Timestamps must be strictly increasing across lines. If a line has no clear match (e.g. instrumental section), interpolate between neighbors. Return exactly one timestamp per input line.";

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: `TRANSCRIPT (with timestamps in seconds):\n${transcript}\n\nUSER LYRICS (${data.lines.length} lines, in order):\n${lyricsBlock}\n\nReturn ${data.lines.length} timestamps, one per line, in order.`,
          },
        ],
        tools: [tool],
        tool_choice: { type: "function", function: { name: "align_lyrics" } },
      }),
    });

    if (res.status === 429) throw new Error("Rate limited. Try again in a moment.");
    if (res.status === 402)
      throw new Error("AI credits exhausted. Add funds in Settings → Workspace → Usage.");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[ai-align] gateway error", res.status, text.slice(0, 500));
      throw new Error(`AI gateway error (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    let args = json?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments as string | undefined;
    // Fallback: some models return the JSON in the content field instead of tool_calls
    if (!args) {
      const content = json?.choices?.[0]?.message?.content as string | undefined;
      if (content) {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) args = m[0];
      }
    }
    if (!args) {
      console.error("[ai-align] no alignment in response", JSON.stringify(json).slice(0, 800));
      throw new Error("AI returned no alignment");
    }
    const parsed = JSON.parse(args) as { times: number[] };

    if (!Array.isArray(parsed.times) || parsed.times.length !== data.lines.length) {
      throw new Error(
        `AI returned ${parsed.times?.length ?? 0} times for ${data.lines.length} lines`,
      );
    }

    // Sanitize: clamp to audio bounds, enforce monotonic increase.
    const lastWordEnd = data.words[data.words.length - 1].end;
    const out: number[] = [];
    let prev = 0;
    for (let i = 0; i < parsed.times.length; i++) {
      let t = Number(parsed.times[i]);
      if (!Number.isFinite(t) || t < 0) t = prev + 0.5;
      if (t > lastWordEnd) t = lastWordEnd;
      if (t < prev) t = prev + 0.05;
      out.push(t);
      prev = t;
    }

    return { times: out };
  });
