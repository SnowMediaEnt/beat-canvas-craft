// Shared draw pipeline used by BOTH the live preview canvas
// (VisualizerCanvas.tsx) and the Remotion composition (VisualizerComp.tsx).
// Keeping every layer in one place is the only way to guarantee the rendered
// MP4 matches what users see in the editor.

import type { EffectsConfig, LyricsConfig, VisualizerConfig } from "../project/types";
import type { AudioData } from "./audioEngine";
import { drawEffects } from "./effects";
import { getPreset } from "./presets";
import type { CurrentLyric } from "./presets-core";
import {
  acquireLayer, clamp01, deviceScale, easeOutCubic, hash1, kickOf, lerp, withGlowLayer,
} from "./draw-utils";
import { lyricFontStack, resolveLyricFontWeight } from "./fonts";

/**
 * Reference resolution. All pixel-absolute values inside presets, effects,
 * lyrics, and logo drawing are authored against a 1080p baseline. The
 * foreground is drawn under `ctx.scale(h / 1080)` so the same numbers look
 * proportionally correct at 720p, 1440p and 4K.
 *
 * NOTE: canvas shadows (blur/offset) and `ctx.filter` blur are applied in
 * DEVICE pixels and ignore the transform — every such value is multiplied by
 * the device scale (deviceScale / baselineScale) so glows and background blur
 * keep the same proportion in the small preview canvas and a 4K export.
 */
export const RENDER_BASELINE_HEIGHT = 1080;
export const baselineScale = (deviceHeight: number) =>
  Math.max(0.0001, Number.isFinite(deviceHeight) && deviceHeight > 0 ? deviceHeight / RENDER_BASELINE_HEIGHT : 1);

// ─── Camera ──────────────────────────────────────────────────────────────

export interface CameraTransform { zoom: number; dx: number; dy: number }

/**
 * Whole-frame "camera": kick-driven punch-in plus a deterministic handheld
 * shake. Applied identically to the background and the foreground so the
 * picture moves as one. dx/dy are fractions of the frame size.
 */
export function cameraTransform(audio: AudioData, effects: EffectsConfig): CameraTransform {
  const cam = effects.camera;
  if (!cam || (cam.zoom <= 0 && cam.shake <= 0)) return { zoom: 1, dx: 0, dy: 0 };
  const k = kickOf(audio);
  const zoom = 1 + Math.max(0, cam.zoom) * k;
  // Hash on a 60 Hz time grid so preview and render shake the same way.
  const frameIdx = Math.round(audio.time * 60);
  const amp = Math.max(0, cam.shake) * k * 0.012;
  const dx = (hash1(frameIdx, 11) - 0.5) * amp;
  const dy = (hash1(frameIdx, 12) - 0.5) * amp * 0.75;
  return { zoom, dx, dy };
}

function applyCamera(ctx: CanvasRenderingContext2D, cam: CameraTransform, w: number, h: number) {
  if (cam.zoom === 1 && cam.dx === 0 && cam.dy === 0) return;
  ctx.translate(w / 2 + cam.dx * w, h / 2 + cam.dy * h);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-w / 2, -h / 2);
}

// ─── Background ──────────────────────────────────────────────────────────

/**
 * Per-image pre-blur cache. Applying `ctx.filter = "blur(Npx)"` on a large
 * background image every frame re-rasterises the blur on the CPU (Lambda
 * uses SwiftShader — no GPU). The background doesn't change between frames,
 * so we rasterise it once into an offscreen canvas keyed by (image identity +
 * blur + target size) and reuse the bitmap for every subsequent frame.
 */
type BlurCacheEntry = { key: string; canvas: HTMLCanvasElement };
const blurredBgCache = new WeakMap<object, BlurCacheEntry>();

export type BackgroundSource = CanvasImageSource & {
  naturalWidth?: number; naturalHeight?: number;
  videoWidth?: number; videoHeight?: number;
  width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength;
};

