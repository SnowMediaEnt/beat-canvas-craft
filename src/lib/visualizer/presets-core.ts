// The original 33 presets, ported onto the shared draw helpers.
//
// What changed versus the first-generation file (behaviour is otherwise
// identical, so existing projects look the same):
//  • Multi-stroke glows go through withGlowLayer(): one blur per layer
//    instead of one per stroke. This is the single biggest Lambda speed-up
//    (SwiftShader rasterises every shadowBlur on the CPU).
//  • Peak-hold / seed state is normalised (0..1, no pixel units), keyed by
//    DrawContext.stateKey so thumbnails never disturb the main preview, and
//    decays in seconds (dt) so 30/60/120 fps renders match the preview.
//  • Beat "kicks" use beatKick(), which decays smoothly when the audio
//    engine provides onset timing and falls back to the boolean flag.

import type { AudioData } from "./audioEngine";
import type { VisualizerConfig } from "../project/types";
import {
  TAU, hexA, mixHex, setGlow, center, freqAtPos, bandLevels, noise2,
  withGlowLayer, beatKick, hash1, clamp01,
} from "./draw-utils";

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  cfg: VisualizerConfig;
  audio: AudioData;
  t: number; // seconds elapsed on the animation clock
  logo?: HTMLImageElement;
  /** Seconds since the previous frame. Preview measures it; render passes 1/fps. */
  dt?: number;
  /** Namespace for per-preset mutable state (peak caps). "main" | "thumb" | "render" … */
  stateKey?: string;
  /** Current lyric line (if lyrics are enabled and a line is active). */
  lyric?: CurrentLyric | null;
  /** Free text presets may display when no lyric is active (song title etc.). */
  title?: string;
  /** Logo animation factors computed from the FX toggles (only for presets with consumesLogo). */
  logoFx?: { scale: number; hop: number };
}

export interface CurrentLyric {
  text: string;
  index: number;
  /** 0..1 progress through the line's duration. */
  progress: number;
  lineStart: number;
  lineEnd: number;
  /** Seconds since the line started. */
  age: number;
  nextText?: string;
}

export interface Preset {
  id: string;
  name: string;
  category: string;
  /** One-line, musician-friendly description shown in the picker. */
  description?: string;
  /** When true the preset draws the logo itself; the shared pipeline skips its own logo pass. */
  consumesLogo?: boolean;
  draw: (d: DrawContext) => void;
}

const dtOf = (d: DrawContext) => {
  const dt = d.dt;
  return typeof dt === "number" && Number.isFinite(dt) && dt > 0 ? Math.min(0.25, dt) : 1 / 60;
};

// ─── Peak-hold state (normalised, keyed, time-based) ──────────────────────
type PeakState = { count: number; peaks: number[]; vel: number[] };
const peakStates = new Map<string, PeakState>();
const PEAK_GRAVITY = 2.5; // fraction-of-max per second²

function peakState(key: string, n: number): PeakState {
  let s = peakStates.get(key);
  if (!s || s.count !== n) {
    s = { count: n, peaks: new Array(n).fill(0), vel: new Array(n).fill(0) };
    peakStates.set(key, s);
  }
  return s;
}

/** Advance one falling-cap peak. `level` and the stored peak are 0..1. */
function updatePeak(s: PeakState, i: number, level: number, dt: number): number {
  if (level >= s.peaks[i]) {
    s.peaks[i] = level;
    s.vel[i] = 0;
  } else {
    s.vel[i] += PEAK_GRAVITY * dt;
    s.peaks[i] = Math.max(level, s.peaks[i] - s.vel[i] * dt);
  }
  return s.peaks[i];
}

// 1. Circular spectrum — log-spaced N-band equalizer wrapped in a ring.
const circular: Preset = {
  id: "circular-spectrum", name: "Circular Spectrum", category: "Circular",
  description: "Classic ring of bars around your logo — bass in the ring, treble at the tips.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const radius = Math.min(w, h) * 0.22 * cfg.size * (1 + audio.bass * 0.25 * react);
    const bars = Math.max(8, cfg.bandCount || 96);
    const levels = bandLevels(audio.freq, bars, 0.75, cfg, audio);
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity }, (g) => {
      g.lineWidth = cfg.thickness;
      for (let i = 0; i < bars; i++) {
        const v = levels[i];
        const len = (8 + v * 220 * react) * cfg.size;
        const a = (i / bars) * TAU + cfg.rotation;
        const x1 = cx + Math.cos(a) * radius;
        const y1 = cy + Math.sin(a) * radius;
        const x2 = cx + Math.cos(a) * (radius + len);
        const y2 = cy + Math.sin(a) * (radius + len);
        const grad = g.createLinearGradient(x1, y1, x2, y2);
        grad.addColorStop(0, cfg.primary);
        grad.addColorStop(1, cfg.accent);
        g.strokeStyle = grad;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      }
    });
  },
};

// 2. Double circular — inner + outer rings, each a full N-band EQ.
const doubleCircular: Preset = {
  id: "double-circular", name: "Double Circular", category: "Circular",
  description: "Two counter-rotating rings of bars for a fuller, layered look.",
  draw: (d) => {
    circular.draw(d);
    const { ctx, w, h, cfg, audio } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const radius = Math.min(w, h) * 0.34 * cfg.size * (1 + audio.bass * 0.2 * react);
    const bars = Math.max(8, cfg.bandCount || 64);
    const levels = bandLevels(audio.freq, bars, 0.8, cfg, audio);
    withGlowLayer(ctx, { color: cfg.secondary, intensity: cfg.glowIntensity * 0.8 }, (g) => {
      g.lineWidth = cfg.thickness * 0.7;
      g.strokeStyle = cfg.secondary;
      for (let i = 0; i < bars; i++) {
        const v = levels[i];
        const len = (4 + v * 160 * react) * cfg.size;
        const a = -(i / bars) * TAU - cfg.rotation;
        const x1 = cx + Math.cos(a) * radius;
        const y1 = cy + Math.sin(a) * radius;
        const x2 = cx + Math.cos(a) * (radius + len);
        const y2 = cy + Math.sin(a) * (radius + len);
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      }
    });
  },
};

