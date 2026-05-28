import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * AI-driven preset generator. Takes a free-text prompt and returns a partial
 * VisualizerConfig + custom-equalizer settings the client merges into the
 * project. We force `presetId: "custom-equalizer"` so the result is fully
 * controlled by `cfg.custom` — which the preview AND Lambda render read from
 * the same draw function, guaranteeing 1:1 parity.
 */
export const generateVisualizerFromPrompt = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ prompt: z.string().min(2).max(500) }).parse(d))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");

    const tool = {
      type: "function" as const,
      function: {
        name: "design_visualizer",
        description: "Return a custom audio visualizer configuration matching the user's prompt.",
        parameters: {
          type: "object",
          properties: {
            primary: { type: "string", description: "Hex color, primary." },
            secondary: { type: "string" },
            accent: { type: "string" },
            glow: { type: "string" },
            backgroundTint: { type: "string" },
            backgroundTintOpacity: { type: "number", minimum: 0, maximum: 1 },
            glowIntensity: { type: "number", minimum: 0, maximum: 2 },
            movement: { type: "number", minimum: 0, maximum: 1.5 },
            shadow: { type: "number", minimum: 0, maximum: 1.5 },
            size: { type: "number", minimum: 0.4, maximum: 1.8 },
            thickness: { type: "number", minimum: 1, maximum: 24 },
            animationSpeed: { type: "number", minimum: 0.3, maximum: 2.5 },
            sensitivity: { type: "number", minimum: 0.5, maximum: 2.5, description: "Master gain across all bands." },
            bassSensitivity: { type: "number", minimum: 0.5, maximum: 2.5, description: "Low-frequency (kick/bass) gain. Default near 1.0." },
            midSensitivity: { type: "number", minimum: 0.5, maximum: 2.5, description: "Mid-frequency (vocals/snare/guitar) gain. Default near 1.0 — do NOT drop below 0.9 unless the prompt explicitly asks for a hollow / scooped sound, otherwise the visualizer goes flat through the most important part of the song." },
            trebleSensitivity: { type: "number", minimum: 0.5, maximum: 2.5, description: "High-frequency (hat/cymbal/air) gain. Default near 1.0." },
            bandCount: { type: "integer", minimum: 8, maximum: 192, description: "Number of frequency bands the equalizer resolves. 32–96 is a good default; lower for chunky/lofi, higher for detailed." },
            custom: {
              type: "object",
              properties: {
                shape: { type: "string", enum: ["bars", "mirrored", "radial", "ring", "wave", "dots", "triangles"] },
                count: { type: "integer", minimum: 8, maximum: 192 },
                spacing: { type: "number", minimum: 0, maximum: 0.8 },
                amplitude: { type: "number", minimum: 0.3, maximum: 2 },
                thickness: { type: "number", minimum: 0, maximum: 30 },
                rounded: { type: "boolean" },
                symmetric: { type: "boolean" },
                reactivity: { type: "number", minimum: 0.3, maximum: 2.5 },
                innerRadius: { type: "number", minimum: 0.05, maximum: 0.6 },
              },
              required: ["shape", "count", "spacing", "amplitude", "thickness", "rounded", "symmetric", "reactivity", "innerRadius"],
              additionalProperties: false,
            },
          },
          required: ["primary", "secondary", "accent", "glow", "bassSensitivity", "midSensitivity", "trebleSensitivity", "custom"],
          additionalProperties: false,
        },
      },
    };

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "You design audio visualizer presets. Choose shape + colors + motion that match the user's vibe. Be bold — pick complementary hex colors and exaggerate motion for energetic prompts. CRITICAL: keep the frequency spectrum balanced. Default bassSensitivity, midSensitivity, and trebleSensitivity all to ~1.0 (range 0.9–1.3) so the mid range — where vocals, snare, and most melody live — stays audible in the visualizer. Only push one band above 1.5 or below 0.9 when the prompt explicitly calls for it (e.g. 'bass-heavy', 'airy', 'crispy highs')." },
          { role: "user", content: data.prompt },
        ],
        tools: [tool],
        tool_choice: { type: "function", function: { name: "design_visualizer" } },
      }),
    });

    if (res.status === 429) throw new Error("Rate limited. Try again in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add funds in Settings → Workspace → Usage.");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI gateway error (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const args = json?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) throw new Error("AI returned no preset");
    return { patch: JSON.parse(args) as Record<string, string | number | boolean | Record<string, string | number | boolean>> };
  });
