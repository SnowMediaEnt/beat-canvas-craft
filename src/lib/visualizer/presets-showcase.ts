// Preset pack: showcase — logo / cover-art / typography / spectral-history
// presets. See presets-core.ts for the DrawContext/Preset contract and
// draw-utils.ts for the shared helpers every preset must use.
//
// Rules this pack follows (same as every other pack):
//  • Every frame is a pure function of (t, audio, cfg, logo, lyric, title).
//    No Math.random / Date / performance — deterministic hashing only.
//  • Module-level state is limited to pure caches keyed by their inputs
//    (text-fit sizes, colour LUTs, a scratch ImageData that is fully
//    rewritten every frame) so independent Lambda chunks render identically.
//  • All glowing geometry goes through ONE withGlowLayer per preset (two at
//    most). No per-stroke shadowBlur.

import type { AudioData } from "./audioEngine";
import type { VisualizerConfig } from "../project/types";
import type { DrawContext, Preset } from "./presets-core";
import {
  TAU, clamp, clamp01, lerp, smoothstep, easeOutCubic, hexA, mixHex, center,
  bandLevels, freqAtPos, noise2, smoothPath, roundRectPath, withGlowLayer,
  kickOf, energyOf, vocalOf, historyRow, bandMulForHz,
} from "./draw-utils";
import { lyricFontStack } from "./fonts";

// ─── Small local helpers ─────────────────────────────────────────────────

const fin = (v: unknown, fb = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fb);
const reactOf = (cfg: VisualizerConfig) => clamp(fin(cfg.reactivity, 1), 0, 4);
const thicknessOf = (cfg: VisualizerConfig) => clamp(fin(cfg.thickness, 4), 0.5, 60);
const sizeOf = (cfg: VisualizerConfig) => clamp(fin(cfg.size, 1), 0.1, 3);

/** 0..1 playback progress; 0 while the duration is unknown. */
const progressOf = (a: AudioData) => {
  const dur = fin(a.duration, 0);
  return dur > 0 ? clamp01(fin(a.time, 0) / dur) : 0;
};

/** "m:ss" for a second count (negative / NaN → 0:00). */
const fmtTime = (s: number) => {
  const v = Math.max(0, Math.floor(fin(s, 0)));
  const m = Math.floor(v / 60);
  const ss = v % 60;
  return `${m}:${ss < 10 ? "0" : ""}${ss}`;
};

/** Identical below 0.8, then eases toward 1 — no flat-topped plateaus when a band pins. */
const softKnee = (v: number) => {
  if (!(v > 0)) return 0;
  if (v < 0.8) return v;
  return 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2));
};

const imgW = (img: HTMLImageElement) => fin(img.naturalWidth, 0) || fin(img.width, 0);
const imgH = (img: HTMLImageElement) => fin(img.naturalHeight, 0) || fin(img.height, 0);
/** True when the logo has decoded far enough to have real dimensions. */
const logoReady = (img?: HTMLImageElement | null): img is HTMLImageElement =>
  !!img && imgW(img) > 0 && imgH(img) > 0;

/** Cover-fit drawImage into a box. Returns false if the image cannot be drawn yet. */
function drawCover(g: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, bw: number, bh: number): boolean {
  const iw = imgW(img), ih = imgH(img);
  if (!(iw > 0 && ih > 0 && bw > 0 && bh > 0)) return false;
  const s = Math.max(bw / iw, bh / ih);
  const sw = bw / s, sh = bh / s;
  try {
    g.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, bw, bh);
    return true;
  } catch {
    return false;
  }
}

const safeFillText = (g: CanvasRenderingContext2D, text: string, x: number, y: number) => {
  if (Number.isFinite(x) && Number.isFinite(y) && text) g.fillText(text, x, y);
};
const safeStrokeText = (g: CanvasRenderingContext2D, text: string, x: number, y: number) => {
  if (Number.isFinite(x) && Number.isFinite(y) && text) g.strokeText(text, x, y);
};

/**
 * Detects whether a web font is really active on this canvas by comparing
 * the width of a probe string with and without the family in the stack.
 * (document.fonts.check() returns true when the family is simply not
 * registered, so it cannot tell "loaded" from "never requested".)
 */
function fontActive(ctx: CanvasRenderingContext2D, family: string, fallbackStack: string): boolean {
  const prev = ctx.font;
  try {
    const quoted = /\s/.test(family) ? `"${family}"` : family;
    ctx.font = `400 40px ${quoted}, ${fallbackStack}`;
    const a = ctx.measureText("MIDNIGHT drive 0123").width;
    ctx.font = `400 40px ${fallbackStack}`;
    const b = ctx.measureText("MIDNIGHT drive 0123").width;
    return Math.abs(a - b) > 0.5;
  } catch {
    return false;
  } finally {
    ctx.font = prev;
  }
}

// Text-fit cache: (text, font template, width, cap) → font size in px.
const fitCache = new Map<string, number>();
function fitPx(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontFor: (px: number) => string,
  maxW: number,
  maxPx: number,
  minPx: number,
  keyExtra = "",
): number {
  const key = `${text}|${fontFor(10)}|${Math.round(maxW)}|${maxPx}|${keyExtra}`;
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  const prev = ctx.font;
  let px = maxPx;
  for (let i = 0; i < 12 && px > minPx; i++) {
    ctx.font = fontFor(px);
    const wdt = ctx.measureText(text).width;
    if (wdt <= maxW) break;
    px = Math.max(minPx, Math.floor(px * Math.min(0.94, maxW / Math.max(1, wdt))));
  }
  ctx.font = prev;
  if (fitCache.size > 512) fitCache.clear();
  fitCache.set(key, px);
  return px;
}

/** Outlined label: dark stroke behind a light fill so it reads on any background. */
function drawLabel(g: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign, fill: string, strokeW = 4) {
  g.textAlign = align;
  g.lineJoin = "round";
  g.lineWidth = strokeW;
  g.strokeStyle = "rgba(0,0,0,0.65)";
  safeStrokeText(g, text, x, y);
  g.fillStyle = fill;
  safeFillText(g, text, x, y);
}