// 3. Pulsing ring — heavy bass-driven breathing + beat kick.
const pulsingRing: Preset = {
  id: "pulsing-ring", name: "Pulsing Ring", category: "Circular",
  description: "Three breathing rings that kick outward on every beat.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const base = Math.min(d.w, d.h) * 0.22 * cfg.size;
    const kick = beatKick(audio) * 40;
    const r = base + (audio.bass * 200 + audio.volume * 60 + kick) * react * cfg.size;
    const wob = Math.sin(t * 4) * audio.mid * 18 * react;
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * (1 + audio.bass * 1.5) }, (g) => {
      g.lineWidth = cfg.thickness + audio.volume * 18 * react;
      g.strokeStyle = cfg.primary;
      g.beginPath(); g.arc(cx, cy, Math.max(1, r + wob), 0, TAU); g.stroke();
      g.lineWidth = cfg.thickness * 0.5;
      g.strokeStyle = hexA(cfg.accent, 0.6);
      g.beginPath(); g.arc(cx, cy, Math.max(1, r * 1.25 + audio.mid * 90 * react), 0, TAU); g.stroke();
      g.strokeStyle = hexA(cfg.secondary, 0.4);
      g.beginPath(); g.arc(cx, cy, Math.max(1, r * 1.55 + audio.treble * 70 * react), 0, TAU); g.stroke();
    });
  },
};

// 4. Soft bass glow — radius and intensity react aggressively to bass + beat.
const bassGlow: Preset = {
  id: "bass-glow", name: "Soft Bass Glow", category: "Ambient",
  description: "A soft light that swells with the bass — great behind a logo.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const kick = beatKick(audio) * 0.25;
    const r = Math.max(1, Math.min(d.w, d.h) * (0.22 + (audio.bass * 0.7 + audio.volume * 0.25 + kick) * react) * cfg.size);
    const ox = Math.sin(t * 0.9) * audio.mid * 80 * react;
    const oy = Math.cos(t * 0.7) * audio.mid * 60 * react;
    const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r);
    const boost = 1 + audio.volume * 0.5;
    g.addColorStop(0, hexA(cfg.primary, Math.min(1, 0.7 * cfg.glowIntensity * boost)));
    g.addColorStop(0.55, hexA(cfg.accent, Math.min(1, 0.28 * cfg.glowIntensity * boost)));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, d.w, d.h);
  },
};

// 5. Horizontal waveform
const waveform: Preset = {
  id: "waveform", name: "Horizontal Waveform", category: "Wave",
  description: "The raw audio wave drawn across the screen.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const cy = h / 2 + cfg.position.y * h / 2;
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    ctx.lineWidth = cfg.thickness;
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, cfg.primary); g.addColorStop(1, cfg.accent);
    ctx.strokeStyle = g;
    ctx.beginPath();
    const wave = audio.wave;
    for (let i = 0; i < wave.length; i++) {
      const x = (i / wave.length) * w;
      const v = (wave[i] - 128) / 128;
      const y = cy + v * h * 0.3 * cfg.size;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  },
};

// 6. Vertical EQ bars — clean log-spaced equalizer
const eqBars: Preset = {
  id: "eq-bars", name: "Equalizer Bars", category: "Bars",
  description: "Clean bottom-anchored EQ bars. The essential look.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const bars = Math.max(2, cfg.bandCount || 12);
    const levels = bandLevels(audio.freq, bars, 0.7, cfg, audio);
    const slot = w / bars;
    const bw = slot * 0.7;
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.6 }, (g) => {
      for (let i = 0; i < bars; i++) {
        const v = levels[i];
        const bh = v * h * 0.7 * cfg.size;
        const grad = g.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, cfg.primary); grad.addColorStop(1, cfg.accent);
        g.fillStyle = grad;
        g.fillRect(i * slot + (slot - bw) / 2, h - bh, bw, bh);
      }
    });
  },
};

// 7. Mirrored bars — centered equalizer
const mirroredBars: Preset = {
  id: "mirrored-bars", name: "Mirrored Bars", category: "Bars",
  description: "Bars grow up and down from the centre line.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const bars = Math.max(2, cfg.bandCount || 12);
    const levels = bandLevels(audio.freq, bars, 0.7, cfg, audio);
    const mid = h / 2 + cfg.position.y * h / 2;
    const slot = w / bars;
    const bw = slot * 0.7;
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.6 }, (g) => {
      for (let i = 0; i < bars; i++) {
        const v = levels[i];
        const bh = v * h * 0.4 * cfg.size;
        const grad = g.createLinearGradient(0, mid - bh, 0, mid + bh);
        grad.addColorStop(0, cfg.accent); grad.addColorStop(0.5, cfg.primary); grad.addColorStop(1, cfg.accent);
        g.fillStyle = grad;
        g.fillRect(i * slot + (slot - bw) / 2, mid - bh, bw, bh * 2);
      }
    });
  },
};

// 8. Radial bars
const radialBars: Preset = {
  id: "radial-bars", name: "Radial Bars", category: "Circular",
  description: "Thick rounded spokes bursting from the centre.",
  draw: (d) => {
    const { ctx, cfg, audio } = d;
    const { cx, cy } = center(d);
    const bars = Math.max(3, cfg.bandCount || 12);
    const radius = Math.min(d.w, d.h) * 0.15 * cfg.size;
    const levels = bandLevels(audio.freq, bars, 0.7, cfg, audio);
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity }, (g) => {
      g.lineWidth = cfg.thickness * 2.2; g.lineCap = "round";
      for (let i = 0; i < bars; i++) {
        const v = levels[i];
        const len = 20 + v * 220 * cfg.size;
        const a = (i / bars) * TAU + cfg.rotation;
        const x1 = cx + Math.cos(a) * radius, y1 = cy + Math.sin(a) * radius;
        const x2 = cx + Math.cos(a) * (radius + len), y2 = cy + Math.sin(a) * (radius + len);
        const grad = g.createLinearGradient(x1, y1, x2, y2);
        grad.addColorStop(0, cfg.primary); grad.addColorStop(1, cfg.accent);
        g.strokeStyle = grad;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      }
      g.lineCap = "butt";
    });
  },
};

// 9. Particle burst
const particleBurst: Preset = {
  id: "particle-burst", name: "Particle Burst", category: "Particles",
  description: "Dots stream outward from the centre, faster when the music is loud.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const count = Math.max(12, Math.min(360, (cfg.bandCount || 12) * 5));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const dist = (50 + ((t * 40 + i * 9) % 300)) * (0.5 + audio.volume);
      const x = cx + Math.cos(a) * dist; const y = cy + Math.sin(a) * dist;
      const size = 2 + audio.bass * 6;
      ctx.fillStyle = hexA(i % 2 ? cfg.primary : cfg.accent, Math.max(0, 1 - dist / 350));
      ctx.beginPath(); ctx.arc(x, y, size, 0, TAU); ctx.fill();
    }
  },
};

