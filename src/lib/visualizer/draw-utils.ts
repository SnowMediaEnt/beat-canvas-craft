// Shared drawing + audio-sampling helpers used by every preset pack and by
// effects. Keeping them in one module means a preset written in any file
// behaves identically in the live preview and inside the Remotion/Lambda
// render (both import this exact code).

import type { AudioData } from "./audioEngine";
import { AUDIBLE_MIN_HZ, AUDIBLE_MAX_HZ, BASS_MAX_HZ, MID_MAX_HZ, hzToBin, binToHz } from "./audioEngine";
import type { VisualizerConfig } from "../project/types";

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / Math.max(1e-6, e1 - e0));
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(t)));

export const finite = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const safeArrayValue = (arr: ArrayLike<number>, index: number) => {
  if (!arr.length) return 0;
  const clamped = Math.max(0, Math.min(arr.length - 1, index | 0));
  return finite(arr[clamped], 0);
};

/** "#rrggbb" (or "#rrggbbaa") → "rgba(r,g,b,a)". Tolerates bad input. */
export const hexA = (hex: string, a: number) => {
  const { r, g, b } = hexRGB(hex);
  return `rgba(${r},${g},${b},${clamp01(finite(a, 1))})`;
};

export const hexRGB = (hex: string) => {
  const h = (hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.substring(0, 2), 16);
  const g = parseInt(full.substring(2, 4), 16);
  const b = parseInt(full.substring(4, 6), 16);
  return {
    r: Number.isFinite(r) ? r : 255,
    g: Number.isFinite(g) ? g : 255,
    b: Number.isFinite(b) ? b : 255,
  };
};

/** Linear blend between two hex colours (t 0..1) → rgba string. */
export const mixHex = (a: string, b: string, t: number, alpha = 1) => {
  const A = hexRGB(a);
  const B = hexRGB(b);
  const k = clamp01(t);
  return `rgba(${Math.round(lerp(A.r, B.r, k))},${Math.round(lerp(A.g, B.g, k))},${Math.round(lerp(A.b, B.b, k))},${clamp01(alpha)})`;
};

/**
 * Scale factor of the context's current transform. Canvas shadows (blur +
 * offsets) and ctx.filter blur are applied in DEVICE pixels and ignore the
 * transform, so anything authored against the 1080p baseline must multiply
 * by this to look the same in the small preview canvas and a 4K export.
 */
export const deviceScale = (ctx: CanvasRenderingContext2D): number => {
  try {
    const m = ctx.getTransform();
    const s = Math.hypot(m.a, m.b);
    return s > 0 && Number.isFinite(s) ? s : 1;
  } catch {
    return 1;
  }
};

/** Per-stroke glow (baseline-scaled). Prefer withGlowLayer() for anything
 *  drawn more than a handful of times per frame — shadowBlur is a full CPU
 *  raster pass per stroke on SwiftShader (AWS Lambda). */
export const setGlow = (ctx: CanvasRenderingContext2D, color: string, intensity: number) => {
  ctx.shadowColor = color;
  ctx.shadowBlur = 20 * Math.max(0, finite(intensity, 0)) * deviceScale(ctx);
};

export const center = (d: { w: number; h: number; cfg: VisualizerConfig }) => ({
  cx: d.w / 2 + d.cfg.position.x * d.w / 2,
  cy: d.h / 2 + d.cfg.position.y * d.h / 2,
});

/** Deterministic hash in [0,1) for an integer-ish seed. Stable across runs. */
export const hash1 = (n: number, salt = 0) => {
  const s = Math.sin(n * 127.1 + salt * 311.7 + 0.1) * 43758.5453;
  return s - Math.floor(s);
};

/** Cheap smooth 2D value noise in [0,1). No allocations. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi), b = h(xi + 1, yi);
  const c = h(xi, yi + 1), dd = h(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + dd * u) * v;
}

/** Fractal (3-octave) value noise in roughly [0,1). */
export function fbm2(x: number, y: number): number {
  return (noise2(x, y) * 0.5 + noise2(x * 2.01, y * 2.03) * 0.3 + noise2(x * 4.07, y * 3.91) * 0.2);
}