// Per-band sensitivity multipliers for the 64 log-spaced history bands
// (30 Hz–16 kHz), so the bass/mid/treble sliders shape history presets the
// same way bandLevels() shapes live ones. Includes the same gentle high tilt.
const HIST_LO = Math.log(30), HIST_HI = Math.log(16000);
const histMultCache = new Map<string, Float32Array>();
function histMults(cfg: VisualizerConfig): Float32Array {
  const key = `${cfg.sensitivity}|${cfg.bassSensitivity}|${cfg.midSensitivity}|${cfg.trebleSensitivity}`;
  let m = histMultCache.get(key);
  if (m) return m;
  m = new Float32Array(64);
  for (let b = 0; b < 64; b++) {
    const hz = Math.exp(HIST_LO + ((b + 0.5) / 64) * (HIST_HI - HIST_LO));
    m[b] = bandMulForHz(hz, cfg) * (1 + 0.5 * (b / 64));
  }
  if (histMultCache.size > 16) histMultCache.clear();
  histMultCache.set(key, m);
  return m;
}

// ═════════════════════════════════════════════════════════════════════════
// 1. Cover Stage — cover art on a floating card with floor glow, reflection
//    and a progress ring of spectrum ticks.
// ═════════════════════════════════════════════════════════════════════════

/** Paints the card's face (logo cover-fit, or a primary→accent disc). */
function drawCardArt(g: CanvasRenderingContext2D, logo: HTMLImageElement | undefined, x: number, y: number, side: number, cfg: VisualizerConfig) {
  g.fillStyle = "#101016";
  g.fillRect(x, y, side, side);
  if (logoReady(logo) && drawCover(g, logo, x, y, side, side)) return;
  const cx = x + side / 2, cy = y + side / 2;
  const r = Math.max(1, side * 0.36);
  const rg = g.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.05, cx, cy, r);
  rg.addColorStop(0, cfg.primary);
  rg.addColorStop(1, cfg.accent);
  g.fillStyle = rg;
  g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
  g.strokeStyle = "rgba(255,255,255,0.18)";
  g.lineWidth = Math.max(1, side * 0.006);
  g.beginPath(); g.arc(cx, cy, r * 0.62, 0, TAU); g.stroke();
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.beginPath(); g.arc(cx, cy, r * 0.1, 0, TAU); g.fill();
}

const coverStage: Preset = {
  id: "cover-stage", name: "Cover Stage", category: "Logo", consumesLogo: true,
  description: "Your cover art on a floating card with a bass-lit floor, a soft reflection and a progress ring of spectrum ticks.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, logo } = d;
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const thick = thicknessOf(cfg);
    const fxScale = clamp(fin(d.logoFx?.scale, 1), 0.5, 2);
    const hop = clamp(fin(d.logoFx?.hop, 0), -h, h);
    const kick = kickOf(audio);
    const bass = clamp01(audio.bass);

    const side = Math.max(24, Math.min(w, h) * clamp(fin(cfg.logoSize, 0.35), 0.05, 1.5) * 1.15) * fxScale;
    const cx = w / 2 + clamp(fin(cfg.logoPosition?.x, 0), -1, 1) * w / 2;
    const cy = h / 2 + clamp(fin(cfg.logoPosition?.y, 0), -1, 1) * h / 2 + hop;
    const x0 = cx - side / 2, y0 = cy - side / 2;
    const radius = side * 0.07;
    const ringR = side * 0.5 * 1.42 + 14 * size; // clears the card's corners

    // Floor glow pooling under the card, breathing with bass.
    const floorY = y0 + side + side * 0.05;
    const glowA = clamp01((0.26 + bass * 0.5 * react) * (0.45 + clamp(fin(cfg.glowIntensity, 0.8), 0, 3) * 0.55));
    ctx.save();
    ctx.translate(cx, floorY);
    ctx.scale(1, 0.32);
    const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, side * 1.05));
    fg.addColorStop(0, hexA(cfg.glow, glowA));
    fg.addColorStop(0.45, hexA(cfg.accent, glowA * 0.5));
    fg.addColorStop(1, hexA(cfg.primary, 0));
    ctx.fillStyle = fg;
    ctx.fillRect(-side * 1.1, -side * 1.1, side * 2.2, side * 2.2);
    ctx.restore();

    // Reflection: the card art flipped, drawn in clipped strips whose alpha
    // fades downward (no offscreen surface needed).
    const gap = side * 0.035;
    const reflTop = y0 + side + gap;
    const reflH = side * 0.55;
    const strips = 12;
    ctx.save();
    ctx.beginPath(); roundRectPath(ctx, x0, reflTop, side, reflH, radius); ctx.clip();
    for (let i = 0; i < strips; i++) {
      const sy0 = reflTop + (i / strips) * reflH;
      const sy1 = reflTop + ((i + 1) / strips) * reflH;
      const fade = 1 - (i + 0.5) / strips;
      ctx.save();
      ctx.beginPath(); ctx.rect(x0 - 1, sy0, side + 2, sy1 - sy0 + 0.6); ctx.clip();
      ctx.globalAlpha = 0.34 * fade * fade;
      ctx.translate(0, 2 * (y0 + side) + gap);
      ctx.scale(1, -1);
      drawCardArt(ctx, logo, x0, y0, side, cfg);
      ctx.restore();
    }
    ctx.restore();

    // Card body with ONE soft drop shadow (dark glow layer with offset).
    withGlowLayer(ctx, { color: "rgba(0,0,0,0.8)", intensity: 1.8, offsetY: 14 }, (g) => {
      g.fillStyle = "#0c0c12";
      g.beginPath(); roundRectPath(g, x0, y0, side, side, radius); g.fill();
    });

    // Card face (clipped), gloss and hairline edge.
    ctx.save();
    ctx.beginPath(); roundRectPath(ctx, x0, y0, side, side, radius); ctx.clip();
    drawCardArt(ctx, logo, x0, y0, side, cfg);
    const gloss = ctx.createLinearGradient(0, y0, 0, y0 + side * 0.5);
    gloss.addColorStop(0, "rgba(255,255,255,0.10)");
    gloss.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gloss;
    ctx.fillRect(x0, y0, side, side * 0.5);
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); roundRectPath(ctx, x0, y0, side, side, radius); ctx.stroke();

    // Progress ring + 64 spectrum ticks (one glow layer).
    const progress = progressOf(audio);
    const levels = bandLevels(audio.freq, 64, 0.8, cfg, audio);
    const start = -Math.PI / 2;
    withGlowLayer(ctx, { color: cfg.glow, intensity: clamp(fin(cfg.glowIntensity, 0.8), 0, 3) * 0.8 }, (g) => {
      g.save();
      g.lineCap = "round";
      g.strokeStyle = "rgba(255,255,255,0.12)";
      g.lineWidth = Math.max(1, thick * 0.45);
      g.beginPath(); g.arc(cx, cy, ringR, 0, TAU); g.stroke();
      if (progress > 0.0005) {
        g.strokeStyle = cfg.primary;
        g.lineWidth = Math.max(1.5, thick * 0.6);
        g.beginPath(); g.arc(cx, cy, ringR, start, start + TAU * progress); g.stroke();
      }
      g.lineWidth = Math.max(1.5, thick * 0.55);
      const inner = ringR + 6 + thick * 0.6;
      for (let i = 0; i < 64; i++) {
        const p = i / 64;
        const a = start + p * TAU;
        const v = clamp01(fin(levels[i], 0) * react);
        const len = (5 + v * 64) * size;
        const played = p <= progress;
        g.strokeStyle = mixHex(cfg.primary, cfg.accent, p, played ? 0.95 : 0.3 + v * 0.3);
        const ca = Math.cos(a), sa = Math.sin(a);
        g.beginPath();
        g.moveTo(cx + ca * inner, cy + sa * inner);
        g.lineTo(cx + ca * (inner + len), cy + sa * (inner + len));
        g.stroke();
      }
      // Playhead dot.
      const pa = start + TAU * progress;
      g.fillStyle = "#ffffff";
      g.beginPath(); g.arc(cx + Math.cos(pa) * ringR, cy + Math.sin(pa) * ringR, Math.max(2, 4 + thick * 0.4 + kick * 3 * react), 0, TAU); g.fill();
      g.restore();
    });
  },
};