// 10. Liquid blob — N-band perimeter, heavy bass swell, dual layer wobble.
const liquidBlob: Preset = {
  id: "liquid-blob", name: "Liquid Blob", category: "Morph",
  description: "A wobbling blob whose edge is the spectrum. Swells hard on bass.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const points = Math.max(24, cfg.bandCount || 80);
    const levels = bandLevels(audio.freq, points, 0.8, cfg, audio);
    const kick = beatKick(audio) * 30;
    const base = Math.min(d.w, d.h) * 0.2 * cfg.size * (1 + audio.bass * 0.45 * react);
    const ox = Math.sin(t * 1.1) * audio.mid * 50 * react;
    const oy = Math.cos(t * 0.9) * audio.mid * 40 * react;
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * (1 + audio.bass * 0.8) }, (g) => {
      // Outer halo blob
      g.fillStyle = hexA(cfg.accent, 0.35);
      g.beginPath();
      for (let i = 0; i <= points; i++) {
        const a = (i / points) * TAU + cfg.rotation * 0.5;
        const v = levels[i % points];
        const r = base * 1.25 + (v * 180 + kick) * react * cfg.size
          + Math.sin(t * 1.7 + i * 0.4) * (14 + audio.treble * 40 * react);
        const x = cx + ox + Math.cos(a) * r;
        const y = cy + oy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();

      // Core blob
      const grad = g.createRadialGradient(cx + ox, cy + oy, base * 0.2, cx + ox, cy + oy, base * 1.4);
      grad.addColorStop(0, hexA(cfg.primary, 0.9));
      grad.addColorStop(1, hexA(cfg.accent, 0.4));
      g.fillStyle = grad;
      g.beginPath();
      for (let i = 0; i <= points; i++) {
        const a = (i / points) * TAU;
        const v = levels[i % points];
        const r = base + (v * 220 + kick * 1.4) * react * cfg.size
          + Math.sin(t * 3 + i * 0.7) * (10 + audio.mid * 30 * react)
          + Math.sin(t * 5.5 + i * 1.3) * audio.treble * 18 * react;
        const x = cx + ox + Math.cos(a) * r;
        const y = cy + oy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    });
  },
};

// 11. Oscilloscope
const oscilloscope: Preset = {
  id: "oscilloscope", name: "Oscilloscope", category: "Wave",
  description: "A bold, tri-colour scope trace of the waveform.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const cy = h / 2 + cfg.position.y * h / 2;
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    ctx.lineWidth = Math.max(1, cfg.thickness * (0.8 + cfg.size * 0.4));
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, cfg.primary);
    g.addColorStop(0.5, cfg.accent);
    g.addColorStop(1, cfg.secondary);
    ctx.strokeStyle = g;
    ctx.beginPath();
    const wave = audio.wave;
    for (let i = 0; i < wave.length; i++) {
      const x = (i / wave.length) * w;
      const y = cy + ((wave[i] - 128) / 128) * h * 0.45 * cfg.size;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  },
};

// 12. Multi wave ribbons
const ribbons: Preset = {
  id: "ribbons", name: "Wave Ribbons", category: "Wave",
  description: "Layered sine ribbons that swell where the spectrum is loud.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const layers = Math.max(2, Math.min(24, Math.round((cfg.bandCount || 5) / 2)));
    for (let l = 0; l < layers; l++) {
      ctx.strokeStyle = hexA(l % 2 ? cfg.primary : cfg.accent, 0.4 + l * 0.1);
      ctx.lineWidth = cfg.thickness * (0.5 + l * 0.2);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const v = freqAtPos(audio, x / w, cfg);
        const y = h / 2 + Math.sin(x * 0.01 + t * (1 + l * 0.3)) * (40 + v * 80) * cfg.size + (l - layers / 2) * 18;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
};

// 13. Frequency tunnel
const tunnel: Preset = {
  id: "tunnel", name: "Frequency Tunnel", category: "3D",
  description: "Spectrum rings rush toward you — bass speeds up the tunnel.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const rings = Math.max(4, Math.min(48, Math.round((cfg.bandCount || 60) / 4)));
    const verts = Math.max(24, cfg.bandCount || 60);
    const levels = bandLevels(audio.freq, verts, 0.85, cfg, audio);
    const speed = 0.5 + audio.bass * 1.4 * react;
    for (let i = 0; i < rings; i++) {
      const p = ((i + (t * speed) % 1) / rings);
      const r = p * Math.min(d.w, d.h) * 0.7 * cfg.size * (1 + audio.bass * 0.25 * react);
      ctx.strokeStyle = hexA(i % 2 ? cfg.primary : cfg.accent, 1 - p);
      ctx.lineWidth = Math.max(0.5, (1 - p) * cfg.thickness * 2);
      ctx.beginPath();
      for (let v = 0; v <= verts; v++) {
        const a = (v / verts) * TAU + cfg.rotation * p;
        const f = levels[v % verts];
        const rr = r + f * 80 * react * cfg.size * (1 - p * 0.5);
        const x = cx + Math.cos(a) * rr; const y = cy + Math.sin(a) * rr;
        if (v === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
    }
  },
};

// 14. Diamond frame
const diamond: Preset = {
  id: "diamond-frame", name: "Diamond Frame", category: "Shapes",
  description: "A sharp double diamond that expands on the bass.",
  draw: (d) => {
    const { ctx, cfg, audio } = d;
    const { cx, cy } = center(d);
    const size = Math.min(d.w, d.h) * 0.3 * cfg.size + audio.bass * 60;
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    ctx.strokeStyle = cfg.primary; ctx.lineWidth = cfg.thickness + audio.volume * 6;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4 + cfg.rotation);
    ctx.strokeRect(-size, -size, size * 2, size * 2);
    ctx.strokeStyle = hexA(cfg.accent, 0.6); ctx.strokeRect(-size * 1.15, -size * 1.15, size * 2.3, size * 2.3);
    ctx.restore(); ctx.shadowBlur = 0;
  },
};

// 15. Logo outline
const logoOutline: Preset = {
  id: "logo-outline", name: "Logo Outline", category: "Logo",
  description: "A glowing ring that hugs your logo and breathes with volume.",
  draw: (d) => {
    const { ctx, cfg, audio } = d;
    const { cx, cy } = center(d);
    const r = Math.min(d.w, d.h) * 0.2 * cfg.size + audio.volume * 40;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 1.4);
    ctx.lineWidth = cfg.thickness + 2;
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, cfg.primary); g.addColorStop(1, cfg.accent);
    ctx.strokeStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, r), 0, TAU); ctx.stroke();
    ctx.shadowBlur = 0;
  },
};