/**
 * Sensitivity multiplier for a band, chosen by its REAL Hz frequency so the
 * bass/mid/treble sliders affect the same part of the spectrum in every
 * preset (bass < 250 Hz, mid 250–4000 Hz, treble > 4 kHz).
 */
export function bandMulForHz(hz: number, cfg?: VisualizerConfig): number {
  const master = cfg?.sensitivity ?? 1;
  const bassMul = cfg?.bassSensitivity ?? 1;
  const midMul = cfg?.midSensitivity ?? 1;
  const trebMul = cfg?.trebleSensitivity ?? 1;
  const band = hz < BASS_MAX_HZ ? bassMul : hz < MID_MAX_HZ ? midMul : trebMul;
  return master * band;
}

/** Sample a frequency bin (0..1) scaled by Hz-based sensitivity config. */
export function freqAt(freq: Uint8Array, idx: number, cfg?: VisualizerConfig, sampleRate = 48000): number {
  if (!freq.length) return 0;
  const i = Math.max(0, Math.min(freq.length - 1, idx | 0));
  const hz = binToHz(i, freq.length, sampleRate);
  return (safeArrayValue(freq, i) / 255) * bandMulForHz(hz, cfg);
}

/**
 * Sample the spectrum at a normalized spatial position (0..1), log-spaced
 * across the audible range, so left→right (or around a ring) covers the
 * full 20 Hz – 20 kHz range instead of only the bass-heavy first bins.
 * Interpolates between neighbouring bins (the low end of a log axis spans
 * only a handful of bins, which used to render as flat plateaus) and skips
 * the DC bin.
 */
export function freqAtPos(audio: AudioData, pos01: number, cfg?: VisualizerConfig, upper = 1): number {
  const freq = audio.freq;
  if (!freq.length) return 0;
  const sampleRate = audio.sampleRate && audio.sampleRate > 0 ? audio.sampleRate : 48000;
  const nyquist = sampleRate / 2;
  const minHz = 30;
  const maxHz = Math.min(nyquist, AUDIBLE_MAX_HZ * Math.max(0.05, Math.min(1, upper)));
  const p = clamp01(pos01);
  const hz = Math.exp(Math.log(minHz) + p * (Math.log(maxHz) - Math.log(minHz)));
  const bin = Math.max(1, Math.min(freq.length - 1, hzToBin(hz, freq.length, sampleRate)));
  const i0 = Math.floor(bin);
  const i1 = Math.min(freq.length - 1, i0 + 1);
  const f = bin - i0;
  const v = (safeArrayValue(freq, i0) * (1 - f) + safeArrayValue(freq, i1) * f) / 255;
  return v * bandMulForHz(hz, cfg);
}

// ─── Musical-feature accessors ───────────────────────────────────────────
// Every field is optional on AudioData (synthetic/legacy data may lack it);
// these fall back to the closest classic signal so presets never see NaN.

/** Kick envelope 0..1 (instant attack, ~140 ms release). */
export const kickOf = (a: AudioData) => (typeof a.kick === "number" ? a.kick : beatKick(a, 0.14));
/** Snare/clap envelope 0..1. */
export const snareOf = (a: AudioData) => (typeof a.snare === "number" ? a.snare : 0);
/** Hi-hat/cymbal envelope 0..1. */
export const hatOf = (a: AudioData) => (typeof a.hat === "number" ? a.hat : clamp01(a.treble * 1.2));
/** Sustained low end (808 body) — the classic bass value. */
export const subOf = (a: AudioData) => a.bass;
/** Slow loudness envelope 0..1. */
export const energyOf = (a: AudioData) => (typeof a.energy === "number" ? a.energy : a.volume);
/** Rough vocal presence 0..1 (mid band). */
export const vocalOf = (a: AudioData) => a.mid;
/** Seconds since the last kick / snare / hat (Infinity when unknown). */
export const kickAgeOf = (a: AudioData) => (typeof a.kickAge === "number" ? a.kickAge : (a.beat ? 0 : Number.POSITIVE_INFINITY));
export const snareAgeOf = (a: AudioData) => (typeof a.snareAge === "number" ? a.snareAge : Number.POSITIVE_INFINITY);
export const hatAgeOf = (a: AudioData) => (typeof a.hatAge === "number" ? a.hatAge : Number.POSITIVE_INFINITY);