// ═════════════════════════════════════════════════════════════════════════
// 2. Vinyl Spin — a 33⅓ rpm record with the logo as its centre label.
// ═════════════════════════════════════════════════════════════════════════

const vinylSpin: Preset = {
  id: "vinyl-spin", name: "Vinyl Spin", category: "Logo", consumesLogo: true,
  description: "A spinning record with your logo as the centre label — the rim shoots spectrum spokes on every hit.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t, logo } = d;
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const thick = thicknessOf(cfg);
    const { cx, cy: cy0 } = center(d);
    const cy = cy0 + clamp(fin(d.logoFx?.hop, 0), -h, h);
    const labelPulse = clamp(fin(d.logoFx?.scale, 1), 0.5, 2);
    const kick = kickOf(audio);
    const treble = clamp01(audio.treble);
    const R = Math.max(8, Math.min(w, h) * 0.28 * size) * (1 + 0.05 * kick * react);
    const angle = t * 3.49 + fin(cfg.rotation, 0);

    // Halo of spectrum spokes shooting from the rim (behind the disc).
    const N = clamp((cfg.bandCount | 0) || 48, 8, 128);
    const levels = bandLevels(audio.freq, N, 0.8, cfg, audio);
    const maxLen = R * 0.6;
    withGlowLayer(ctx, { color: cfg.glow, intensity: clamp(fin(cfg.glowIntensity, 0.8), 0, 3) * (0.8 + kick * 0.4) }, (g) => {
      g.save();
      const grad = g.createRadialGradient(cx, cy, R * 0.98, cx, cy, R + maxLen);
      grad.addColorStop(0, hexA(cfg.primary, 0.95));
      grad.addColorStop(1, hexA(cfg.accent, 0.55));
      g.strokeStyle = grad;
      g.lineWidth = Math.max(1.5, thick * 0.7);
      g.lineCap = "round";
      g.globalAlpha = clamp01(0.65 + 0.3 * kick);
      const a0 = -Math.PI / 2 + fin(cfg.rotation, 0);
      for (let i = 0; i < N; i++) {
        const a = a0 + (i / N) * TAU;
        const v = clamp01(fin(levels[i], 0) * react);
        const len = 3 + v * maxLen;
        const ca = Math.cos(a), sa = Math.sin(a);
        g.beginPath();
        g.moveTo(cx + ca * (R - 1), cy + sa * (R - 1));
        g.lineTo(cx + ca * (R + len), cy + sa * (R + len));
        g.stroke();
      }
      g.restore();
    });

    // The record.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    const dg = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    dg.addColorStop(0, "#0a0a0a");
    dg.addColorStop(0.45, "#161616");
    dg.addColorStop(0.9, "#2a2a2a");
    dg.addColorStop(1, "#444444");
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const r = R * (0.4 + (i / 13) * 0.55);
      ctx.strokeStyle = `rgba(255,255,255,${i % 2 ? 0.12 : 0.06})`;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
    }
    ctx.restore();

    // Two opposing light sheens, counter-rotating slowly.
    const half = 0.42;
    const peak = 0.10 * (0.7 + treble);
    for (let s = 0; s < 2; s++) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-t * 0.15 + 0.7 + Math.PI * s);
      const sg = ctx.createLinearGradient(0, -R * Math.sin(half), 0, R * Math.sin(half));
      sg.addColorStop(0, "rgba(255,255,255,0.03)");
      sg.addColorStop(0.5, `rgba(255,255,255,${clamp01(peak)})`);
      sg.addColorStop(1, "rgba(255,255,255,0.03)");
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R * 0.995, -half, half); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // Centre label (logo, cover-fit, rotating with the disc).
    const labelR = Math.max(4, R * 0.36 * labelPulse);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.beginPath(); ctx.arc(0, 0, labelR, 0, TAU); ctx.clip();
    if (!(logoReady(logo) && drawCover(ctx, logo, -labelR, -labelR, labelR * 2, labelR * 2))) {
      const lg = ctx.createRadialGradient(-labelR * 0.3, -labelR * 0.3, labelR * 0.05, 0, 0, labelR);
      lg.addColorStop(0, cfg.primary);
      lg.addColorStop(1, cfg.accent);
      ctx.fillStyle = lg;
      ctx.fillRect(-labelR, -labelR, labelR * 2, labelR * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = Math.max(1, labelR * 0.03);
      ctx.beginPath(); ctx.arc(0, 0, labelR * 0.8, 0, TAU); ctx.stroke();
      ctx.strokeStyle = hexA(cfg.secondary, 0.7);
      ctx.beginPath(); ctx.arc(0, 0, labelR * 0.58, 0.3, 2.4); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, labelR * 0.58, Math.PI + 0.3, Math.PI + 2.4); ctx.stroke();
    }
    ctx.restore();

    // Label rim, spindle hole and record rim highlight.
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, labelR, 0, TAU); ctx.stroke();
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.5, R * 0.028), 0, TAU); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.5, R * 0.028), 0, TAU); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, R - 1), 0, TAU); ctx.stroke();
  },
};

