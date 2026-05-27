// Shared draw helpers used by BOTH the live preview canvas
// (VisualizerCanvas.tsx) and the Remotion composition (VisualizerComp.tsx).
// Keeping these in one place is the only way to guarantee the rendered MP4
// matches what users see in the editor.

import type { EffectsConfig, LyricsConfig, VisualizerConfig } from "../project/types";
import type { AudioData } from "./audioEngine";
import { drawEffects } from "./effects";
import { getPreset } from "./presets";

/**
 * Reference resolution. All pixel-absolute values inside presets, effects,
 * lyrics, and logo drawing are authored against a 1080p baseline. The
 * `drawForegroundLayers` helper applies `ctx.scale(h / 1080, h / 1080)` so
 * the same numbers look proportionally correct at 720p, 1440p, and 4K.
 * Without this, a 4K render shows thinner bars / smaller glow / smaller
 * lyrics than the live preview at 1080p — the bug the user reported.
 */
export const RENDER_BASELINE_HEIGHT = 1080;

interface BaseDrawArgs {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  cfg: VisualizerConfig;
  audio: AudioData;
  t: number;
  logo?: HTMLImageElement;
}

/**
 * Wraps preset.draw with the shared Motion → Movement / Shadow / Border
 * treatment so both renderers produce identical output. Movement adds a
 * gentle sway, Shadow drops a coloured glow under the visualizer, Border
 * paints a ring around the canvas (drawn last so it sits on top).
 */
export function drawVisualizerLayer(args: BaseDrawArgs) {
  const { ctx, w, h, cfg, audio, t, logo } = args;
  const preset = getPreset(cfg.presetId);

  ctx.save();
  ctx.globalCompositeOperation = cfg.blendMode;
  if (cfg.blur > 0) ctx.filter = `blur(${cfg.blur}px)`;

  // Motion → Movement: gentle sway driven by the animation clock so the
  // visualizer "floats" inside the frame. 0 = locked, 1 = strong drift.
  const move = cfg.movement ?? 0;
  if (move > 0) {
    const ox = Math.sin(t * 0.6) * move * w * 0.04;
    const oy = Math.cos(t * 0.85) * move * h * 0.04;
    ctx.translate(ox, oy);
  }

  // Motion → Shadow: coloured drop shadow under the visualizer drawing.
  // Re-uses the configured glow colour for tonal consistency.
  const shadow = cfg.shadow ?? 0;
  if (shadow > 0) {
    ctx.shadowColor = cfg.glow;
    ctx.shadowBlur = shadow * 60;
    ctx.shadowOffsetY = shadow * 12;
  }

  preset.draw({ ctx, w, h, cfg, audio, t, logo });
  ctx.restore();

  // Motion → Border: inner stroke around the whole frame, reactive to bass.
  // Drawn outside the blend/shadow save block so it isn't tinted twice.
  const border = cfg.border ?? 0;
  if (border > 0) {
    ctx.save();
    const thickness = Math.max(1, border * 24 * (1 + audio.bass * 0.4));
    ctx.strokeStyle = cfg.primary;
    ctx.shadowColor = cfg.glow;
    ctx.shadowBlur = 20 * border;
    ctx.lineWidth = thickness;
    ctx.strokeRect(thickness / 2, thickness / 2, w - thickness, h - thickness);
    ctx.restore();
  }
}

/**
 * Draws the active lyric line. Supports `style: "subtitle" | "karaoke"`
 * and the `fade` toggle. The two renderers used to diverge on these — now
 * both call this single implementation.
 */