// 16. Minimal bottom waveform
const bottomWave: Preset = {
  id: "bottom-wave", name: "Minimal Bottom Wave", category: "Wave",
  description: "A filled spectrum landscape along the bottom edge. Subtle and clean.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const bars = Math.min(384, Math.max(8, (cfg.bandCount || 12) * 4));
    const levels = bandLevels(audio.freq, bars, 0.75, cfg, audio);
    const baseY = h - 60 + cfg.position.y * h * 0.2;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.7);
    const g = ctx.createLinearGradient(0, baseY - 200 * cfg.size, 0, h);
    g.addColorStop(0, hexA(cfg.accent, 0.9));
    g.addColorStop(1, hexA(cfg.primary, 0.85));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i < bars; i++) {
      const x = (i / (bars - 1)) * w;
      const v = levels[i];
      const y = baseY - v * 180 * cfg.size;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = cfg.accent;
    ctx.lineWidth = Math.max(1, cfg.thickness * 0.8);
    ctx.beginPath();
    for (let i = 0; i < bars; i++) {
      const x = (i / (bars - 1)) * w;
      const v = levels[i];
      const y = baseY - v * 180 * cfg.size;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};

// 17. Ambient pulse
const ambient: Preset = {
  id: "ambient-pulse", name: "Ambient Pulse", category: "Ambient",
  description: "The whole frame breathes with colour — no shapes, just mood.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const kick = beatKick(audio) * 0.35;
    const pulse = 0.7 + (audio.bass * 0.6 + audio.volume * 0.3 + kick) * react;
    const radius = Math.max(1, Math.max(w, h) * cfg.size * pulse);
    const ox = Math.sin(t * 0.6) * audio.mid * 100 * react;
    const oy = Math.cos(t * 0.45) * audio.mid * 80 * react;
    const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, radius);
    const intensity = 0.3 + (audio.volume * 0.8 + audio.bass * 0.5 + kick) * react;
    g.addColorStop(0, hexA(cfg.primary, Math.min(1, intensity)));
    g.addColorStop(0.4, hexA(cfg.accent, Math.min(1, intensity * 0.65)));
    g.addColorStop(0.75, hexA(cfg.secondary, Math.min(1, intensity * 0.3)));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  },
};

// 18. Floating orb
const floatingOrb: Preset = {
  id: "floating-orb", name: "Floating Orb", category: "Ambient",
  description: "A glowing orb that drifts around the frame and flares on the beat.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const kick = beatKick(audio) * 50;
    const driftX = Math.min(d.w, d.h) * 0.32 * (0.4 + audio.mid * 1.2 * react);
    const driftY = Math.min(d.w, d.h) * 0.22 * (0.4 + audio.treble * 1.2 * react);
    const x = cx + Math.sin(t * 1.1 + audio.volume * 2) * driftX
      + Math.sin(t * 2.7) * audio.treble * 40 * react;
    const y = cy + Math.cos(t * 0.85 + audio.bass * 2) * driftY
      + Math.cos(t * 3.1) * audio.treble * 30 * react;
    const r = Math.max(1, (80 * cfg.size) + (audio.bass * 220 + audio.volume * 80 + kick) * react);

    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * (1 + audio.bass * 1.2) }, (g) => {
      const tx = cx + Math.sin(t * 1.1 - 0.4 + audio.volume * 2) * driftX;
      const ty = cy + Math.cos(t * 0.85 - 0.4 + audio.bass * 2) * driftY;
      const tg = g.createRadialGradient(tx, ty, 0, tx, ty, r * 1.1);
      tg.addColorStop(0, hexA(cfg.accent, 0.35));
      tg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = tg; g.beginPath(); g.arc(tx, ty, r * 1.1, 0, TAU); g.fill();

      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, hexA(cfg.primary, 0.95));
      grad.addColorStop(0.35, hexA(cfg.accent, 0.6));
      grad.addColorStop(0.75, hexA(cfg.secondary, 0.25));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    });
  },
};

// 19. Snow particles preset
const snowField: Preset = {
  id: "snow-field", name: "Snow Field", category: "Particles",
  description: "Gentle falling flakes that speed up with the bass.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const count = Math.max(20, Math.min(400, (cfg.bandCount || 12) * 10));
    for (let i = 0; i < count; i++) {
      const seed = i * 37.3;
      const x = ((seed * 91 + t * 30) % w + w) % w;
      const y = ((seed * 53 + t * 60 * (1 + audio.bass)) % h + h) % h;
      const r = 1 + (Math.sin(seed) + 1) * 2;
      ctx.fillStyle = hexA(cfg.primary, 0.5 + Math.sin(seed) * 0.3);
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
  },
};

// 20. Cinematic light wave
const lightWave: Preset = {
  id: "light-wave", name: "Cinematic Light Wave", category: "Wave",
  description: "Wide, soft light bands rolling across the frame.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const layerCount = Math.max(2, Math.min(12, Math.round((cfg.bandCount || 3))));
    for (let l = 0; l < layerCount; l++) {
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, hexA(l === 0 ? cfg.primary : l === 1 ? cfg.accent : cfg.secondary, 0.6));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(0.5, cfg.thickness * (3 - Math.min(l, 2)) + audio.volume * 10);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 5) {
        const v = freqAtPos(audio, x / w, cfg);
        const y = h / 2 + Math.sin(x * 0.005 + t * 1.5 + l) * (60 + v * 100) + (l - 1) * 30;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
};

// 21. Rolling wave with bars perpendicular to the line
const rollingWave: Preset = {
  id: "rolling-wave", name: "Rolling Wave Bars", category: "Unconventional",
  description: "EQ bars riding a rolling wave like a moving comb.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const bars = Math.min(384, Math.max(8, cfg.bandCount || 12) * 4);
    const levels = bandLevels(audio.freq, bars, 0.75, cfg, audio);
    const baseY = h / 2 + cfg.position.y * h / 2;
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.7 }, (g) => {
      g.lineCap = "round";
      g.lineWidth = cfg.thickness;
      for (let i = 0; i < bars; i++) {
        const px = (i / (bars - 1)) * w;
        const phase = (px * 0.012) - t * 2.2;
        const y = baseY + Math.sin(phase) * 80 * cfg.size + Math.sin(phase * 0.5) * 20;
        const slope = Math.cos(phase) * 0.012;
        const nx = -Math.sin(Math.atan(slope * 100));
        const ny = Math.cos(Math.atan(slope * 100));
        const len = 10 + levels[i] * 180 * cfg.size;
        const grad = g.createLinearGradient(px, y, px + nx * len, y - ny * len);
        grad.addColorStop(0, cfg.primary); grad.addColorStop(1, cfg.accent);
        g.strokeStyle = grad;
        g.beginPath();
        g.moveTo(px - nx * len * 0.3, y + ny * len * 0.3);
        g.lineTo(px + nx * len, y - ny * len);
        g.stroke();
      }
      g.lineCap = "butt";
    });
  },
};