// ═════════════════════════════════════════════════════════════════════════
// 3. Now Playing — a streaming-app player strip along the bottom.
// ═════════════════════════════════════════════════════════════════════════

const MONO_FONT = "500 22px ui-monospace, Menlo, Consolas, monospace";

const nowPlaying: Preset = {
  id: "now-playing", name: "Now Playing", category: "Typography",
  description: "A clean player strip — title, progress bar and timecodes — with a row of spectrum pills pulsing above it.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const bass = clamp01(audio.bass);
    const kick = kickOf(audio);
    const baseY = h - 110 + clamp(fin(cfg.position?.y, 0), -1, 1) * h * 0.3;
    const x0 = w * 0.06;
    const trackW = w * 0.88;
    const progress = progressOf(audio);
    const N = clamp((cfg.bandCount | 0) || 32, 16, 64);
    const levels = bandLevels(audio.freq, N, 0.8, cfg, audio);

    const pillBottom = baseY - 34;
    const pillMax = Math.max(20, h * 0.2 * size);
    const pillTop = pillBottom - pillMax;

    // Soft dark backing so the UI reads on any background.
    const bgTop = pillTop - 160;
    const bg = ctx.createLinearGradient(0, bgTop, 0, h);
    bg.addColorStop(0, "rgba(0,0,0,0)");
    bg.addColorStop(1, "rgba(0,0,0,0.6)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, bgTop, w, Math.max(0, h - bgTop));

    // Spectrum pills (single path, one glow layer).
    const slot = trackW / N;
    const pw = Math.max(3, slot * 0.5);
    withGlowLayer(ctx, { color: cfg.glow, intensity: clamp(fin(cfg.glowIntensity, 0.8), 0, 3) * 0.6 }, (g) => {
      const grad = g.createLinearGradient(0, pillBottom, 0, pillTop);
      grad.addColorStop(0, cfg.primary);
      grad.addColorStop(1, cfg.accent);
      g.fillStyle = grad;
      g.beginPath();
      for (let i = 0; i < N; i++) {
        const v = clamp01(fin(levels[i], 0) * react);
        const ph = Math.max(pw, v * pillMax);
        const x = x0 + i * slot + (slot - pw) / 2;
        roundRectPath(g, x, pillBottom - ph, pw, ph, pw / 2);
      }
      g.fill();
    });

    // Track + progress + knob.
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.beginPath(); roundRectPath(ctx, x0, baseY - 2, trackW, 4, 2); ctx.fill();
    const filled = trackW * progress;
    if (filled > 1) {
      const pg = ctx.createLinearGradient(x0, 0, x0 + trackW, 0);
      pg.addColorStop(0, cfg.primary);
      pg.addColorStop(1, cfg.accent);
      ctx.fillStyle = pg;
      ctx.beginPath(); roundRectPath(ctx, x0, baseY - 2, filled, 4, 2); ctx.fill();
    }
    const knobR = 7 + bass * 9 * react + kick * 2 * react;
    ctx.fillStyle = hexA(cfg.accent, 0.35);
    ctx.beginPath(); ctx.arc(x0 + filled, baseY, Math.max(1, knobR + 5), 0, TAU); ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(x0 + filled, baseY, Math.max(1, knobR), 0, TAU); ctx.fill();

    // Timecodes.
    ctx.save();
    ctx.font = MONO_FONT;
    ctx.textBaseline = "alphabetic";
    const tcY = baseY + 38;
    drawLabel(ctx, fmtTime(audio.time), x0, tcY, "left", "rgba(255,255,255,0.85)");
    const dur = fin(audio.duration, 0);
    drawLabel(ctx, dur > 0 ? fmtTime(dur) : "-:--", x0 + trackW, tcY, "right", "rgba(255,255,255,0.85)");

    // Title (+ optional lyric line) above the pills.
    const title = (d.title || "").trim() || "YOUR TITLE";
    const titleFont = (px: number) => `700 ${px}px ${lyricFontStack("Space Grotesk")}`;
    const lyricText = (d.lyric?.text || "").trim();
    const lyricFont = (px: number) => `400 ${px}px ${lyricFontStack("Inter")}`;
    const fontKey = `${fontActive(ctx, "Space Grotesk", "Arial, sans-serif") ? 1 : 0}${fontActive(ctx, "Inter", "Arial, sans-serif") ? 1 : 0}`;
    const lyricY = pillTop - 20;
    const titleY = lyricText ? lyricY - 46 : lyricY;
    const tpx = fitPx(ctx, title, titleFont, trackW, 40, 16, fontKey);
    ctx.font = titleFont(tpx);
    drawLabel(ctx, title, x0, titleY, "left", "#ffffff", 5);
    // "Now playing" eyebrow with a beat dot.
    ctx.font = `600 14px ${lyricFontStack("Inter")}`;
    ctx.fillStyle = hexA(cfg.accent, 0.6 + kick * 0.4);
    ctx.beginPath(); ctx.arc(x0 + 6, titleY - tpx - 4, 4 + kick * 2, 0, TAU); ctx.fill();
    drawLabel(ctx, "NOW PLAYING", x0 + 18, titleY - tpx + 1, "left", "rgba(255,255,255,0.55)", 3);
    if (lyricText) {
      const lpx = fitPx(ctx, lyricText, lyricFont, trackW, 28, 14, fontKey);
      ctx.font = lyricFont(lpx);
      const fadeIn = clamp01(fin(d.lyric?.age, 1) / 0.25);
      drawLabel(ctx, lyricText, x0, lyricY, "left", `rgba(255,255,255,${0.82 * fadeIn})`, 4);
    }
    ctx.restore();
  },
};