export function sourceSize(src: BackgroundSource): { w: number; h: number } {
  const nw = (src as HTMLImageElement).naturalWidth;
  const nh = (src as HTMLImageElement).naturalHeight;
  if (nw && nh) return { w: nw, h: nh };
  const vw = (src as HTMLVideoElement).videoWidth;
  const vh = (src as HTMLVideoElement).videoHeight;
  if (vw && vh) return { w: vw, h: vh };
  const w = (src as { width?: number }).width;
  const h = (src as { height?: number }).height;
  if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) return { w, h };
  return { w: 0, h: 0 };
}

export function getBlurredBackground(
  src: BackgroundSource,
  blurPx: number,
  targetW: number,
  targetH: number,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const { w: iw, h: ih } = sourceSize(src);
  if (!iw || !ih || targetW <= 0 || targetH <= 0) return null;
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round(targetH));
  const key = `${w}x${h}|${Math.round(blurPx * 10)}`;
  const existing = blurredBgCache.get(src as object);
  if (existing && existing.key === key) return existing.canvas;
  const off = existing?.canvas ?? document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d");
  if (!octx) return null;
  octx.clearRect(0, 0, w, h);
  if (blurPx > 0) octx.filter = `blur(${blurPx}px)`;
  octx.drawImage(src, 0, 0, w, h);
  octx.filter = "none";
  blurredBgCache.set(src as object, { key, canvas: off });
  return off;
}

export interface BackgroundArgs {
  ctx: CanvasRenderingContext2D;
  /** Device pixel size of the target canvas. */
  w: number;
  h: number;
  cfg: VisualizerConfig;
  audio: AudioData;
  effects: EffectsConfig;
  /** Image element, video element, or a video frame (ImageBitmap/HTMLImageElement). */
  source?: BackgroundSource | null;
  /** True when `source` never changes (static image) so the blurred bitmap can be cached. */
  cacheable?: boolean;
  /** Solid colour background ("#rrggbb"). Used when there is no image/video. */
  color?: string | null;
}

/**
 * Paints everything BEHIND the visualizer: base fill (black or solid colour),
 * cover-fitted image/video with scale + baseline-scaled blur, tint, the
 * background-pulse effect and the overlay. Runs in device pixels.
 */
export function drawBackgroundLayers(args: BackgroundArgs) {
  const { ctx, w, h, cfg, audio, effects, source, cacheable, color } = args;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.shadowBlur = 0;

  ctx.fillStyle = color && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : "#000";
  ctx.fillRect(0, 0, w, h);

  const cam = cameraTransform(audio, effects);
  applyCamera(ctx, cam, w, h);

  if (source) {
    const { w: iw, h: ih } = sourceSize(source);
    if (iw && ih) {
      const zoomPulse = 1 + Math.max(0, effects.bgZoomPulse ?? 0) * audio.bass;
      // Overscan slightly when shaking so edges never expose the base fill.
      const overscan = 1 + Math.max(0, effects.camera?.shake ?? 0) * 0.02;
      const scale = Math.max(w / iw, h / ih) * (cfg.backgroundScale || 1) * zoomPulse * overscan;
      const dw = iw * scale, dh = ih * scale;
      const dx = (w - dw) / 2;
      const dy = (h - dh) / 2;
      // backgroundBlur is authored in 1080p pixels.
      const blurPx = Math.max(0, cfg.backgroundBlur || 0) * baselineScale(h);
      let drawn = false;
      if (blurPx > 0.25 && cacheable) {
        const blurred = getBlurredBackground(source, blurPx, dw, dh);
        if (blurred) {
          ctx.drawImage(blurred, dx, dy, dw, dh);
          drawn = true;
        }
      }
      if (!drawn) {
        if (blurPx > 0.25) ctx.filter = `blur(${blurPx}px)`;
        try { ctx.drawImage(source, dx, dy, dw, dh); } catch { /* frame not ready */ }
        ctx.filter = "none";
      }
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (cfg.backgroundTintOpacity > 0) {
    ctx.fillStyle = cfg.backgroundTint;
    ctx.globalAlpha = clamp01(cfg.backgroundTintOpacity);
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  if (effects.backgroundPulse) {
    ctx.fillStyle = `rgba(255,255,255,${audio.bass * 0.08})`;
    ctx.fillRect(0, 0, w, h);
  }

  if (cfg.overlayOpacity > 0) {
    ctx.fillStyle = cfg.overlay;
    ctx.globalAlpha = clamp01(cfg.overlayOpacity);
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ─── Lyrics helpers ──────────────────────────────────────────────────────

/** Resolve the active lyric line at `audioTime` (with timing offset applied). */
export function getCurrentLyric(L: LyricsConfig, audioTime: number): CurrentLyric | null {
  if (!L.enabled || !L.lines.length) return null;
  const time = audioTime + (L.timingOffset ?? 0);
  // Lines are kept sorted by the editor; tolerate unsorted input cheaply.
  let lines = L.lines;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].time < lines[i - 1].time) { lines = [...lines].sort((a, b) => a.time - b.time); break; }
  }
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= time) idx = i;
    else break;
  }
  if (idx < 0) return null;
  const cur = lines[idx];
  const next = lines[idx + 1];
  const lineEnd = next ? next.time : cur.time + 4;
  const lineDuration = Math.max(0.25, lineEnd - cur.time);
  return {
    text: cur.text,
    index: idx,
    progress: clamp01((time - cur.time) / lineDuration),
    lineStart: cur.time,
    lineEnd,
    age: Math.max(0, time - cur.time),
    nextText: next?.text,
  };
}