// 22. Spiral bars expanding outward
const spiralBars: Preset = {
  id: "spiral-bars", name: "Spiral Bars", category: "Unconventional",
  description: "A galaxy spiral of tiny bars slowly rotating outward.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const bars = Math.min(512, Math.max(40, (cfg.bandCount || 12) * 8));
    const levels = bandLevels(audio.freq, bars, 0.85, cfg, audio);
    const turns = 4;
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.6 }, (g) => {
      g.lineCap = "round";
      for (let i = 0; i < bars; i++) {
        const p = i / bars;
        const a = p * TAU * turns + t * 0.6 + cfg.rotation;
        const r = 10 + p * Math.min(d.w, d.h) * 0.45 * cfg.size;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        const len = 6 + levels[i] * 90 * cfg.size;
        const tx = Math.cos(a + Math.PI / 2), ty = Math.sin(a + Math.PI / 2);
        // Colour by position instead of a per-bar gradient (512 gradients/frame was pure overhead).
        g.strokeStyle = mixHex(cfg.primary, cfg.accent, p, 0.9 - p * 0.4);
        g.lineWidth = Math.max(0.5, cfg.thickness * (1 - p * 0.6));
        g.beginPath();
        g.moveTo(x - tx * len * 0.3, y - ty * len * 0.3);
        g.lineTo(x + tx * len, y + ty * len);
        g.stroke();
      }
      g.lineCap = "butt";
    });
  },
};

// 23. Recursive fractal tree
const fractalTree: Preset = {
  id: "fractal-tree", name: "Fractal Tree", category: "Unconventional",
  description: "A branching tree that sways with the mids and grows on the bass.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const baseLen = Math.min(d.w, d.h) * 0.16 * cfg.size + audio.bass * 30;
    const sway = Math.sin(t * 1.2) * 0.15 + audio.mid * 0.3 * (cfg.reactivity ?? 1);
    const depth = 9;
    // One colour per depth level (was one gradient per branch = ~770 gradients/frame).
    const colours: string[] = [];
    for (let k = 0; k <= depth; k++) colours[k] = mixHex(cfg.accent, cfg.primary, k / depth);
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.5 }, (g) => {
      const branch = (x: number, y: number, len: number, ang: number, dep: number) => {
        if (dep === 0 || len < 2) return;
        const x2 = x + Math.cos(ang) * len;
        const y2 = y + Math.sin(ang) * len;
        g.strokeStyle = colours[dep];
        g.lineWidth = Math.max(0.5, dep * 0.6 + cfg.thickness * 0.3);
        g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
        const next = len * 0.72;
        branch(x2, y2, next, ang - 0.45 - sway, dep - 1);
        branch(x2, y2, next, ang + 0.45 + sway, dep - 1);
      };
      branch(cx, cy + baseLen, baseLen, -Math.PI / 2 + cfg.rotation, depth);
      branch(cx, cy + baseLen, baseLen * 0.7, -Math.PI / 2 + cfg.rotation + 0.6, depth - 2);
      branch(cx, cy + baseLen, baseLen * 0.7, -Math.PI / 2 + cfg.rotation - 0.6, depth - 2);
    });
  },
};

// 24. Leaf/petal border that orbits the logo
const leafBorder: Preset = {
  id: "leaf-border", name: "Leaf Border", category: "Unconventional",
  description: "A wreath of petals around the logo — each petal is a frequency band.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const leaves = Math.min(256, Math.max(12, (cfg.bandCount || 12) * 2));
    const levels = bandLevels(audio.freq, leaves, 0.7, cfg, audio);
    const baseR = Math.min(d.w, d.h) * (0.18 + cfg.logoSize * 0.3) * cfg.size;
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.6 }, (g) => {
      for (let i = 0; i < leaves; i++) {
        const a = (i / leaves) * TAU + t * 0.25 + cfg.rotation;
        const v = levels[i];
        const r = baseR + 6 + v * 70 * cfg.size;
        const lw = 14 + v * 40;
        const ll = 38 + v * 80;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        g.save();
        g.translate(x, y); g.rotate(a + Math.PI / 2);
        const grad = g.createLinearGradient(0, -ll / 2, 0, ll / 2);
        grad.addColorStop(0, hexA(cfg.accent, 0.95)); grad.addColorStop(1, hexA(cfg.primary, 0.6));
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(0, -ll / 2);
        g.quadraticCurveTo(lw / 2, 0, 0, ll / 2);
        g.quadraticCurveTo(-lw / 2, 0, 0, -ll / 2);
        g.fill();
        g.strokeStyle = hexA(cfg.glow, 0.6); g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, -ll / 2); g.lineTo(0, ll / 2); g.stroke();
        g.restore();
      }
    });
  },
};

// 25. Lissajous knot
const lissajous: Preset = {
  id: "lissajous", name: "Lissajous Knot", category: "Unconventional",
  description: "A looping mathematical knot that re-ties itself with the bass and mids.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const R = Math.min(d.w, d.h) * 0.32 * cfg.size;
    const steps = Math.max(120, Math.min(2048, (cfg.bandCount || 12) * 12));
    const a = 3 + Math.floor(audio.bass * 3);
    const b = 2 + Math.floor(audio.mid * 4);
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    g.addColorStop(0, cfg.primary); g.addColorStop(1, cfg.accent);
    ctx.strokeStyle = g; ctx.lineWidth = cfg.thickness;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const u = (i / steps) * TAU;
      const wob = 1 + audio.volume * 0.4 * (cfg.reactivity ?? 1);
      const x = cx + Math.sin(a * u + t) * R * wob;
      const y = cy + Math.sin(b * u + t * 0.7) * R * wob * 0.75;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  },
};

// ============================================================
// ORGANIC MOTION presets
// ============================================================

// 26. Fluid Flow
const fluidFlow: Preset = {
  id: "fluid-flow", name: "Fluid Flow", category: "Organic",
  description: "Flowing current lines, like wind over water, each tied to a frequency.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const lines = Math.max(6, Math.min(64, Math.round((cfg.bandCount || 18) * 1.5)));
    const step = 18;
    const react = cfg.reactivity ?? 1;
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.6 }, (g) => {
      g.lineCap = "round";
      for (let l = 0; l < lines; l++) {
        const p = l / (lines - 1);
        const band = freqAtPos(audio, p, cfg);
        const amp = (30 + band * 220 + audio.volume * 40) * cfg.size * react;
        const baseY = h * (0.15 + p * 0.7);
        const tt = t * (0.35 + p * 0.4) + audio.bass * 0.6;
        const col = l % 3 === 0 ? cfg.primary : l % 3 === 1 ? cfg.accent : cfg.secondary;
        g.strokeStyle = hexA(col, 0.35 + band * 0.55);
        g.lineWidth = (cfg.thickness * 0.6) + band * cfg.thickness * 1.5;
        g.beginPath();
        for (let x = 0; x <= w; x += step) {
          const nx = x * 0.0035;
          const n1 = noise2(nx + tt * 0.5, p * 3.7 + tt * 0.2) - 0.5;
          const n2 = noise2(nx * 3 + tt * 1.2, p * 7.1) - 0.5;
          const y = baseY + n1 * amp + n2 * amp * 0.35 + Math.sin(x * 0.01 + tt * 1.7) * 8;
          if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
      g.lineCap = "butt";
    });
  },
};