// ═════════════════════════════════════════════════════════════════════════
// 4. Kinetic Type — one huge line of text that fills the frame.
// ═════════════════════════════════════════════════════════════════════════

interface KineticLayout { px: number; lines: string[] }
const kineticCache = new Map<string, KineticLayout>();

/** Largest font size whose greedy word-wrap fits ≤ 3 lines inside maxW × maxH. */
function layoutKinetic(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxH: number, font: (px: number) => string, keyExtra: string): KineticLayout {
  const key = `${text}|${Math.round(maxW)}|${Math.round(maxH)}|${font(10)}|${keyExtra}`;
  const hit = kineticCache.get(key);
  if (hit) return hit;
  const words = text.split(/\s+/).filter(Boolean);
  const prev = ctx.font;
  const lineH = 0.95;
  const tryWrap = (px: number): string[] | null => {
    ctx.font = font(px);
    const lines: string[] = [];
    let cur = "";
    for (const wd of words) {
      const test = cur ? `${cur} ${wd}` : wd;
      if (ctx.measureText(test).width <= maxW) { cur = test; continue; }
      if (!cur) return null; // single word wider than the box
      lines.push(cur);
      cur = wd;
      if (ctx.measureText(wd).width > maxW) return null;
      if (lines.length >= 3) return null;
    }
    if (cur) lines.push(cur);
    if (lines.length > 3 || lines.length * px * lineH > maxH) return null;
    return lines;
  };
  let lo = 12, hi = Math.max(24, maxH);
  let best: KineticLayout | null = null;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const lines = tryWrap(mid);
    if (lines) { best = { px: Math.floor(mid), lines }; lo = mid; } else hi = mid;
  }
  if (!best) best = { px: 12, lines: [text] };
  ctx.font = prev;
  if (kineticCache.size > 256) kineticCache.clear();
  kineticCache.set(key, best);
  return best;
}

const glyphWidthCache = new Map<string, number>();
function glyphWidth(ctx: CanvasRenderingContext2D, font: string, ch: string): number {
  const key = `${font}|${ch}`;
  const hit = glyphWidthCache.get(key);
  if (hit !== undefined) return hit;
  const wdt = ctx.measureText(ch).width;
  if (glyphWidthCache.size > 4096) glyphWidthCache.clear();
  glyphWidthCache.set(key, wdt);
  return wdt;
}

const kineticType: Preset = {
  id: "kinetic-type", name: "Kinetic Type", category: "Typography",
  description: "Huge condensed lyrics (or your title) that slam on kicks, split colours on bass and stretch their tracking with treble.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const lyricText = (d.lyric?.text || "").trim();
    const text = (lyricText || (d.title || "").trim() || "YOUR TITLE").toUpperCase();
    const stack = lyricFontStack("Anton");
    // Anton ships only weight 400; if it isn't active, ask the fallback sans for a bold face.
    const anton = fontActive(ctx, "Anton", "Arial, sans-serif");
    const fontFor = (px: number) => `${anton ? 400 : 700} ${px}px ${stack}`;
    const layout = layoutKinetic(ctx, text, w * 0.78 * size, h * 0.8 * size, fontFor, anton ? "a" : "f");
    const px = Math.max(8, layout.px);
    const font = fontFor(px);
    const kick = kickOf(audio);
    const bass = clamp01(audio.bass);
    const mid = clamp01(audio.mid);
    const treble = clamp01(audio.treble);

    let scale = 1 + 0.12 * kick * react;
    const age = d.lyric ? fin(d.lyric.age, 1) : 1;
    if (age < 0.22) {
      scale *= age < 0.15 ? lerp(0.85, 1.04, easeOutCubic(age / 0.15)) : lerp(1.04, 1, clamp01((age - 0.15) / 0.07));
    }
    const skew = Math.sin(t * 2) * mid * 0.08;
    const tracking0 = treble * px * 0.08 * react;
    const dx = bass * 18 * react;
    const { cx, cy } = center(d);
    const lineH = px * 0.95;
    const n = layout.lines.length;
    const totalH = n * lineH;
    const maxLine = w * 0.88;

    withGlowLayer(ctx, { color: cfg.glow, intensity: clamp(fin(cfg.glowIntensity, 0.8), 0, 3) * 0.9 }, (g) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(fin(cfg.rotation, 0));
      g.scale(scale, scale);
      g.transform(1, 0, skew, 1, 0, 0);
      g.font = font;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.lineJoin = "round";
      const grad = g.createLinearGradient(0, -totalH / 2, 0, totalH / 2);
      grad.addColorStop(0, cfg.primary);
      grad.addColorStop(1, cfg.accent);
      const lw = Math.max(1, px * 0.025);
      const echoes = dx > 0.8;
      for (let li = 0; li < n; li++) {
        const chars = Array.from(layout.lines[li]);
        const widths = chars.map((ch) => glyphWidth(g, font, ch));
        let sumW = 0;
        for (const wd of widths) sumW += wd;
        let tracking = tracking0;
        if (chars.length > 1 && sumW + tracking * (chars.length - 1) > maxLine) {
          tracking = Math.max(0, (maxLine - sumW) / (chars.length - 1));
        }
        const lineW = sumW + tracking * (chars.length - 1);
        const y = -totalH / 2 + lineH * (li + 0.5);
        let x = -lineW / 2;
        for (let ci = 0; ci < chars.length; ci++) {
          const ch = chars[ci];
          if (ch !== " ") {
            if (echoes) {
              g.lineWidth = lw;
              g.strokeStyle = hexA(cfg.accent, 0.85);
              safeStrokeText(g, ch, x - dx, y);
              g.strokeStyle = hexA(cfg.secondary, 0.85);
              safeStrokeText(g, ch, x + dx, y);
            }
            g.fillStyle = grad;
            safeFillText(g, ch, x, y);
          }
          x += widths[ci] + tracking;
        }
      }
      g.restore();
    });
  },
};