// ─── Trails buffer (phosphor after-images) ───────────────────────────────
const trailBuffers = new Map<string, { canvas: HTMLCanvasElement; lastTime: number }>();

function trailBuffer(key: string, w: number, h: number) {
  if (typeof document === "undefined") return null;
  let entry = trailBuffers.get(key);
  if (!entry) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    entry = { canvas, lastTime: -1 };
    trailBuffers.set(key, entry);
  } else if (entry.canvas.width !== w || entry.canvas.height !== h) {
    entry.canvas.width = w; entry.canvas.height = h;
    entry.lastTime = -1;
  }
  return entry;
}

interface BaseDrawArgs {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  cfg: VisualizerConfig;
  audio: AudioData;
  t: number;
  logo?: HTMLImageElement;
  dt?: number;
  stateKey?: string;
  lyric?: CurrentLyric | null;
  title?: string;
  logoFx?: { scale: number; hop: number };
  /** Effects that operate on the composited visualizer layer. */
  effects?: EffectsConfig;
}

/**
 * Wraps preset.draw with the shared Motion → Movement / Shadow / Blur / Border
 * treatment and the layer-based effects (reflection, trails, ghost split).
 *
 * The preset is drawn into ONE pooled offscreen layer whenever shadow, blur
 * or a layer effect is active, and composited once. Previously the shadow
 * (default 0.4 → 24 px) and blur were armed *before* preset.draw, so every
 * primitive of every preset paid its own blur pass on SwiftShader.
 */