// 27. Aurora Veil
const auroraVeil: Preset = {
  id: "aurora-veil", name: "Aurora Veil", category: "Organic",
  description: "Northern-lights curtains that waver with the mids and shimmer with treble.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const curtains = Math.max(2, Math.min(32, Math.round((cfg.bandCount || 6) / 2)));
    const react = cfg.reactivity ?? 1;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let c = 0; c < curtains; c++) {
      const p = c / (curtains - 1);
      const band = freqAtPos(audio, p, cfg);
      const phase = t * (0.6 + p * 0.5) + p * 1.7;
      const cx = w * (0.15 + p * 0.7) + Math.sin(phase) * 80 + audio.bass * 60 * (p - 0.5);
      const width = (90 + band * 220 + audio.bass * 80) * cfg.size * react;
      const col = c % 3 === 0 ? cfg.primary : c % 3 === 1 ? cfg.accent : cfg.secondary;
      ctx.beginPath();
      const segs = 40;
      for (let i = 0; i <= segs; i++) {
        const yy = (i / segs) * h;
        const wob = Math.sin(yy * 0.012 + phase * 1.6) * (24 + audio.mid * 60) +
                    Math.sin(yy * 0.04 + phase * 3) * (8 + audio.treble * 30);
        ctx.lineTo(cx + wob - width / 2, yy);
      }
      for (let i = segs; i >= 0; i--) {
        const yy = (i / segs) * h;
        const wob = Math.sin(yy * 0.012 + phase * 1.6) * (24 + audio.mid * 60) +
                    Math.sin(yy * 0.04 + phase * 3) * (8 + audio.treble * 30);
        ctx.lineTo(cx + wob + width / 2, yy);
      }
      ctx.closePath();
      const g = ctx.createLinearGradient(cx - width, 0, cx + width, 0);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.5, hexA(col, 0.35 + band * 0.45));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
  },
};

// 28. Murmuration — swarming particles flowing through a noise vector field.
// Seeds are normalised (0..1) so any canvas size / thumbnail can share them
// without one clobbering the other.
const murmurationSeeds: { hx: number; hy: number }[] = [];
function murmurationSeed(i: number) {
  let s = murmurationSeeds[i];
  if (!s) {
    const seed = i * 0.6180339;
    s = { hx: (seed * 53.13) % 1, hy: (seed * 71.71) % 1 };
    murmurationSeeds[i] = s;
  }
  return s;
}
const murmuration: Preset = {
  id: "murmuration", name: "Murmuration", category: "Organic",
  description: "A flock of dots swirling through an invisible wind field.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const count = Math.max(40, Math.min(400, (cfg.bandCount || 12) * 12));
    const react = cfg.reactivity ?? 1;
    const kick = 1 + beatKick(audio) * 0.6;
    ctx.shadowBlur = 0;
    for (let i = 0; i < count; i++) {
      const s = murmurationSeed(i);
      const hx = s.hx * w, hy = s.hy * h;
      const nx = hx * 0.005 + t * 0.25;
      const ny = hy * 0.005 + t * 0.3;
      const ang = noise2(nx, ny) * Math.PI * 4 + t * 0.4;
      const radius = (40 + audio.volume * 160 + audio.bass * 90) * cfg.size * react * kick;
      const px = hx + Math.cos(ang) * radius;
      const py = hy + Math.sin(ang) * radius * 0.85;
      const band = freqAtPos(audio, i / Math.max(1, count - 1), cfg);
      const r = 1 + band * 4 + beatKick(audio) * 1.5;
      const col = i % 3 === 0 ? cfg.primary : i % 3 === 1 ? cfg.accent : cfg.secondary;
      ctx.fillStyle = hexA(col, 0.4 + band * 0.6);
      ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
    }
  },
};

// 29. Tidal Bloom
const tidalBloom: Preset = {
  id: "tidal-bloom", name: "Tidal Bloom", category: "Organic",
  description: "Ripples that keep expanding from the centre like drops in a pond.",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const ringCount = Math.max(4, Math.min(64, cfg.bandCount || 18));
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.7 }, (g) => {
      for (let i = 0; i < ringCount; i++) {
        const cycle = 2.2;
        const localT = ((t + (i / ringCount) * cycle) % cycle) / cycle;
        const r = localT * Math.min(d.w, d.h) * 0.55 * cfg.size * (1 + audio.bass * 0.4 * react);
        const fade = 1 - localT;
        g.strokeStyle = hexA(i % 2 ? cfg.primary : cfg.accent, fade * (0.55 + audio.volume * 0.4));
        g.lineWidth = Math.max(0.5, cfg.thickness * (0.4 + fade * 1.4));
        g.beginPath();
        const segs = 80;
        for (let s = 0; s <= segs; s++) {
          const a = (s / segs) * TAU;
          const band = freqAtPos(audio, s / segs, cfg);
          const wob = Math.sin(a * 6 + t * 2 + i) * (4 + audio.mid * 24) +
                      Math.sin(a * 14 - t * 3) * (audio.treble * 16);
          const rr = r + wob + band * 30 * fade;
          const x = cx + Math.cos(a) * rr;
          const y = cy + Math.sin(a) * rr;
          if (s === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath(); g.stroke();
      }
    });
  },
};

// 30. Silk Strands
const silkStrands: Preset = {
  id: "silk-strands", name: "Silk Strands", category: "Organic",
  description: "Dozens of fine glowing threads, each humming at its own frequency.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const strands = Math.max(4, Math.min(64, cfg.bandCount || 22));
    const react = cfg.reactivity ?? 1;
    const levels = bandLevels(audio.freq, strands, 0.8, cfg, audio);
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.5 }, (g) => {
      for (let s = 0; s < strands; s++) {
        const p = s / (strands - 1);
        const v = levels[s];
        const freq = 0.6 + p * 3.4;
        const phase = t * freq + p * 6.28;
        const amp = (18 + v * 140 + audio.volume * 30) * cfg.size * react;
        const cyBase = h * (0.5 + Math.sin(p * 3.1 + t * 0.3) * 0.06);
        const col = s % 3 === 0 ? cfg.primary : s % 3 === 1 ? cfg.accent : cfg.secondary;
        g.strokeStyle = hexA(col, 0.3 + v * 0.6);
        g.lineWidth = (cfg.thickness * 0.4) + v * cfg.thickness;
        g.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const y = cyBase
            + Math.sin(x * 0.008 + phase) * amp
            + Math.sin(x * 0.025 + phase * 1.7) * amp * 0.3
            + (p - 0.5) * 220 * cfg.size;
          if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
    });
  },
};