/** 1 at a hit decaying to 0 over `decay` seconds; pure function of an age. */
export const decayFromAge = (age: number, decay = 0.3) =>
  Number.isFinite(age) && age >= 0 ? Math.max(0, 1 - age / Math.max(0.02, decay)) : 0;

/**
 * Read one row of the spectral history (0 = newest, 1 = one hop older …).
 * Returns null when no history is available so presets can fall back.
 */
export function historyRow(a: AudioData, k: number, out?: Float32Array): Float32Array | null {
  const hist = a.history;
  const bands = 64;
  if (!hist || hist.length < bands) return null;
  const rows = hist.length / bands;
  const valid = Math.max(0, Math.min(rows, a.historyRows ?? rows));
  if (valid <= 0) return null;
  const idx = rows - 1 - Math.min(valid - 1, Math.max(0, k | 0));
  const row = out && out.length === bands ? out : new Float32Array(bands);
  const base = idx * bands;
  for (let i = 0; i < bands; i++) row[i] = hist[base + i] / 255;
  return row;
}

// ─── Glow sprites ────────────────────────────────────────────────────────
// A radial-gradient disc rendered ONCE per (colour, size) and stamped with
// drawImage — far cheaper than arc()+fill()+shadowBlur per particle.
const spriteCache = new Map<string, HTMLCanvasElement>();