export function drawVisualizerLayer(args: BaseDrawArgs) {
  const { ctx, w, h, cfg, audio, t, logo, dt, stateKey, lyric, title, logoFx, effects } = args;
  const preset = getPreset(cfg.presetId);
  const dev = deviceScale(ctx);
  const shadow = Math.max(0, cfg.shadow ?? 0);
  const blur = Math.max(0, cfg.blur ?? 0);
  const reflection = effects?.reflection?.enabled ? effects.reflection : null;
  const trails = effects?.trails?.enabled ? effects.trails : null;
  const split = Math.max(0, effects?.beatSplit ?? 0);
  const needsLayer = shadow > 0 || blur > 0 || !!reflection || !!trails || split > 0;

  ctx.save();
  ctx.globalCompositeOperation = cfg.blendMode;
  // Never leave shadow state armed across the preset draw.
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.filter = "none";

  // Motion → Movement: gentle sway driven by the animation clock so the
  // visualizer "floats" inside the frame. 0 = locked, 1 = strong drift.
  const move = cfg.stationary ? 0 : (cfg.movement ?? 0);
  if (move > 0) {
    const ox = Math.sin(t * 0.6) * move * w * 0.04;
    const oy = Math.cos(t * 0.85) * move * h * 0.04;
    ctx.translate(ox, oy);
  }

  const drawPreset = (g: CanvasRenderingContext2D) =>
    preset.draw({ ctx: g, w, h, cfg, audio, t, logo, dt, stateKey, lyric, title, logoFx });

  if (!needsLayer) {
    drawPreset(ctx);
  } else {
    const key = stateKey ?? "main";
    withGlowLayer(
      ctx,
      {
        color: cfg.glow,
        intensity: shadow * 3,      // 60 px at shadow = 1 (matches the old shadow*60)
        radius: 20,
        offsetY: shadow * 12,
        blur,
        onLayer: (layer) => {
          const dw = layer.width, dh = layer.height;

          // Ghost split: two shifted copies on kicks.
          if (split > 0) {
            const k = kickOf(audio) * split;
            if (k > 0.05) {
              const off = 14 * k * dev;
              ctx.save();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.globalCompositeOperation = "screen";
              ctx.globalAlpha = 0.35 * clamp01(k * 2);
              ctx.drawImage(layer, -off, 0);
              ctx.drawImage(layer, off, 0);
              ctx.restore();
            }
          }

          // Floor reflection: flipped strip under a horizon, fading downward.
          if (reflection) {
            const tmp = acquireLayer(ctx);
            if (tmp) {
              try {
                const tc = tmp.ctx;
                tc.setTransform(1, 0, 0, 1, 0, 0);
                const horizonY = reflection.horizon * dh;
                tc.save();
                tc.beginPath();
                tc.rect(0, horizonY, dw, dh - horizonY);
                tc.clip();
                tc.translate(0, 2 * horizonY);
                tc.scale(1, -1);
                tc.drawImage(layer, 0, 0);
                tc.restore();
                const fade = tc.createLinearGradient(0, horizonY, 0, horizonY + reflection.height * dh);
                fade.addColorStop(0, "rgba(0,0,0,1)");
                fade.addColorStop(1, "rgba(0,0,0,0)");
                tc.globalCompositeOperation = "destination-in";
                tc.fillStyle = fade;
                tc.fillRect(0, horizonY, dw, dh - horizonY);
                tc.globalCompositeOperation = "source-over";
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = clamp01(reflection.opacity);
                ctx.drawImage(tmp.canvas, 0, 0);
                ctx.restore();
              } finally {
                tmp.release();
              }
            }
          }

          // Phosphor trails: persistent buffer fades each frame, current layer is added after blitting.
          if (trails) {
            const buf = trailBuffer(`trail:${key}`, dw, dh);
            if (buf) {
              const bc = buf.canvas.getContext("2d");
              if (bc) {
                const time = audio.time;
                const jumped = buf.lastTime >= 0 && Math.abs(time - buf.lastTime) > 0.5;
                if (jumped) { bc.setTransform(1, 0, 0, 1, 0, 0); bc.clearRect(0, 0, dw, dh); }
                buf.lastTime = time;
                const frameDt = Math.max(0.001, Math.min(0.25, dt ?? 1 / 60));
                const keep = Math.pow(clamp01(trails.decay), frameDt * 60);
                bc.setTransform(1, 0, 0, 1, 0, 0);
                bc.globalCompositeOperation = "destination-in";
                bc.fillStyle = `rgba(0,0,0,${keep})`;
                bc.fillRect(0, 0, dw, dh);
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalCompositeOperation = "lighter";
                ctx.globalAlpha = 0.85;
                ctx.drawImage(buf.canvas, 0, 0);
                ctx.restore();
                bc.globalCompositeOperation = "lighter";
                bc.globalAlpha = 0.9;
                bc.drawImage(layer, 0, 0);
                bc.globalAlpha = 1;
                bc.globalCompositeOperation = "source-over";
              }
            }
          }
        },
      },
      drawPreset,
    );
  }
  ctx.restore();

  // Motion → Border: inner stroke around the whole frame, reactive to bass.
  const border = cfg.border ?? 0;
  if (border > 0) {
    ctx.save();
    const thickness = Math.max(1, border * 24 * (1 + audio.bass * 0.4));
    ctx.strokeStyle = cfg.primary;
    ctx.shadowColor = cfg.glow;
    ctx.shadowBlur = 20 * border * dev;
    ctx.lineWidth = thickness;
    ctx.strokeRect(thickness / 2, thickness / 2, w - thickness, h - thickness);
    ctx.restore();
  }
}