// ═════════════════════════════════════════════════════════════════════════
// 5. Spectrum Terrain — Joy-Division ridges of the spectral history in
//    perspective (hidden-line occlusion).
// ═════════════════════════════════════════════════════════════════════════

const TERRAIN_ROWS = 36;
const terrainScratch = new Float32Array(64); // reused historyRow() output buffer

const spectrumTerrain: Preset = {
  id: "spectrum-terrain", name: "Spectrum Terrain", category: "3D",
  description: "A mountain range of the last few seconds of your track, rolling away toward a hazy horizon.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const thick = thicknessOf(cfg);
    const rows = TERRAIN_ROWS;
    const cols = clamp((cfg.bandCount | 0) || 64, 32, 96);
    const kick = kickOf(audio);
    const mid = clamp01(audio.mid);
    const cx = w / 2 + clamp(fin(cfg.position?.x, 0), -1, 1) * w / 2;
    const horizonY = h * 0.4 + clamp(fin(cfg.position?.y, 0), -1, 1) * h * 0.3;
    const baseY = h * 0.93;

    // Horizon haze tinted by the mids.
    const hazeTop = horizonY - h * 0.16;
    const haze = ctx.createLinearGradient(0, hazeTop, 0, horizonY + h * 0.12);
    haze.addColorStop(0, mixHex(cfg.primary, cfg.accent, mid, 0));
    haze.addColorStop(0.55, mixHex(cfg.primary, cfg.accent, mid, 0.2 + 0.3 * mid));
    haze.addColorStop(1, mixHex(cfg.primary, cfg.accent, mid, 0));
    ctx.fillStyle = haze;
    ctx.fillRect(0, hazeTop, w, h * 0.28);

    // Heights: row k ← history 2k hops old (40 ms per row), resampled to `cols`.
    const mults = histMults(cfg);
    const cur = bandLevels(audio.freq, cols, 0.8, cfg, audio);
    const vals = new Float32Array(rows * cols);
    for (let k = 0; k < rows; k++) {
      const row = historyRow(audio, k * 2, terrainScratch);
      const base = k * cols;
      if (row) {
        for (let j = 0; j < cols; j++) {
          const pos = (j / (cols - 1)) * 63;
          const i0 = Math.floor(pos);
          const i1 = Math.min(63, i0 + 1);
          const f = pos - i0;
          const v = lerp(row[i0] * mults[i0], row[i1] * mults[i1], f);
          vals[base + j] = softKnee(fin(v, 0) * react);
        }
      } else {
        for (let j = 0; j < cols; j++) {
          const v = fin(cur[j], 0) * (0.4 + 0.6 * noise2(j * 0.15, t * 2 - k * 0.25));
          vals[base + j] = softKnee(v * react);
        }
      }
    }

    const geom = (k: number) => {
      const dd = k / rows;
      const persp = 1 / (1 + 2.2 * dd);
      const rowY = horizonY + (baseY - horizonY) * persp;
      const rowW = w * (0.35 + 0.65 * persp);
      const punch = 1 + 0.15 * kick * react * Math.max(0, 1 - k / 3);
      const hs = h * 0.35 * size * persp * punch;
      return { persp, rowY, rowW, hs };
    };
    const pts: { x: number; y: number }[] = new Array(cols);
    for (let j = 0; j < cols; j++) pts[j] = { x: 0, y: 0 };
    const trace = (g: CanvasRenderingContext2D, k: number, closed: boolean) => {
      const { rowY, rowW, hs } = geom(k);
      const xL = cx - rowW / 2;
      const base = k * cols;
      for (let j = 0; j < cols; j++) {
        pts[j].x = xL + (j / (cols - 1)) * rowW;
        pts[j].y = rowY - vals[base + j] * hs;
      }
      g.beginPath();
      smoothPath(g, pts, false, 0.5);
      if (closed) {
        // Only cover down to where the next nearer ridge's own polygon takes
        // over (its baseline) — thin bands instead of full-height fills.
        const floor = k === 0 ? h + 20 : geom(k - 1).rowY + 2;
        g.lineTo(xL + rowW, floor);
        g.lineTo(xL, floor);
        g.closePath();
      }
    };
    const fillCol = hexA(cfg.overlay || "#000000", 0.92);
    const strokeRow = (g: CanvasRenderingContext2D, k: number) => {
      const { persp, rowW } = geom(k);
      const sg = g.createLinearGradient(cx - rowW / 2, 0, cx + rowW / 2, 0);
      const a = 0.25 + 0.75 * persp;
      sg.addColorStop(0, hexA(cfg.accent, a));
      sg.addColorStop(0.5, hexA(cfg.primary, a));
      sg.addColorStop(1, hexA(cfg.accent, a));
      g.strokeStyle = sg;
      g.lineWidth = Math.max(0.6, thick * (0.3 + 0.7 * persp));
      trace(g, k, false);
      g.stroke();
    };

    const glowInt = clamp(fin(cfg.glowIntensity, 0.8), 0, 3) * 0.7;
    const glowOn = glowInt * 20 >= 0.5 && typeof document !== "undefined";
    ctx.save();
    ctx.lineJoin = "round";
    if (!glowOn) {
      // Crisp path: fill (occlude) then stroke, far → near.
      for (let k = rows - 1; k >= 0; k--) {
        ctx.fillStyle = fillCol;
        trace(ctx, k, true);
        ctx.fill();
        strokeRow(ctx, k);
      }
    } else {
      // Dark fills on the main canvas (hide the background behind the range) …
      ctx.fillStyle = fillCol;
      for (let k = rows - 1; k >= 0; k--) { trace(ctx, k, true); ctx.fill(); }
      // … and the glowing ridge lines in ONE layer, where each nearer ridge
      // erases the strokes behind it (destination-out) before it is stroked.
      withGlowLayer(ctx, { color: cfg.glow, intensity: glowInt }, (g) => {
        g.save();
        g.lineJoin = "round";
        for (let k = rows - 1; k >= 0; k--) {
          g.globalCompositeOperation = "destination-out";
          g.fillStyle = "#000";
          trace(g, k, true);
          g.fill();
          g.globalCompositeOperation = "source-over";
          strokeRow(g, k);
        }
        g.restore();
      });
    }
    ctx.restore();
  },
};