export function getGlowSprite(color: string, sizePx = 64, core = 0.18): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const size = Math.max(8, Math.min(256, Math.round(sizePx / 8) * 8));
  const key = `${color}|${size}|${core}`;
  let c = spriteCache.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = size; c.height = size;
  const g = c.getContext("2d");
  if (!g) return null;
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(Math.max(0.01, Math.min(0.9, core)), hexA(color, 0.95));
  grad.addColorStop(0.5, hexA(color, 0.35));
  grad.addColorStop(1, hexA(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  spriteCache.set(key, c);
  if (spriteCache.size > 64) {
    const first = spriteCache.keys().next().value;
    if (first) spriteCache.delete(first);
  }
  return c;
}

/** Stamp a glow sprite centred at (x, y) with diameter `d`. */
export function stampGlow(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement | null, x: number, y: number, d: number, alpha = 1) {
  if (!sprite || !(d > 0.5)) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * clamp01(alpha);
  ctx.drawImage(sprite, x - d / 2, y - d / 2, d, d);
  ctx.globalAlpha = prev;
}

/**
 * Log-spaced band levels across the audible range. Every band covers an
 * equal slice of log-Hz so a 12-band EQ always reads sub-bass → bass →
 * low-mid → mid → presence → air, regardless of FFT size or sample rate.
 * `upper` clips the top of the range (1 = 20 kHz, 0.7 ≈ 14 kHz).
 */
export function bandLevels(freq: Uint8Array, count = 12, upper = 0.7, cfg?: VisualizerConfig, audio?: AudioData): number[] {
  const safeCount = Math.max(1, finite(count, 12) | 0);
  const out = new Array<number>(safeCount).fill(0);
  if (!freq.length) return out;
  const sampleRate = audio?.sampleRate && audio.sampleRate > 0 ? audio.sampleRate : 48000;
  const nyquist = sampleRate / 2;
  const clampedUpper = Math.max(0.05, Math.min(1, finite(upper, 0.7)));
  const minHz = AUDIBLE_MIN_HZ;
  const maxHz = Math.min(nyquist, AUDIBLE_MAX_HZ * clampedUpper);
  const logLo = Math.log(minHz);
  const logHi = Math.log(Math.max(minHz * 1.01, maxHz));
  for (let i = 0; i < safeCount; i++) {
    const hzA = Math.exp(logLo + (i / safeCount) * (logHi - logLo));
    const hzB = Math.exp(logLo + ((i + 1) / safeCount) * (logHi - logLo));
    const a = Math.max(0, Math.min(freq.length - 1, Math.floor(hzToBin(hzA, freq.length, sampleRate))));
    const b = Math.max(a + 1, Math.min(freq.length, Math.ceil(hzToBin(hzB, freq.length, sampleRate))));
    let s = 0;
    for (let k = a; k < b; k++) s += safeArrayValue(freq, k);
    // Gentle high-end tilt — highs are perceptually quieter, so boost a touch
    // to keep the equalizer visually balanced.
    const tilt = 1 + (i / safeCount) * 0.6;
    const centerHz = Math.sqrt(hzA * hzB);
    out[i] = Math.max(0, finite(((s / Math.max(1, b - a)) / 255) * tilt * bandMulForHz(centerHz, cfg), 0));
  }
  return out;
}

/**
 * Mirror band index around the middle so bass sits in the centre and
 * treble fans out to both edges (or the reverse with `bassOutside`).
 */
export function mirroredIndex(i: number, count: number, bassOutside = false): number {
  const half = count / 2;
  const idx = i < half ? Math.floor(half - 1 - i) : Math.floor(i - half);
  return bassOutside ? Math.max(0, Math.floor(half) - 1 - idx) : idx;
}

// ─────────────────────────────────────────────────────────────────────────
// Offscreen glow layer
//
// ctx.shadowBlur costs a full CPU blur pass PER stroke/fill. On SwiftShader
// (AWS Lambda has no GPU) a preset drawing 96 glowing bars spends ~96 blur
// passes per frame, which is what pushed heavy presets past the 900 s chunk
// limit. withGlowLayer() draws everything into a pooled offscreen canvas
// with NO shadow, then composites that bitmap onto the main canvas ONCE with
// the shadow enabled: one blur per layer instead of one per stroke. Both the
// preview and Lambda run this same code path, so output stays identical.
// ─────────────────────────────────────────────────────────────────────────
const glowPool: { canvases: HTMLCanvasElement[]; depth: number } = { canvases: [], depth: 0 };

export interface LayerHandle {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Device→user transform that was active when the layer was acquired. */
  matrix: DOMMatrix;
  /** Return the layer to the pool. Contents stay valid until the next acquire at this depth. */
  release: () => void;
}

/**
 * Borrow a cleared, device-sized offscreen canvas whose transform matches
 * `ctx`. Layers nest (each acquire goes one level deeper) and are pooled so
 * per-frame allocation is zero. Returns null without a DOM.
 */
export function acquireLayer(ctx: CanvasRenderingContext2D): LayerHandle | null {
  if (typeof document === "undefined") return null;
  const dw = ctx.canvas ? ctx.canvas.width : 0;
  const dh = ctx.canvas ? ctx.canvas.height : 0;
  if (dw <= 0 || dh <= 0) return null;
  const depth = glowPool.depth;
  let off = glowPool.canvases[depth];
  if (!off) {
    off = document.createElement("canvas");
    glowPool.canvases[depth] = off;
  }
  if (off.width !== dw || off.height !== dh) {
    off.width = dw;
    off.height = dh;
  }
  const octx = off.getContext("2d");
  if (!octx) return null;
  const m = ctx.getTransform();
  glowPool.depth = depth + 1;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, dw, dh);
  octx.setTransform(m);
  octx.globalAlpha = 1;
  octx.globalCompositeOperation = "source-over";
  octx.shadowBlur = 0;
  octx.shadowOffsetX = 0;
  octx.shadowOffsetY = 0;
  octx.filter = "none";
  octx.lineCap = ctx.lineCap;
  octx.lineJoin = ctx.lineJoin;
  octx.lineWidth = ctx.lineWidth;
  let released = false;
  return {
    canvas: off,
    ctx: octx,
    matrix: m,
    release: () => {
      if (released) return;
      released = true;
      glowPool.depth = depth;
    },
  };
}

export interface GlowSpec {
  color: string;
  /** Multiplier on the 20px baseline glow radius (same scale as cfg.glowIntensity). */
  intensity: number;
  /** Override the baseline radius (px at 1080p). Default 20. */
  radius?: number;
  /** Extra alpha for the composited layer (0..1). Default 1. */
  alpha?: number;
  /** Vertical shadow offset in baseline px (drop-shadow look). Default 0. */
  offsetY?: number;
  /** Gaussian blur of the whole layer in baseline px (ctx.filter). Default 0. */
  blur?: number;
  /**
   * Called after the layer has been composited, while its bitmap is still
   * intact — used for reflections, trails and ghost copies. Receives the
   * layer canvas and the device→user matrix it was drawn under.
   */
  onLayer?: (layer: HTMLCanvasElement, matrix: DOMMatrix) => void;
}