// ============================================================
// CUSTOM EQUALIZER — driven entirely by cfg.custom
// ============================================================
const customEqualizer: Preset = {
  id: "custom-equalizer", name: "Custom Equalizer", category: "Custom",
  description: "Build your own: pick a shape, count, spacing and roundness. Also what the AI Generator produces.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const c = cfg.custom;
    const count = Math.max(3, Math.min(256, c.count | 0));
    const levels = bandLevels(audio.freq, count, 0.75, cfg, audio);
    const react = c.reactivity * (cfg.reactivity ?? 1);
    const stroke = c.thickness > 0 ? c.thickness : cfg.thickness;

    const bandIndex = (i: number) => {
      if (!c.symmetric) return i;
      const half = count / 2;
      return i < half ? Math.floor(half - 1 - i) : Math.floor(i - half);
    };

    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.7 }, (g) => {
      g.lineCap = c.rounded ? "round" : "butt";
      const grad = (x1: number, y1: number, x2: number, y2: number) => {
        const gr = g.createLinearGradient(x1, y1, x2, y2);
        gr.addColorStop(0, cfg.primary);
        gr.addColorStop(0.5, cfg.accent);
        gr.addColorStop(1, cfg.secondary);
        return gr;
      };

      if (c.shape === "bars" || c.shape === "mirrored" || c.shape === "wave") {
        const slot = w / count;
        const bw = Math.max(1, slot * (1 - c.spacing));
        const mid = c.shape === "mirrored" ? h / 2 + cfg.position.y * h / 2 : h;
        for (let i = 0; i < count; i++) {
          const v = levels[bandIndex(i)] * c.amplitude * react;
          const x = i * slot + (slot - bw) / 2;
          if (c.shape === "wave") {
            const baseY = h / 2 + cfg.position.y * h / 2;
            const y = baseY - v * h * 0.35 * cfg.size + Math.sin(i * 0.4 + t * 2) * 10;
            g.fillStyle = grad(x, baseY, x, y);
            g.beginPath();
            if (c.rounded) g.roundRect(x, Math.min(y, baseY), bw, Math.abs(baseY - y), bw / 2);
            else g.rect(x, Math.min(y, baseY), bw, Math.abs(baseY - y));
            g.fill();
          } else if (c.shape === "mirrored") {
            const bh = v * h * 0.4 * cfg.size;
            g.fillStyle = grad(x, mid - bh, x, mid + bh);
            g.beginPath();
            if (c.rounded) g.roundRect(x, mid - bh, bw, bh * 2, bw / 2);
            else g.rect(x, mid - bh, bw, bh * 2);
            g.fill();
          } else {
            const bh = v * h * 0.75 * cfg.size;
            g.fillStyle = grad(x, h, x, h - bh);
            g.beginPath();
            if (c.rounded) g.roundRect(x, h - bh, bw, bh, bw / 2);
            else g.rect(x, h - bh, bw, bh);
            g.fill();
          }
        }
      } else if (c.shape === "radial" || c.shape === "ring") {
        const cx = w / 2 + cfg.position.x * w / 2;
        const cy = h / 2 + cfg.position.y * h / 2;
        const baseR = Math.min(w, h) * c.innerRadius * cfg.size;
        g.lineWidth = Math.max(1, stroke * 1.4);
        for (let i = 0; i < count; i++) {
          const v = levels[bandIndex(i)] * c.amplitude * react;
          const a = (i / count) * TAU + cfg.rotation;
          if (c.shape === "ring") {
            const r = Math.max(1, baseR + v * Math.min(w, h) * 0.25 * cfg.size);
            g.strokeStyle = grad(cx, cy - r, cx, cy + r);
            g.beginPath();
            const next = ((i + 1) / count) * TAU + cfg.rotation;
            g.arc(cx, cy, r, a, next);
            g.stroke();
          } else {
            const len = 20 + v * Math.min(w, h) * 0.3 * cfg.size;
            const x1 = cx + Math.cos(a) * baseR;
            const y1 = cy + Math.sin(a) * baseR;
            const x2 = cx + Math.cos(a) * (baseR + len);
            const y2 = cy + Math.sin(a) * (baseR + len);
            g.strokeStyle = grad(x1, y1, x2, y2);
            g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
          }
        }
      } else if (c.shape === "dots") {
        const cx = w / 2 + cfg.position.x * w / 2;
        const cy = h / 2 + cfg.position.y * h / 2;
        const baseR = Math.min(w, h) * c.innerRadius * cfg.size;
        for (let i = 0; i < count; i++) {
          const v = levels[bandIndex(i)] * c.amplitude * react;
          const a = (i / count) * TAU + cfg.rotation;
          const r = baseR + v * Math.min(w, h) * 0.25 * cfg.size;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          const dotR = Math.max(1, stroke) + v * 12;
          g.fillStyle = hexA(i % 2 ? cfg.primary : cfg.accent, 0.6 + v * 0.4);
          g.beginPath(); g.arc(x, y, dotR, 0, TAU); g.fill();
        }
      } else if (c.shape === "triangles") {
        const slot = w / count;
        const bw = Math.max(2, slot * (1 - c.spacing));
        const baseY = h - 40;
        for (let i = 0; i < count; i++) {
          const v = levels[bandIndex(i)] * c.amplitude * react;
          const x = i * slot + slot / 2;
          const peak = baseY - v * h * 0.7 * cfg.size;
          g.fillStyle = grad(x, baseY, x, peak);
          g.beginPath();
          g.moveTo(x - bw / 2, baseY);
          g.lineTo(x + bw / 2, baseY);
          g.lineTo(x, peak);
          g.closePath(); g.fill();
        }
      }
      g.lineCap = "butt";
    });
  },
};