/** Word-wrap `words` to `maxWidth`, returning wrapped lines as arrays of word indices. */
function wrapWords(ctx: CanvasRenderingContext2D, words: string[], maxWidth: number): number[][] {
  const lines: number[][] = [];
  let cur: number[] = [];
  let curText = "";
  for (let i = 0; i < words.length; i++) {
    const test = curText ? curText + " " + words[i] : words[i];
    if (ctx.measureText(test).width <= maxWidth || cur.length === 0) {
      cur.push(i);
      curText = test;
    } else {
      lines.push(cur);
      cur = [i];
      curText = words[i];
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/**
 * Draws the active lyric line. Supports subtitle / karaoke styles, fade,
 * entrance animations (slide / pop / typewriter), word-level highlighting
 * when word timings are available, and an optional "next line" preview.
 */
export function drawLyrics(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  L: LyricsConfig,
  audioTime: number,
  glowColor: string,
  precomputed?: CurrentLyric | null,
) {
  const cur = precomputed === undefined ? getCurrentLyric(L, audioTime) : precomputed;
  if (!cur) return;
  const time = audioTime + (L.timingOffset ?? 0);
  const dev = deviceScale(ctx);
  const lineDuration = Math.max(0.25, cur.lineEnd - cur.lineStart);

  // Fade: 250ms ease in / out. When `fade` is off, alpha is always 1.
  let alpha = 1;
  if (L.fade) {
    const fadeDur = 0.25;
    const fadeIn = Math.min(1, cur.age / fadeDur);
    const fadeOut = Math.min(1, (cur.lineEnd - time) / fadeDur);
    alpha = clamp01(Math.min(1, fadeIn) * Math.min(1, fadeOut));
    if (alpha <= 0.001) return;
  }

  const animation = L.animation ?? "none";
  const rawText = L.uppercase ? cur.text.toUpperCase() : cur.text;
  const weight = resolveLyricFontWeight(L.fontFamily, 600);
  const fontStack = lyricFontStack(L.fontFamily);
  const highlight = L.highlightColor || glowColor;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${L.fontSize}px ${fontStack}`;
  const maxWidth = w * 0.8;
  const lineHeight = L.fontSize * 1.2;

  // Entrance transforms (in baseline units — we're inside the baseline scale).
  let offsetY = 0;
  let scale = 1;
  if (animation === "slide") {
    offsetY = (1 - easeOutCubic(cur.age / 0.28)) * 40;
  } else if (animation === "pop") {
    const a = cur.age;
    scale = a < 0.22 ? lerp(0.85, 1.05, easeOutCubic(a / 0.22)) : lerp(1.05, 1, clamp01((a - 0.22) / 0.12));
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

  // Word layout (word wrap by whole words; emergency per-character split for
  // single words wider than the box).
  let words = rawText.split(" ").filter((s) => s.length > 0);
  if (words.length === 1 && ctx.measureText(words[0]).width > maxWidth) {
    const chars = Array.from(words[0]);
    const chunks: string[] = [];
    let built = "";
    for (const ch of chars) {
      if (ctx.measureText(built + ch).width <= maxWidth) built += ch;
      else { if (built) chunks.push(built); built = ch; }
    }
    if (built) chunks.push(built);
    words = chunks;
  }
  const wrapped = wrapWords(ctx, words, maxWidth);
  const totalHeight = wrapped.length * lineHeight;
  const startY = y - totalHeight / 2 + lineHeight / 2 + offsetY;

  // Typewriter: how many characters are visible.
  let visibleChars = Number.POSITIVE_INFINITY;
  if (animation === "typewriter") {
    const revealDur = Math.min(1.2, lineDuration * 0.6);
    visibleChars = Math.floor(rawText.length * clamp01(cur.age / Math.max(0.05, revealDur)));
  }

  // Karaoke progress: word-level when timings exist, else linear.
  const isKaraoke = L.style === "karaoke";
  const srcLine = L.lines[cur.index];
  const wordTimes = srcLine && srcLine.words && srcLine.words.length === words.length && (L.wordHighlight ?? true)
    ? srcLine.words.map((wd) => wd.time)
    : null;
  const lineProgress = isKaraoke ? clamp01((time - cur.lineStart) / lineDuration) : 1;

  const applyShadow = () => {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if (L.shadow) { ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 8 * dev; ctx.shadowOffsetY = 2 * dev; }
    if (L.glow) { ctx.shadowColor = glowColor; ctx.shadowBlur = 20 * dev; ctx.shadowOffsetY = 0; }
  };

  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.translate(-x, -y);

  const spaceW = ctx.measureText(" ").width;
  let charCursor = 0;

  for (let li = 0; li < wrapped.length; li++) {
    const lineY = startY + li * lineHeight;
    const idxs = wrapped[li];
    const lineWords = idxs.map((i) => words[i]);
    const fullLine = lineWords.join(" ");
    const lineW = ctx.measureText(fullLine).width;
    let lineX0 = x;
    if (textAlign === "center") lineX0 = x - lineW / 2;
    else if (textAlign === "right") lineX0 = x - lineW;

    // Typewriter clipping of this wrapped line.
    let lineText = fullLine;
    if (Number.isFinite(visibleChars)) {
      const remaining = Math.max(0, visibleChars - charCursor);
      lineText = fullLine.slice(0, remaining);
      charCursor += fullLine.length + 1;
      if (!lineText) continue;
    }

    ctx.textAlign = "left";
    applyShadow();

    // Outline always drawn first so revealed text sits on top of it.
    if (L.outline) {
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.strokeText(lineText, lineX0, lineY);
    }

    if (!isKaraoke) {
      ctx.fillStyle = L.color;
      ctx.fillText(lineText, lineX0, lineY);
      continue;
    }

    // Karaoke — dimmed full line first.
    ctx.save();
    ctx.globalAlpha = alpha * 0.45;
    ctx.fillStyle = L.color;
    ctx.fillText(lineText, lineX0, lineY);
    ctx.restore();

    // Highlight sweep. Word timings → per-word; otherwise proportional clip.
    let revealW = 0;
    if (wordTimes) {
      let cx0 = 0;
      for (let k = 0; k < idxs.length; k++) {
        const wi = idxs[k];
        const wordW = ctx.measureText(lineWords[k]).width;
        const start = wordTimes[wi];
        const end = wi + 1 < wordTimes.length ? wordTimes[wi + 1] : cur.lineEnd;
        if (time >= end) revealW = cx0 + wordW;
        else if (time >= start) {
          const p = clamp01((time - start) / Math.max(0.05, end - start));
          revealW = cx0 + wordW * p;
          break;
        } else break;
        cx0 += wordW + spaceW;
      }
    } else {
      const totalChars = words.join(" ").length;
      const before = wrapped.slice(0, li).reduce((s, ids) => s + ids.map((i) => words[i]).join(" ").length + 1, 0);
      const p = clamp01((lineProgress * totalChars - before) / Math.max(1, fullLine.length));
      revealW = lineW * p;
    }
    if (revealW > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(lineX0 - 2, lineY - lineHeight, revealW + 2, lineHeight * 2);
      ctx.clip();
      ctx.fillStyle = highlight;
      ctx.fillText(lineText, lineX0, lineY);
      ctx.restore();
    }
  }

  // Upcoming line preview.
  if (L.showNext && cur.nextText && animation !== "typewriter") {
    const nextText = L.uppercase ? cur.nextText.toUpperCase() : cur.nextText;
    ctx.save();
    ctx.globalAlpha = alpha * 0.45;
    ctx.font = `${weight} ${Math.round(L.fontSize * 0.62)}px ${fontStack}`;
    ctx.textAlign = textAlign;
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 6 * dev;
    ctx.fillStyle = L.color;
    const ny = L.position === "top" ? startY - lineHeight * 0.9 : startY + totalHeight + lineHeight * 0.2;
    const maxNext = w * 0.8;
    let nt = nextText;
    while (nt.length > 4 && ctx.measureText(nt).width > maxNext) nt = nt.slice(0, -2);
    if (nt !== nextText) nt = nt.slice(0, -1) + "…";
    ctx.fillText(nt, x, ny);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Unified foreground pipeline shared by VisualizerCanvas (live) and
 * VisualizerComp (Remotion). Wraps visualizer/logo/effects/lyrics in a
 * 1080p-baseline ctx.scale so pixel-absolute values stay proportional
 * across resolutions, under the same camera transform as the background.
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
  dt?: number;
  stateKey?: string;
  title?: string;
}) {
  const { ctx, w, h, cfg, audio, t, effects, lyrics, logo, dt, stateKey, title } = args;
  const safe = (n: unknown, fallback = 0) =>
    typeof n === "number" && Number.isFinite(n) ? n : fallback;
  const scale = Math.max(0.0001, safe(h / RENDER_BASELINE_HEIGHT, 1));
  const vw = w / scale;
  const vh = h / scale;

  // Defensive gradient wrappers — Canvas throws a hard error if any
  // coordinate is NaN/Infinity. Any preset math can produce a stray
  // non-finite value on a quiet frame and that single NaN would abort the
  // entire Lambda render. Patch the two factories for the duration of this
  // draw call to swap bad inputs for finite fallbacks instead of throwing.
  const origLinear = ctx.createLinearGradient.bind(ctx);
  const origRadial = ctx.createRadialGradient.bind(ctx);
  const patched = ctx as CanvasRenderingContext2D & {
    createLinearGradient: CanvasRenderingContext2D["createLinearGradient"];
    createRadialGradient: CanvasRenderingContext2D["createRadialGradient"];
  };
  patched.createLinearGradient = (x0: number, y0: number, x1: number, y1: number) => {
    const sx0 = safe(x0);
    const sy0 = safe(y0);
    let sx1 = safe(x1, sx0 + 1);
    const sy1 = safe(y1, sy0);
    if (sx0 === sx1 && sy0 === sy1) sx1 = sx0 + 1;
    return origLinear(sx0, sy0, sx1, sy1);
  };
  patched.createRadialGradient = (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) => {
    const sr0 = Math.max(0, safe(r0));
    const sr1 = Math.max(sr0 + 0.0001, safe(r1, 1));
    return origRadial(safe(x0), safe(y0), sr0, safe(x1), safe(y1), sr1);
  };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  applyCamera(ctx, cameraTransform(audio, effects), w, h);
  ctx.scale(scale, scale);

  try {
    const preset = getPreset(cfg.presetId);
    const lyric = getCurrentLyric(lyrics, audio.time);

    // logoPulse  → bass-reactive scale (reacts to music)
    // logoBounce → exaggerated vertical hop on beats (independent toggle)
    const kick = kickOf(audio);
    const pulse = effects.logoPulse ? 1 + audio.bass * 0.35 + kick * 0.18 : 1;
    const hop = effects.logoBounce ? -Math.abs(Math.sin(t * 6)) * audio.bass * vh * 0.06 : 0;

    drawVisualizerLayer({
      ctx, w: vw, h: vh, cfg, audio, t, logo: logo ?? undefined, dt, stateKey, lyric, title,
      logoFx: { scale: pulse, hop }, effects,
    });

    if (logo && !preset.consumesLogo) {
      const lsize = Math.min(vw, vh) * cfg.logoSize * pulse;
      const lx = vw / 2 + cfg.logoPosition.x * vw / 2 - lsize / 2;
      const ly = vh / 2 + cfg.logoPosition.y * vh / 2 - lsize / 2 + hop;
      ctx.save();
      if (cfg.glowIntensity > 0) {
        ctx.shadowColor = cfg.glow;
        ctx.shadowBlur = 30 * cfg.glowIntensity * (1 + audio.bass * 0.5) * scale;
      }
      ctx.drawImage(logo, lx, ly, lsize, lsize);
      ctx.restore();
    }

    drawEffects({ ctx, w: vw, h: vh, cfg, audio, t, dt, stateKey }, effects);
    drawLyrics(ctx, vw, vh, lyrics, audio.time, cfg.glow, lyric);
  } finally {
    ctx.restore();
    patched.createLinearGradient = origLinear;
    patched.createRadialGradient = origRadial;
  }
}