export function drawLyrics(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  L: LyricsConfig,
  audioTime: number,
  glowColor: string,
) {
  if (!L.enabled || !L.lines.length) return;

  // Find current + next line for karaoke progress and fade timing.
  const sorted = [...L.lines].sort((a, b) => a.time - b.time);
  let curIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].time <= audioTime) curIdx = i;
    else break;
  }
  if (curIdx < 0) return;
  const cur = sorted[curIdx];
  const next = sorted[curIdx + 1];
  const lineEnd = next ? next.time : cur.time + 4;
  const lineDuration = Math.max(0.25, lineEnd - cur.time);

  // Fade: 250ms ease in at the start of the line, 250ms ease out before the
  // next line takes over. When `fade` is off, alpha is always 1.
  let alpha = 1;
  if (L.fade) {
    const fadeDur = 0.25;
    const sinceStart = audioTime - cur.time;
    const untilEnd = lineEnd - audioTime;
    const fadeIn = Math.min(1, sinceStart / fadeDur);
    const fadeOut = Math.min(1, untilEnd / fadeDur);
    alpha = Math.max(0, Math.min(1, fadeIn) * Math.min(1, fadeOut));
    if (alpha <= 0.001) return;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 ${L.fontSize}px ${L.fontFamily}, sans-serif`;
  const maxWidth = w * 0.8;
  const lineHeight = L.fontSize * 1.2;

  // Word wrap (with emergency per-character break for huge single words).
  const words = cur.text.split(" ");
  const wrapped: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const test = currentLine ? currentLine + " " + word : word;
    if (ctx.measureText(test).width <= maxWidth) currentLine = test;
    else {
      if (currentLine) wrapped.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) wrapped.push(currentLine);
  if (wrapped.length === 1 && ctx.measureText(cur.text).width > maxWidth) {
    wrapped.length = 0;
    let built = "";
    for (const ch of cur.text) {
      if (ctx.measureText(built + ch).width <= maxWidth) built += ch;
      else { if (built) wrapped.push(built); built = ch; }
    }
    if (built) wrapped.push(built);
  }

  const textAlign: CanvasTextAlign =
    L.position === "left" ? "left" : L.position === "right" ? "right" : "center";
  ctx.textAlign = textAlign;
  ctx.textBaseline = "middle";

  let x = w / 2;
  let y = h - 120;
  if (L.position === "top") y = 120;
  if (L.position === "center") y = h / 2;
  if (L.position === "left") { x = 60; y = h / 2; }
  if (L.position === "right") { x = w - 60; y = h / 2; }

  const totalHeight = wrapped.length * lineHeight;
  const startY = y - totalHeight / 2 + lineHeight / 2;

  if (L.shadow) { ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 8; }
  if (L.glow)   { ctx.shadowColor = glowColor;        ctx.shadowBlur = 20; }

  // Karaoke: progress 0..1 across the line's duration. We draw the full
  // line dimmed, then a "revealed" copy clipped to the progress width.
  const isKaraoke = L.style === "karaoke";
  const progress = isKaraoke
    ? Math.max(0, Math.min(1, (audioTime - cur.time) / lineDuration))
    : 1;

  for (let li = 0; li < wrapped.length; li++) {
    const lineY = startY + li * lineHeight;
    const text = wrapped[li];
    const textW = ctx.measureText(text).width;

    // Outline always drawn first so revealed text sits on top of it.
    if (L.outline) {
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = 4;
      ctx.strokeText(text, x, lineY);
    }

    if (isKaraoke) {
      // Dimmed full line underneath…
      ctx.save();
      ctx.globalAlpha = alpha * 0.45;
      ctx.fillStyle = L.color;
      ctx.fillText(text, x, lineY);
      ctx.restore();

      // …then the revealed slice in the glow colour for that "highlight
      // sweep" karaoke look. Clip rectangle is anchored by textAlign.
      let clipX = x;
      if (textAlign === "center") clipX = x - textW / 2;
      else if (textAlign === "right") clipX = x - textW;
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipX, lineY - lineHeight, textW * progress, lineHeight * 2);
      ctx.clip();
      ctx.fillStyle = glowColor;
      ctx.fillText(text, x, lineY);
      ctx.restore();
    } else {
      ctx.fillStyle = L.color;
      ctx.fillText(text, x, lineY);
    }
  }
  ctx.restore();
}

/**
 * Unified foreground pipeline shared by VisualizerCanvas (live) and
 * VisualizerComp (Remotion). Wraps visualizer/logo/effects/lyrics in a
 * 1080p-baseline ctx.scale so pixel-absolute values stay proportional
 * across resolutions. Backgrounds, tints, and overlays remain in native
 * coords (they're full-frame fills with no magic numbers).
 */
export function drawForegroundLayers(args: {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  cfg: VisualizerConfig;
  audio: AudioData;
  t: number;
  effects: EffectsConfig;
  lyrics: LyricsConfig;
  logo?: HTMLImageElement | null;
}) {
  const { ctx, w, h, cfg, audio, t, effects, lyrics, logo } = args;
  const scale = h / RENDER_BASELINE_HEIGHT;
  const vw = w / scale;
  const vh = h / scale;

  ctx.save();
  ctx.scale(scale, scale);

  drawVisualizerLayer({ ctx, w: vw, h: vh, cfg, audio, t, logo: logo ?? undefined });

  if (logo) {
    // logoPulse  → bass-reactive scale (reacts to music)
    // logoBounce → exaggerated vertical hop on beats (independent toggle)
    const pulse = effects.logoPulse ? 1 + audio.bass * 0.35 + (audio.beat ? 0.18 : 0) : 1;
    const hop = effects.logoBounce ? -Math.abs(Math.sin(t * 6)) * audio.bass * vh * 0.06 : 0;
    const lsize = Math.min(vw, vh) * cfg.logoSize * pulse;
    const lx = vw / 2 + cfg.logoPosition.x * vw / 2 - lsize / 2;
    const ly = vh / 2 + cfg.logoPosition.y * vh / 2 - lsize / 2 + hop;
    ctx.save();
    if (cfg.glowIntensity > 0) {
      ctx.shadowColor = cfg.glow;
      ctx.shadowBlur = 30 * cfg.glowIntensity * (1 + audio.bass * 0.5);
    }
    ctx.drawImage(logo, lx, ly, lsize, lsize);
    ctx.restore();
  }

  drawEffects({ ctx, w: vw, h: vh, cfg, audio, t }, effects);
  drawLyrics(ctx, vw, vh, lyrics, audio.time, cfg.glow);

  ctx.restore();
}