// ═════════════════════════════════════════════════════════════════════════
// 6. Spectral Waterfall — a flowing heat-map of the last ~2.5 s.
// ═════════════════════════════════════════════════════════════════════════

const WF_W = 128, WF_H = 64;
interface WfSurface { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData }
let wfSurfaceCache: WfSurface | null = null; // scratch: fully rewritten every frame
const wfRef = new Float32Array(WF_H);         // scratch: per-band reference level
function wfSurface(): WfSurface | null {
  if (wfSurfaceCache) return wfSurfaceCache;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = WF_W;
  canvas.height = WF_H;
  const g = canvas.getContext("2d");
  if (!g) return null;
  wfSurfaceCache = { canvas, ctx: g, img: g.createImageData(WF_W, WF_H) };
  return wfSurfaceCache;
}

const wfLutCache = new Map<string, Uint8ClampedArray>();
/** 256-entry RGB LUT: black → tint → primary → accent → secondary → white (gamma 0.85). */
function wfLut(tint: string, primary: string, accent: string, secondary: string): Uint8ClampedArray {
  const key = `${tint}|${primary}|${accent}|${secondary}`;
  const hit = wfLutCache.get(key);
  if (hit) return hit;
  const stops: [number, string][] = [
    [0, "#000000"], [0.22, tint || "#000000"], [0.5, primary], [0.74, accent], [0.9, secondary], [1, "#ffffff"],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let s = 0;
    while (s < stops.length - 2 && v > stops[s + 1][0]) s++;
    const [p0, c0] = stops[s];
    const [p1, c1] = stops[s + 1];
    const f = clamp01((v - p0) / Math.max(1e-6, p1 - p0));
    const rgba = mixHex(c0, c1, f); // "rgba(r,g,b,1)"
    const m = /rgba\((\d+),(\d+),(\d+)/.exec(rgba);
    lut[i * 3] = m ? +m[1] : 255;
    lut[i * 3 + 1] = m ? +m[2] : 255;
    lut[i * 3 + 2] = m ? +m[3] : 255;
  }
  if (wfLutCache.size > 12) wfLutCache.clear();
  wfLutCache.set(key, lut);
  return lut;
}

const spectralWaterfall: Preset = {
  id: "spectral-waterfall", name: "Spectral Waterfall", category: "Organic",
  description: "A soft aurora heat-map of the last few seconds — lows at the bottom, the newest sound at the bright leading edge.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const kick = kickOf(audio);
    const bass = clamp01(audio.bass);
    const surf = wfSurface();
    const cur = bandLevels(audio.freq, WF_H, 0.8, cfg, audio);
    const { cx, cy } = center(d);
    const vertical = fin(cfg.rotation, 0) < 0;
    const stretch = 1 + 0.08 * bass * react;
    const dw = vertical ? h : w;
    const dh = (vertical ? w : h) * size * stretch;

    if (surf) {
      const lut = wfLut(cfg.backgroundTint, cfg.primary, cfg.accent, cfg.secondary);
      const mults = histMults(cfg);
      const hist = audio.history;
      const rowsTotal = hist ? Math.floor(hist.length / WF_H) : 0;
      const valid = hist ? clamp(fin(audio.historyRows, rowsTotal), 0, rowsTotal) : 0;
      const boost = (1 + 0.35 * kick * react) * (0.6 + 0.4 * react);
      const data = surf.img.data;
      // Per-band reference level over the visible history, used only to let
      // transients bloom above a band's sustained level.
      const ref = wfRef;
      ref.fill(0.3);
      if (hist && valid > 0) {
        for (let b = 0; b < WF_H; b++) {
          let sum = 0;
          for (let k = 0; k < valid; k++) sum += hist[(rowsTotal - 1 - k) * WF_H + b];
          ref[b] = 0.22 + (sum / valid / 255) * mults[b] * 1.1;
        }
      }
      for (let x = 0; x < WF_W; x++) {
        const k = WF_W - 1 - x; // hops old; newest column at the right
        const base = hist && valid > 0 && k < valid ? (rowsTotal - 1 - k) * WF_H : -1;
        const decay = valid > 0 ? 0 : Math.pow(x / (WF_W - 1), 1.6);
        for (let y = 0; y < WF_H; y++) {
          const b = WF_H - 1 - y; // low bands at the bottom
          let v = 0;
          if (base >= 0 && hist) v = (hist[base + b] / 255) * mults[b];
          else if (valid === 0) v = fin(cur[b], 0) * decay;
          // Absolute level (gamma 1.7) keeps quiet bands dark like a real
          // spectrogram; the relative term lets transients bloom past a band's
          // sustained level so hats/snares read against a loud bass.
          const lvl = clamp01(v);
          const rel = ref[b] > 0 ? v / ref[b] : 0;
          const shaped = softKnee((Math.pow(lvl, 1.7) * 0.8 + Math.max(0, rel - 1) * 0.35) * boost);
          const idx = Math.min(255, Math.round(shaped * 255));
          const o = (y * WF_W + x) * 4;
          data[o] = lut[idx * 3];
          data[o + 1] = lut[idx * 3 + 1];
          data[o + 2] = lut[idx * 3 + 2];
          data[o + 3] = 255;
        }
      }
      surf.ctx.putImageData(surf.img, 0, 0);
    }

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(cx, cy);
    if (vertical) ctx.rotate(Math.PI / 2);
    if (surf) {
      try { ctx.drawImage(surf.canvas, -dw / 2, -dh / 2, dw, dh); } catch { /* surface not ready */ }
    }
    // Bright leading edge from the live spectrum.
    const edgeX = dw / 2;
    const cellH = dh / WF_H;
    for (let b = 0; b < WF_H; b++) {
      const v = clamp01(fin(cur[b], 0) * react);
      if (v < 0.03) continue;
      const y = dh / 2 - (b + 1) * cellH;
      const ew = (4 + v * 30) * size;
      ctx.fillStyle = mixHex(cfg.accent, "#ffffff", v * 0.8, 0.3 + 0.65 * v);
      ctx.fillRect(edgeX - ew, y, ew, cellH + 0.5);
    }
    ctx.restore();
  },
};