// 31. Noodle Equalizer
const PASTA_TONES = ["#e8c98a", "#d9a86c", "#c98a4a", "#f0d9a0", "#b87333", "#e0b074"];
const noodleEqualizer: Preset = {
  id: "noodle-equalizer", name: "Noodle Equalizer", category: "Organic",
  description: "Golden noodle strands that curl and bulge with each band. Yes, noodles.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const strands = Math.max(6, Math.min(24, cfg.bandCount || 12));
    const levels = bandLevels(audio.freq, strands, 0.8, cfg, audio);
    const react = cfg.reactivity ?? 1;
    const baseY = h / 2 + cfg.position.y * h / 2;
    const bandSpacing = (h * 0.55 * cfg.size) / strands;

    withGlowLayer(ctx, { color: "#caa472", intensity: cfg.glowIntensity * 0.55 }, (g) => {
      g.lineCap = "round";
      g.lineJoin = "round";
      for (let s = 0; s < strands; s++) {
        const p = s / Math.max(1, strands - 1);
        const v = levels[s] * react;
        const freq1 = 0.6 + p * 1.8;
        const freq2 = 1.4 + p * 2.6;
        const phase = t * (0.5 + p * 0.7) + p * 6.28;
        const amp = (12 + v * 90 + audio.volume * 18) * cfg.size;
        const cy = baseY + (p - 0.5) * bandSpacing * strands * 0.6
                         + Math.sin(t * 0.4 + p * 2.3) * 6;
        const color = PASTA_TONES[s % PASTA_TONES.length];
        const next = PASTA_TONES[(s + 2) % PASTA_TONES.length];
        const grad = g.createLinearGradient(0, cy - amp, w, cy + amp);
        grad.addColorStop(0, hexA(color, 0.55 + v * 0.4));
        grad.addColorStop(1, hexA(next, 0.55 + v * 0.4));
        g.strokeStyle = grad;
        g.lineWidth = (cfg.thickness * 0.6) + 2 + v * cfg.thickness * 1.4;
        g.beginPath();
        const step = 12;
        for (let x = 0; x <= w; x += step) {
          const u = x / w;
          const wave1 = Math.sin(u * TAU * freq1 + phase) * amp;
          const wave2 = Math.sin(u * TAU * freq2 - phase * 1.3) * amp * 0.35;
          const bulge = Math.sin(u * Math.PI + phase * 0.5) * v * 24 * cfg.size;
          const env = Math.sin(u * Math.PI);
          const y = cy + (wave1 + wave2 + bulge) * env;
          if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
      g.lineCap = "butt";
      g.lineJoin = "miter";
    });
  },
};

// --- Classic media-player visualizers ---------------------------------------

const itunesClassic: Preset = {
  id: "itunes-classic", name: "iTunes Classic EQ", category: "Bars",
  description: "Chunky stacked blocks with falling peak caps — the classic mini-player EQ.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const bars = Math.max(4, Math.min(64, cfg.bandCount || 16));
    const levels = bandLevels(audio.freq, bars, 0.75, cfg, audio);
    const peaks = peakState(`${d.stateKey ?? "main"}:itunes`, bars);
    const dt = dtOf(d);

    const slot = w / bars;
    const bw = slot * 0.78;
    const baseY = h * 0.95 + cfg.position.y * h * 0.05;
    const maxH = h * 0.78 * cfg.size;
    const blockH = Math.max(4, h * 0.022);
    const gap = Math.max(1, blockH * 0.25);
    const unit = blockH + gap;
    const totalBlocks = Math.max(1, Math.floor(maxH / unit));

    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.5 }, (g) => {
      for (let i = 0; i < bars; i++) {
        const v = Math.min(1, levels[i]);
        const peak = updatePeak(peaks, i, v, dt);
        const x = i * slot + (slot - bw) / 2;
        const blocks = Math.floor((v * maxH) / unit);
        for (let b = 0; b < blocks; b++) {
          const y = baseY - (b + 1) * unit;
          const p = b / totalBlocks;
          g.fillStyle = p < 0.55 ? cfg.primary : p < 0.8 ? cfg.accent : cfg.secondary;
          g.fillRect(x, y, bw, blockH);
        }
        const peakY = baseY - peak * maxH;
        g.fillStyle = cfg.secondary;
        g.fillRect(x, peakY - blockH, bw, blockH);
      }
    });
  },
};

const wmpBarsAndWaves: Preset = {
  id: "wmp-bars-waves", name: "WMP Bars & Waves", category: "Bars",
  description: "Neon bars with peak caps and a scope line on top — Windows Media Player nostalgia.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const bars = Math.max(8, Math.min(96, cfg.bandCount || 24));
    const levels = bandLevels(audio.freq, bars, 0.72, cfg, audio);
    const peaks = peakState(`${d.stateKey ?? "main"}:wmp`, bars);
    const dt = dtOf(d);

    const slot = w / bars;
    const bw = slot * 0.82;
    const baseY = h * 0.92 + cfg.position.y * h * 0.05;
    const maxH = h * 0.72 * cfg.size;

    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.7 }, (g) => {
      const grad = g.createLinearGradient(0, baseY, 0, baseY - maxH);
      grad.addColorStop(0, cfg.primary);
      grad.addColorStop(0.5, cfg.accent);
      grad.addColorStop(1, cfg.secondary);
      for (let i = 0; i < bars; i++) {
        const v = Math.min(1, levels[i]);
        const peak = updatePeak(peaks, i, v, dt);
        const bh = v * maxH;
        const x = i * slot + (slot - bw) / 2;
        g.fillStyle = grad;
        g.fillRect(x, baseY - bh, bw, bh);
        g.fillStyle = cfg.secondary;
        g.fillRect(x, baseY - peak * maxH - 3, bw, 3);
      }
    });

    // Oscilloscope wave layered over the bars (the "Waves" half)
    ctx.shadowBlur = 0;
    ctx.strokeStyle = hexA(cfg.accent, 0.9);
    ctx.lineWidth = Math.max(1.5, cfg.thickness * 0.6);
    ctx.lineCap = "round";
    ctx.beginPath();
    const wave = audio.wave;
    const midY = h / 2 + cfg.position.y * h / 2;
    const amp = h * 0.18 * cfg.size;
    for (let x = 0; x <= w; x += 4) {
      const idx = Math.floor((x / w) * wave.length);
      const s = (wave[Math.min(wave.length - 1, idx)] - 128) / 128;
      const y = midY + s * amp;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineCap = "butt";
  },
};

export const CORE_PRESETS: Preset[] = [
  circular, doubleCircular, pulsingRing, bassGlow, waveform, eqBars, mirroredBars,
  radialBars, particleBurst, liquidBlob, oscilloscope, ribbons, tunnel, diamond,
  logoOutline, bottomWave, ambient, floatingOrb, snowField, lightWave,
  rollingWave, spiralBars, fractalTree, leafBorder, lissajous,
  fluidFlow, auroraVeil, murmuration, tidalBloom, silkStrands, noodleEqualizer,
  itunesClassic, wmpBarsAndWaves,
  customEqualizer,
];

// Re-exported for preset packs that want the exact same helpers.
export { hash1, clamp01 };