export function withGlowLayer(
  ctx: CanvasRenderingContext2D,
  glow: GlowSpec,
  draw: (target: CanvasRenderingContext2D) => void,
): void {
  const blurPx = Math.max(0, finite(glow.radius, 20)) * Math.max(0, finite(glow.intensity, 0));
  const alpha = clamp01(finite(glow.alpha, 1));
  const offsetY = finite(glow.offsetY, 0);
  const filterBlur = Math.max(0, finite(glow.blur, 0));
  const needsLayer = blurPx >= 0.5 || alpha < 0.999 || offsetY !== 0 || filterBlur > 0 || !!glow.onLayer;

  // Nothing to composite → draw straight onto the main canvas (cheapest path).
  if (!needsLayer) {
    draw(ctx);
    return;
  }

  const layer = acquireLayer(ctx);
  if (!layer) {
    // Fallback (no DOM): per-stroke glow, visually equivalent but slower.
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (blurPx >= 0.5) { ctx.shadowColor = glow.color; ctx.shadowBlur = blurPx; ctx.shadowOffsetY = offsetY; }
    try { draw(ctx); } finally { ctx.restore(); }
    return;
  }

  try {
    draw(layer.ctx);
  } finally {
    layer.release();
  }

  const m = layer.matrix;
  // shadowBlur / offsets / filter blur are applied in DEVICE pixels under the
  // identity transform, so scale them by the transform's scale factor to
  // keep proportions identical at any export resolution.
  const scale = Math.hypot(m.a, m.b) || 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  if (blurPx >= 0.5) {
    ctx.shadowColor = glow.color;
    ctx.shadowBlur = blurPx * scale;
    ctx.shadowOffsetY = offsetY * scale;
  } else if (offsetY !== 0) {
    ctx.shadowColor = glow.color;
    ctx.shadowBlur = 0.01;
    ctx.shadowOffsetY = offsetY * scale;
  }
  if (filterBlur > 0) ctx.filter = `blur(${filterBlur * scale}px)`;
  ctx.drawImage(layer.canvas, 0, 0);
  ctx.restore();

  if (glow.onLayer) glow.onLayer(layer.canvas, m);
}

/** Convenience: gradient stroke from p1 → p2 using two colours. */
export function lineGradient(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  c1: string, c2: string,
): CanvasGradient {
  const g = ctx.createLinearGradient(x1, y1, x2, y2);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  return g;
}

/** Rounded-rect path helper that tolerates browsers without ctx.roundRect. */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  if (typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown }).roundRect === "function") {
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Smooth closed/open polyline through points using Catmull-Rom → Bézier. */
export function smoothPath(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], closed = false, tension = 0.5) {
  const n = pts.length;
  if (n < 2) return;
  if (n === 2) { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); return; }
  const get = (i: number) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  ctx.moveTo(pts[0].x, pts[0].y);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const c1x = p1.x + (p2.x - p0.x) * (tension / 3);
    const c1y = p1.y + (p2.y - p0.y) * (tension / 3);
    const c2x = p2.x - (p3.x - p1.x) * (tension / 3);
    const c2y = p2.y - (p3.y - p1.y) * (tension / 3);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
  if (closed) ctx.closePath();
}

/**
 * Beat "kick" envelope: 1 on the beat frame, decaying to 0 over `decay`
 * seconds. Presets that want a punch on the beat but no per-frame state
 * can use audio.onsetAge (seconds since last onset) when present, falling
 * back to the boolean beat flag.
 */
export function beatKick(audio: AudioData, decay = 0.35): number {
  const age = (audio as AudioData & { onsetAge?: number }).onsetAge;
  if (typeof age === "number" && Number.isFinite(age)) {
    return age < 0 ? 0 : Math.max(0, 1 - age / Math.max(0.05, decay));
  }
  return audio.beat ? 1 : 0;
}
