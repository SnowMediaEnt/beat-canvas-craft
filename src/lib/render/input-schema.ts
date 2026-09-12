import { z } from "zod";

// ONE schema for the props that travel from the browser → server function →
// Lambda → Remotion composition. The server used to keep its own copy that
// silently dropped newer fields (the lyric timing offset never reached
// Lambda). Both sides import this file now.

export const lyricWordSchema = z.object({ time: z.number(), text: z.string() });

export const lyricLineSchema = z.object({
  time: z.number(),
  text: z.string(),
  words: z.array(lyricWordSchema).optional(),
});

export const lyricsInputSchema = z.object({
  enabled: z.boolean(),
  lines: z.array(lyricLineSchema),
  style: z.string(),
  position: z.string(),
  fontFamily: z.string(),
  fontSize: z.number(),
  color: z.string(),
  outline: z.boolean(),
  shadow: z.boolean(),
  glow: z.boolean(),
  fade: z.boolean(),
  timingOffset: z.number().min(-30).max(30).optional(),
  animation: z.string().optional(),
  wordHighlight: z.boolean().optional(),
  showNext: z.boolean().optional(),
  highlightColor: z.string().optional(),
  uppercase: z.boolean().optional(),
});

/** Hard ceilings: the UI never sends more, and a leaked access code must not
 *  be able to dispatch a 16K/240fps/hour-long render. */
export const MAX_RENDER_DIMENSION = 3840;
export const MAX_RENDER_DURATION_SECONDS = 1800;
export const RENDER_FPS_OPTIONS = [30, 45, 60, 120] as const;

export const renderInputPropsSchema = z.object({
  audioUrl: z.string().url(),
  durationSeconds: z.number().positive().max(MAX_RENDER_DURATION_SECONDS),
  fps: z.union([z.literal(30), z.literal(45), z.literal(60), z.literal(120)]),
  width: z.number().int().min(16).max(MAX_RENDER_DIMENSION),
  height: z.number().int().min(16).max(MAX_RENDER_DIMENSION),
  /** "high" | "standard" — picks encoder settings (see lambda.functions.ts). */
  quality: z.enum(["high", "standard"]).optional(),
  backgroundUrl: z.string().url().nullable(),
  backgroundType: z.string().nullable(),
  /** Solid colour background ("#rrggbb") — used instead of uploading a 16px PNG. */
  backgroundColor: z.string().regex(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i).nullable().optional(),
  logoUrl: z.string().url().nullable(),
  // Visualizer + effects are opaque records: the composition treats them as
  // the same TypeScript types the editor uses, and migrateProject already
  // sanitised them client-side.
  visualizer: z.record(z.string(), z.any()),
  effects: z.record(z.string(), z.any()),
  lyrics: lyricsInputSchema,
  /** Song title for text-based presets. */
  title: z.string().max(200).optional(),
  /** Drawing-engine version the app was built with (see engine-version.ts). */
  engineVersion: z.number().int().optional(),
});

export type RenderInputProps = z.infer<typeof renderInputPropsSchema>;