// ═════════════════════════════════════════════════════════════════════════
// 7. Vocal Bloom — a flower of light that opens with the vocal.
// ═════════════════════════════════════════════════════════════════════════

const vocalBloom: Preset = {
  id: "vocal-bloom", name: "Vocal Bloom", category: "Organic",
  description: "A flower of light that opens its petals when the vocal comes in, breathes with the bass and ripples on hits.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const thick = thicknessOf(cfg);
    const { cx, cy } = center(d);
    const energy = clamp01(energyOf(audio));
    const vocal = clamp01(vocalOf(audio) * react);
    const bass = clamp01(audio.bass);
    const kick = kickOf(audio);
    const open = smoothstep(0.08, 0.65, vocal);
    const N = 16;
    const baseR = Math.max(10, Math.min(w, h) * 0.3 * size);
    const breathe = 1 + 0.05 * Math.sin(t * 1.1) + 0.14 * bass * react;
    const spin = fin(cfg.rotation, 0) + t * 0.08;
    const tilt = open * Math.PI / 8;
    const lenF = 0.3 + 0.7 * open;

    withGlowLayer(ctx, { color: cfg.glow, intensity: clamp(fin(cfg.glowIntensity, 0.8), 0, 3) * 0.8 }, (g) => {
      g.save();
      g.translate(cx, cy);
      g.globalCompositeOperation = "lighter";

      // Ripple rings from the last onset (up to three, spaced in time).
      const age = fin(audio.onsetAge, Number.NaN);
      if (Number.isFinite(age) && age >= 0) {
        for (let j = 0; j < 3; j++) {
          const a = age + j * 0.28;
          const life = 1 - a / 1.1;
          if (life <= 0) continue;
          g.strokeStyle = hexA(j % 2 ? cfg.secondary : cfg.accent, life * 0.35);
          g.lineWidth = Math.max(1, thick * 0.5 * life);
          g.beginPath(); g.arc(0, 0, Math.max(1, baseR * (0.35 + a * 1.3)), 0, TAU); g.stroke();
        }
      }

      // Petals: 8 always, 8 more fade in with energy (interleaved slots).
      for (let layer = 0; layer < 2; layer++) {
        for (let i = 0; i < N; i++) {
          const slot = i < 8 ? i * 2 : (i - 8) * 2 + 1;
          const extra = i < 8 ? 1 : clamp01(energy * 8 - (i - 8) + 0.5);
          if (extra <= 0.02) continue;
          const p = 0.398 + (slot / N) * 0.417; // ≈ 400 Hz … 6 kHz on the log axis
          const jit = clamp01(freqAtPos(audio, p, cfg));
          const dir = slot % 2 ? 1 : -1;
          const ang = (slot / N) * TAU + spin + (layer ? TAU / (2 * N) : 0) + tilt * dir * (layer ? 0.6 : 1);
          const L = Math.max(2, baseR * lenF * breathe * (layer ? 0.62 : 1) * (0.82 + 0.36 * jit * react) * (0.6 + 0.4 * extra));
          const wid = L * (0.42 + 0.2 * open) * (layer ? 0.8 : 1);
          g.save();
          g.rotate(ang);
          const pg = g.createLinearGradient(0, 0, 0, -L);
          pg.addColorStop(0, hexA(cfg.accent, 0.55 * extra));
          pg.addColorStop(0.6, hexA(layer ? cfg.secondary : cfg.primary, 0.45 * extra));
          pg.addColorStop(1, hexA(cfg.primary, 0.05 * extra));
          g.fillStyle = pg;
          g.beginPath();
          g.moveTo(0, 0);
          g.quadraticCurveTo(wid / 2, -L * 0.55, 0, -L);
          g.quadraticCurveTo(-wid / 2, -L * 0.55, 0, 0);
          g.closePath();
          g.fill();
          g.restore();
        }
      }

      // Core with a tiny pop on kicks.
      const coreR = Math.max(2, baseR * 0.07 * (1 + 0.7 * kick * react) + baseR * 0.02 * open);
      const cg = g.createRadialGradient(0, 0, 0, 0, 0, coreR * 2.2);
      cg.addColorStop(0, "rgba(255,255,255,0.95)");
      cg.addColorStop(0.35, hexA(cfg.primary, 0.7));
      cg.addColorStop(1, hexA(cfg.accent, 0));
      g.fillStyle = cg;
      g.beginPath(); g.arc(0, 0, coreR * 2.2, 0, TAU); g.fill();
      g.restore();
    });
  },
};

export const SHOWCASE_PRESETS: Preset[] = [coverStage, vinylSpin, nowPlaying, kineticType, spectrumTerrain, spectralWaterfall, vocalBloom];

// Keep the DrawContext type referenced for packs that extend this file.
export type { DrawContext };
