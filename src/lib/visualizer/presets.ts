import type { AudioData } from "./audioEngine";
import type { VisualizerConfig } from "../project/types";

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  cfg: VisualizerConfig;
  audio: AudioData;
  t: number; // seconds elapsed
  logo?: HTMLImageElement;
}

export interface Preset {
  id: string;
  name: string;
  category: string;
  draw: (d: DrawContext) => void;
}

const hexA = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

const setGlow = (ctx: CanvasRenderingContext2D, color: string, intensity: number) => {
  ctx.shadowColor = color;
  ctx.shadowBlur = 20 * intensity;
};

const center = (d: DrawContext) => ({
  cx: d.w / 2 + d.cfg.position.x * d.w / 2,
  cy: d.h / 2 + d.cfg.position.y * d.h / 2,
});

/**
 * Compute log-spaced averaged band levels (0..1) — gives a clean, accurate
 * equalizer instead of raw, noisy FFT bins. Default 12 bands covers sub-bass
 * through presence; `upper` clips the very top end where most music is silent.
 */
function bandMulFor(frac: number, cfg?: VisualizerConfig): number {
  const master = cfg?.sensitivity ?? 1;
  const bassMul = cfg?.bassSensitivity ?? 1;
  const midMul = cfg?.midSensitivity ?? 1;
  const trebMul = cfg?.trebleSensitivity ?? 1;
  const band = frac < 0.25 ? bassMul : frac < 0.6 ? midMul : trebMul;
  return master * band;
}

/** Sample a frequency bin (0..1) scaled by sensitivity config. */
function freqAt(freq: Uint8Array, idx: number, cfg?: VisualizerConfig): number {
  const i = Math.max(0, Math.min(freq.length - 1, idx | 0));
  return (freq[i] / 255) * bandMulFor(i / freq.length, cfg);
}

export function bandLevels(freq: Uint8Array, count = 12, upper = 0.7, cfg?: VisualizerConfig): number[] {
  const out = new Array(count);
  const lo = 2;
  const hi = Math.max(lo + count, Math.floor(freq.length * upper));
  const logLo = Math.log(lo), logHi = Math.log(hi);
  for (let i = 0; i < count; i++) {
    const a = Math.floor(Math.exp(logLo + (i / count) * (logHi - logLo)));
    const b = Math.max(a + 1, Math.floor(Math.exp(logLo + ((i + 1) / count) * (logHi - logLo))));
    let s = 0; for (let k = a; k < b; k++) s += freq[k];
    const tilt = 1 + (i / count) * 0.6;
    out[i] = Math.max(0, ((s / (b - a)) / 255) * tilt * bandMulFor(i / count, cfg));
  }
  return out;
}


// 1. Circular spectrum — log-spaced N-band equalizer wrapped in a ring.
const circular: Preset = {
  id: "circular-spectrum", name: "Circular Spectrum", category: "Circular",
  draw: ({ ctx, w, h, cfg, audio }) => {
    const { cx, cy } = center({ ctx, w, h, cfg, audio, t: 0 } as DrawContext);
    const react = cfg.reactivity ?? 1;
    const radius = Math.min(w, h) * 0.22 * cfg.size * (1 + audio.bass * 0.25 * react);
    const bars = Math.max(8, cfg.bandCount || 96);
    const levels = bandLevels(audio.freq, bars, 0.75, cfg);
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    ctx.lineWidth = cfg.thickness;
    for (let i = 0; i < bars; i++) {
      const v = levels[i];
      const len = (8 + v * 220 * react) * cfg.size;
      const a = (i / bars) * Math.PI * 2 + cfg.rotation;
      const x1 = cx + Math.cos(a) * radius;
      const y1 = cy + Math.sin(a) * radius;
      const x2 = cx + Math.cos(a) * (radius + len);
      const y2 = cy + Math.sin(a) * (radius + len);
      const g = ctx.createLinearGradient(x1, y1, x2, y2);
      g.addColorStop(0, cfg.primary);
      g.addColorStop(1, cfg.accent);
      ctx.strokeStyle = g;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.shadowBlur = 0;
  },
};

// 2. Double circular — inner + outer rings, each a full N-band EQ.
const doubleCircular: Preset = {
  id: "double-circular", name: "Double Circular", category: "Circular",
  draw: (d) => {
    circular.draw(d);
    const { ctx, w, h, cfg, audio } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const radius = Math.min(w, h) * 0.34 * cfg.size * (1 + audio.bass * 0.2 * react);
    const bars = Math.max(8, cfg.bandCount || 64);
    const levels = bandLevels(audio.freq, bars, 0.8, cfg);
    setGlow(ctx, cfg.secondary, cfg.glowIntensity * 0.8);
    ctx.lineWidth = cfg.thickness * 0.7;
    ctx.strokeStyle = cfg.secondary;
    for (let i = 0; i < bars; i++) {
      const v = levels[i];
      const len = (4 + v * 160 * react) * cfg.size;
      const a = -(i / bars) * Math.PI * 2 - cfg.rotation;
      const x1 = cx + Math.cos(a) * radius;
      const y1 = cy + Math.sin(a) * radius;
      const x2 = cx + Math.cos(a) * (radius + len);
      const y2 = cy + Math.sin(a) * (radius + len);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.shadowBlur = 0;
  },
};

// 3. Pulsing ring — heavy bass-driven breathing + beat kick.
const pulsingRing: Preset = {
  id: "pulsing-ring", name: "Pulsing Ring", category: "Circular",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const base = Math.min(d.w, d.h) * 0.22 * cfg.size;
    const beatKick = audio.beat ? 40 : 0;
    const r = base + (audio.bass * 200 + audio.volume * 60 + beatKick) * react * cfg.size;
    const wob = Math.sin(t * 4) * audio.mid * 18 * react;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * (1 + audio.bass * 1.5));
    ctx.lineWidth = cfg.thickness + audio.volume * 18 * react;
    ctx.strokeStyle = cfg.primary;
    ctx.beginPath(); ctx.arc(cx, cy, r + wob, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = cfg.thickness * 0.5;
    ctx.strokeStyle = hexA(cfg.accent, 0.6);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.25 + audio.mid * 90 * react, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = hexA(cfg.secondary, 0.4);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.55 + audio.treble * 70 * react, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
  },
};

// 4. Soft bass glow — radius and intensity react aggressively to bass + beat.
const bassGlow: Preset = {
  id: "bass-glow", name: "Soft Bass Glow", category: "Ambient",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const beatKick = audio.beat ? 0.25 : 0;
    const r = Math.min(d.w, d.h) * (0.22 + (audio.bass * 0.7 + audio.volume * 0.25 + beatKick) * react) * cfg.size;
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
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  },
};

// 6. Vertical EQ bars — clean 12-band log-spaced equalizer
const eqBars: Preset = {
  id: "eq-bars", name: "Equalizer Bars", category: "Bars",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const bars = Math.max(2, cfg.bandCount || 12);
    const levels = bandLevels(audio.freq, bars, 0.7, cfg);
    const slot = w / bars;
    const bw = slot * 0.7;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.6);
    for (let i = 0; i < bars; i++) {
      const v = levels[i];
      const bh = v * h * 0.7 * cfg.size;
      const g = ctx.createLinearGradient(0, h, 0, h - bh);
      g.addColorStop(0, cfg.primary); g.addColorStop(1, cfg.accent);
      ctx.fillStyle = g;
      ctx.fillRect(i * slot + (slot - bw) / 2, h - bh, bw, bh);
    }
    ctx.shadowBlur = 0;
  },
};

// 7. Mirrored bars — 12-band centered equalizer
const mirroredBars: Preset = {
  id: "mirrored-bars", name: "Mirrored Bars", category: "Bars",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const bars = Math.max(2, cfg.bandCount || 12);
    const levels = bandLevels(audio.freq, bars, 0.7, cfg);
    const mid = h / 2 + cfg.position.y * h / 2;
    const slot = w / bars;
    const bw = slot * 0.7;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.6);
    for (let i = 0; i < bars; i++) {
      const v = levels[i];
      const bh = v * h * 0.4 * cfg.size;
      const g = ctx.createLinearGradient(0, mid - bh, 0, mid + bh);
      g.addColorStop(0, cfg.accent); g.addColorStop(0.5, cfg.primary); g.addColorStop(1, cfg.accent);
      ctx.fillStyle = g;
      ctx.fillRect(i * slot + (slot - bw) / 2, mid - bh, bw, bh * 2);
    }
    ctx.shadowBlur = 0;
  },
};

// 8. Radial bars
const radialBars: Preset = {
  id: "radial-bars", name: "Radial Bars", category: "Circular",
  draw: (d) => {
    const { ctx, cfg, audio } = d;
    const { cx, cy } = center(d);
    const bars = Math.max(3, cfg.bandCount || 12); const radius = Math.min(d.w, d.h) * 0.15 * cfg.size;
    const levels = bandLevels(audio.freq, bars, 0.7, cfg);
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    ctx.lineWidth = cfg.thickness * 2.2; ctx.lineCap = "round";
    for (let i = 0; i < bars; i++) {
      const v = levels[i];
      const len = 20 + v * 220 * cfg.size;
      const a = (i / bars) * Math.PI * 2 + cfg.rotation;
      const x1 = cx + Math.cos(a) * radius, y1 = cy + Math.sin(a) * radius;
      const x2 = cx + Math.cos(a) * (radius + len), y2 = cy + Math.sin(a) * (radius + len);
      const g = ctx.createLinearGradient(x1, y1, x2, y2);
      g.addColorStop(0, cfg.primary); g.addColorStop(1, cfg.accent);
      ctx.strokeStyle = g;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.shadowBlur = 0; ctx.lineCap = "butt";
  },
};

// 9. Particle burst — handled by effects but here as preset
const particleBurst: Preset = {
  id: "particle-burst", name: "Particle Burst", category: "Particles",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const count = 60;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const dist = (50 + ((t * 40 + i * 9) % 300)) * (0.5 + audio.volume);
      const x = cx + Math.cos(a) * dist; const y = cy + Math.sin(a) * dist;
      const size = 2 + audio.bass * 6;
      ctx.fillStyle = hexA(i % 2 ? cfg.primary : cfg.accent, Math.max(0, 1 - dist / 350));
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    }
  },
};

// 10. Liquid blob — N-band perimeter, heavy bass swell, dual layer wobble.
const liquidBlob: Preset = {
  id: "liquid-blob", name: "Liquid Blob", category: "Morph",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const points = Math.max(24, cfg.bandCount || 80);
    const levels = bandLevels(audio.freq, points, 0.8, cfg);
    const beatKick = audio.beat ? 30 : 0;
    const base = Math.min(d.w, d.h) * 0.2 * cfg.size * (1 + audio.bass * 0.45 * react);
    const ox = Math.sin(t * 1.1) * audio.mid * 50 * react;
    const oy = Math.cos(t * 0.9) * audio.mid * 40 * react;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * (1 + audio.bass * 0.8));

    // Outer halo blob
    ctx.fillStyle = hexA(cfg.accent, 0.35);
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2 + cfg.rotation * 0.5;
      const v = levels[i % points];
      const r = base * 1.25 + (v * 180 + beatKick) * react * cfg.size
        + Math.sin(t * 1.7 + i * 0.4) * (14 + audio.treble * 40 * react);
      const x = cx + ox + Math.cos(a) * r;
      const y = cy + oy + Math.sin(a) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();

    // Core blob
    const g = ctx.createRadialGradient(cx + ox, cy + oy, base * 0.2, cx + ox, cy + oy, base * 1.4);
    g.addColorStop(0, hexA(cfg.primary, 0.9));
    g.addColorStop(1, hexA(cfg.accent, 0.4));
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2;
      const v = levels[i % points];
      const r = base + (v * 220 + beatKick * 1.4) * react * cfg.size
        + Math.sin(t * 3 + i * 0.7) * (10 + audio.mid * 30 * react)
        + Math.sin(t * 5.5 + i * 1.3) * audio.treble * 18 * react;
      const x = cx + ox + Math.cos(a) * r;
      const y = cy + oy + Math.sin(a) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
  },
};


// 11. Oscilloscope — uses primary→accent gradient, honors size + thickness.
const oscilloscope: Preset = {
  id: "oscilloscope", name: "Oscilloscope", category: "Wave",
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
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  },
};

// 12. Multi wave ribbons
const ribbons: Preset = {
  id: "ribbons", name: "Wave Ribbons", category: "Wave",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const layers = 5;
    for (let l = 0; l < layers; l++) {
      ctx.strokeStyle = hexA(l % 2 ? cfg.primary : cfg.accent, 0.4 + l * 0.1);
      ctx.lineWidth = cfg.thickness * (0.5 + l * 0.2);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const i = Math.floor((x / w) * audio.freq.length * 0.5);
        const v = freqAt(audio.freq, i, cfg);
        const y = h / 2 + Math.sin(x * 0.01 + t * (1 + l * 0.3)) * (40 + v * 80) * cfg.size + (l - layers / 2) * 18;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
};

// 13. Frequency tunnel — N-band log-spaced rings, bass-driven depth surge.
const tunnel: Preset = {
  id: "tunnel", name: "Frequency Tunnel", category: "3D",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const rings = 14;
    const verts = Math.max(24, cfg.bandCount || 60);
    const levels = bandLevels(audio.freq, verts, 0.85, cfg);
    const speed = 0.5 + audio.bass * 1.4 * react;
    for (let i = 0; i < rings; i++) {
      const p = ((i + (t * speed) % 1) / rings);
      const r = p * Math.min(d.w, d.h) * 0.7 * cfg.size * (1 + audio.bass * 0.25 * react);
      ctx.strokeStyle = hexA(i % 2 ? cfg.primary : cfg.accent, 1 - p);
      ctx.lineWidth = (1 - p) * cfg.thickness * 2;
      ctx.beginPath();
      for (let v = 0; v <= verts; v++) {
        const a = (v / verts) * Math.PI * 2 + cfg.rotation * p;
        const f = levels[v % verts];
        const rr = r + f * 80 * react * cfg.size * (1 - p * 0.5);
        const x = cx + Math.cos(a) * rr; const y = cy + Math.sin(a) * rr;
        v === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
    }
  },
};

// 14. Diamond frame
const diamond: Preset = {
  id: "diamond-frame", name: "Diamond Frame", category: "Shapes",
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
  draw: (d) => {
    const { ctx, cfg, audio } = d;
    const { cx, cy } = center(d);
    const r = Math.min(d.w, d.h) * 0.2 * cfg.size + audio.volume * 40;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 1.4);
    ctx.lineWidth = cfg.thickness + 2;
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, cfg.primary); g.addColorStop(1, cfg.accent);
    ctx.strokeStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
  },
};

// 16. Minimal bottom waveform — log-spaced bands, gradient fill + glow.
const bottomWave: Preset = {
  id: "bottom-wave", name: "Minimal Bottom Wave", category: "Wave",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const bars = Math.min(384, Math.max(8, (cfg.bandCount || 12) * 4));
    const levels = bandLevels(audio.freq, bars, 0.75, cfg);
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
    // Top stroke for definition; honors thickness.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = cfg.accent;
    ctx.lineWidth = Math.max(1, cfg.thickness * 0.8);
    ctx.beginPath();
    for (let i = 0; i < bars; i++) {
      const x = (i / (bars - 1)) * w;
      const v = levels[i];
      const y = baseY - v * 180 * cfg.size;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};

// 17. Ambient pulse — full-frame radial glow that breathes with bass + beat.
const ambient: Preset = {
  id: "ambient-pulse", name: "Ambient Pulse", category: "Ambient",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const beatKick = audio.beat ? 0.35 : 0;
    const pulse = 0.7 + (audio.bass * 0.6 + audio.volume * 0.3 + beatKick) * react;
    const radius = Math.max(w, h) * cfg.size * pulse;
    const ox = Math.sin(t * 0.6) * audio.mid * 100 * react;
    const oy = Math.cos(t * 0.45) * audio.mid * 80 * react;
    const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, radius);
    const intensity = 0.3 + (audio.volume * 0.8 + audio.bass * 0.5 + beatKick) * react;
    g.addColorStop(0, hexA(cfg.primary, Math.min(1, intensity)));
    g.addColorStop(0.4, hexA(cfg.accent, Math.min(1, intensity * 0.65)));
    g.addColorStop(0.75, hexA(cfg.secondary, Math.min(1, intensity * 0.3)));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  },
};

// 18. Floating orb — wide drifting motion, scale + glow surge with the music.
const floatingOrb: Preset = {
  id: "floating-orb", name: "Floating Orb", category: "Ambient",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const beatKick = audio.beat ? 50 : 0;
    // Drift amplitude scales with mids + treble — orb wanders across the frame.
    const driftX = Math.min(d.w, d.h) * 0.32 * (0.4 + audio.mid * 1.2 * react);
    const driftY = Math.min(d.w, d.h) * 0.22 * (0.4 + audio.treble * 1.2 * react);
    const x = cx + Math.sin(t * 1.1 + audio.volume * 2) * driftX
      + Math.sin(t * 2.7) * audio.treble * 40 * react;
    const y = cy + Math.cos(t * 0.85 + audio.bass * 2) * driftY
      + Math.cos(t * 3.1) * audio.treble * 30 * react;
    const r = (80 * cfg.size) + (audio.bass * 220 + audio.volume * 80 + beatKick) * react;

    setGlow(ctx, cfg.glow, cfg.glowIntensity * (1 + audio.bass * 1.2));
    // Trailing echo orb for motion smear.
    const tx = cx + Math.sin(t * 1.1 - 0.4 + audio.volume * 2) * driftX;
    const ty = cy + Math.cos(t * 0.85 - 0.4 + audio.bass * 2) * driftY;
    const tg = ctx.createRadialGradient(tx, ty, 0, tx, ty, r * 1.1);
    tg.addColorStop(0, hexA(cfg.accent, 0.35));
    tg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = tg; ctx.beginPath(); ctx.arc(tx, ty, r * 1.1, 0, Math.PI * 2); ctx.fill();

    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(cfg.primary, 0.95));
    g.addColorStop(0.35, hexA(cfg.accent, 0.6));
    g.addColorStop(0.75, hexA(cfg.secondary, 0.25));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  },
};

// 19. Snow particles preset
const snowField: Preset = {
  id: "snow-field", name: "Snow Field", category: "Particles",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const count = 120;
    for (let i = 0; i < count; i++) {
      const seed = i * 37.3;
      const x = ((seed * 91 + t * 30) % w + w) % w;
      const y = ((seed * 53 + t * 60 * (1 + audio.bass)) % h + h) % h;
      const r = 1 + (Math.sin(seed) + 1) * 2;
      ctx.fillStyle = hexA(cfg.primary, 0.5 + Math.sin(seed) * 0.3);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  },
};

// 20. Cinematic light wave
const lightWave: Preset = {
  id: "light-wave", name: "Cinematic Light Wave", category: "Wave",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    for (let l = 0; l < 3; l++) {
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, hexA(l === 0 ? cfg.primary : l === 1 ? cfg.accent : cfg.secondary, 0.6));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = cfg.thickness * (3 - l) + audio.volume * 10;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 5) {
        const v = freqAt(audio.freq, Math.floor((x / w) * audio.freq.length * 0.3), cfg);
        const y = h / 2 + Math.sin(x * 0.005 + t * 1.5 + l) * (60 + v * 100) + (l - 1) * 30;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
};

// 21. Rolling wave with bars perpendicular to the line
const rollingWave: Preset = {
  id: "rolling-wave", name: "Rolling Wave Bars", category: "Unconventional",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const bars = Math.max(8, cfg.bandCount || 12) * 4;
    const levels = bandLevels(audio.freq, bars, 0.75, cfg);
    const baseY = h / 2 + cfg.position.y * h / 2;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.7);
    ctx.lineCap = "round";
    for (let i = 0; i < bars; i++) {
      const px = (i / (bars - 1)) * w;
      const phase = (px * 0.012) - t * 2.2;
      const y = baseY + Math.sin(phase) * 80 * cfg.size + Math.sin(phase * 0.5) * 20;
      const slope = Math.cos(phase) * 0.012;
      const nx = -Math.sin(Math.atan(slope * 100));
      const ny = Math.cos(Math.atan(slope * 100));
      const len = 10 + levels[i] * 180 * cfg.size;
      const g = ctx.createLinearGradient(px, y, px + nx * len, y - ny * len);
      g.addColorStop(0, cfg.primary); g.addColorStop(1, cfg.accent);
      ctx.strokeStyle = g; ctx.lineWidth = cfg.thickness;
      ctx.beginPath();
      ctx.moveTo(px - nx * len * 0.3, y + ny * len * 0.3);
      ctx.lineTo(px + nx * len, y - ny * len);
      ctx.stroke();
    }
    ctx.lineCap = "butt"; ctx.shadowBlur = 0;
  },
};

// 22. Spiral bars expanding outward
const spiralBars: Preset = {
  id: "spiral-bars", name: "Spiral Bars", category: "Unconventional",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const bars = Math.max(40, (cfg.bandCount || 12) * 8);
    const levels = bandLevels(audio.freq, bars, 0.85, cfg);
    const turns = 4;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.6);
    ctx.lineCap = "round";
    for (let i = 0; i < bars; i++) {
      const p = i / bars;
      const a = p * Math.PI * 2 * turns + t * 0.6 + cfg.rotation;
      const r = 10 + p * Math.min(d.w, d.h) * 0.45 * cfg.size;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const len = 6 + levels[i] * 90 * cfg.size;
      const tx = Math.cos(a + Math.PI / 2), ty = Math.sin(a + Math.PI / 2);
      const hue = ctx.createLinearGradient(x, y, x + tx * len, y + ty * len);
      hue.addColorStop(0, hexA(cfg.primary, 0.9)); hue.addColorStop(1, hexA(cfg.accent, 0.5));
      ctx.strokeStyle = hue; ctx.lineWidth = cfg.thickness * (1 - p * 0.6);
      ctx.beginPath();
      ctx.moveTo(x - tx * len * 0.3, y - ty * len * 0.3);
      ctx.lineTo(x + tx * len, y + ty * len);
      ctx.stroke();
    }
    ctx.lineCap = "butt"; ctx.shadowBlur = 0;
  },
};

// 23. Recursive fractal tree
const fractalTree: Preset = {
  id: "fractal-tree", name: "Fractal Tree", category: "Unconventional",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const baseLen = Math.min(d.w, d.h) * 0.16 * cfg.size + audio.bass * 30;
    const sway = Math.sin(t * 1.2) * 0.15 + audio.mid * 0.3 * (cfg.reactivity ?? 1);
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.5);
    const branch = (x: number, y: number, len: number, ang: number, depth: number) => {
      if (depth === 0 || len < 2) return;
      const x2 = x + Math.cos(ang) * len;
      const y2 = y + Math.sin(ang) * len;
      const tcol = ctx.createLinearGradient(x, y, x2, y2);
      tcol.addColorStop(0, cfg.primary); tcol.addColorStop(1, cfg.accent);
      ctx.strokeStyle = tcol;
      ctx.lineWidth = Math.max(0.5, depth * 0.6 + cfg.thickness * 0.3);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      const next = len * 0.72;
      branch(x2, y2, next, ang - 0.45 - sway, depth - 1);
      branch(x2, y2, next, ang + 0.45 + sway, depth - 1);
    };
    const depth = 9;
    branch(cx, cy + baseLen, baseLen, -Math.PI / 2 + cfg.rotation, depth);
    branch(cx, cy + baseLen, baseLen * 0.7, -Math.PI / 2 + cfg.rotation + 0.6, depth - 2);
    branch(cx, cy + baseLen, baseLen * 0.7, -Math.PI / 2 + cfg.rotation - 0.6, depth - 2);
    ctx.shadowBlur = 0;
  },
};

// 24. Leaf/petal border that orbits the logo
const leafBorder: Preset = {
  id: "leaf-border", name: "Leaf Border", category: "Unconventional",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const leaves = Math.max(12, (cfg.bandCount || 12) * 2);
    const levels = bandLevels(audio.freq, leaves, 0.7, cfg);
    const baseR = Math.min(d.w, d.h) * (0.18 + cfg.logoSize * 0.3) * cfg.size;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.6);
    for (let i = 0; i < leaves; i++) {
      const a = (i / leaves) * Math.PI * 2 + t * 0.25 + cfg.rotation;
      const v = levels[i];
      const r = baseR + 6 + v * 70 * cfg.size;
      const lw = 14 + v * 40;
      const ll = 38 + v * 80;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(a + Math.PI / 2);
      const g = ctx.createLinearGradient(0, -ll / 2, 0, ll / 2);
      g.addColorStop(0, hexA(cfg.accent, 0.95)); g.addColorStop(1, hexA(cfg.primary, 0.6));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -ll / 2);
      ctx.quadraticCurveTo(lw / 2, 0, 0, ll / 2);
      ctx.quadraticCurveTo(-lw / 2, 0, 0, -ll / 2);
      ctx.fill();
      // mid vein
      ctx.strokeStyle = hexA(cfg.glow, 0.6); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -ll / 2); ctx.lineTo(0, ll / 2); ctx.stroke();
      ctx.restore();
    }
    ctx.shadowBlur = 0;
  },
};

// 25. Lissajous knot — figure-eight orbital pattern, audio-bent
const lissajous: Preset = {
  id: "lissajous", name: "Lissajous Knot", category: "Unconventional",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const R = Math.min(d.w, d.h) * 0.32 * cfg.size;
    const steps = 360;
    const a = 3 + Math.floor(audio.bass * 3);
    const b = 2 + Math.floor(audio.mid * 4);
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    g.addColorStop(0, cfg.primary); g.addColorStop(1, cfg.accent);
    ctx.strokeStyle = g; ctx.lineWidth = cfg.thickness;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const u = (i / steps) * Math.PI * 2;
      const wob = 1 + audio.volume * 0.4 * (cfg.reactivity ?? 1);
      const x = cx + Math.sin(a * u + t) * R * wob;
      const y = cy + Math.sin(b * u + t * 0.7) * R * wob * 0.75;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  },
};

// ============================================================
// ORGANIC MOTION presets — inspired by natural flow:
// fluid currents, aurora veils, swarming murmurations, tidal
// blooms, silk strands. Each one layers many frequency bands
// at different temporal scales so the movement breathes instead
// of snapping in lockstep with a single amplitude value.
// ============================================================

// Cheap, deterministic 2D pseudo-noise (no allocations).
// Smooth interpolation across an implicit lattice — good enough for
// flow-field directions without pulling in a real perlin lib.
function noise2(x: number, y: number): number {
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

// 26. Fluid Flow — layered flowing curves driven by a noise field +
// the full spectrum. Bass slows + thickens the field, treble adds
// shimmer to high-frequency lines. Reads like wind on water.
const fluidFlow: Preset = {
  id: "fluid-flow", name: "Fluid Flow", category: "Organic",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const lines = 18;
    const step = 18;

    const react = cfg.reactivity ?? 1;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.6);
    ctx.lineCap = "round";
    for (let l = 0; l < lines; l++) {
      const p = l / (lines - 1);
      const band = freqAt(audio.freq, Math.floor(p * audio.freq.length * 0.55), cfg);
      const amp = (30 + band * 220 + audio.volume * 40) * cfg.size * react;
      const baseY = h * (0.15 + p * 0.7);
      const tt = t * (0.35 + p * 0.4) + audio.bass * 0.6;
      const col = l % 3 === 0 ? cfg.primary : l % 3 === 1 ? cfg.accent : cfg.secondary;
      ctx.strokeStyle = hexA(col, 0.35 + band * 0.55);
      ctx.lineWidth = (cfg.thickness * 0.6) + band * cfg.thickness * 1.5;
      ctx.beginPath();
      for (let x = 0; x <= w; x += step) {
        const nx = x * 0.0035;
        const n1 = noise2(nx + tt * 0.5, p * 3.7 + tt * 0.2) - 0.5;
        const n2 = noise2(nx * 3 + tt * 1.2, p * 7.1) - 0.5;
        const y = baseY + n1 * amp + n2 * amp * 0.35 + Math.sin(x * 0.01 + tt * 1.7) * 8;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.lineCap = "butt"; ctx.shadowBlur = 0;
  },
};

// 27. Aurora Veil — flowing curtains of light, each mapped to a different
// frequency slice. Mids = waver, treble = shimmer, bass = breadth.
const auroraVeil: Preset = {
  id: "aurora-veil", name: "Aurora Veil", category: "Organic",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const curtains = 6;
    const react = cfg.reactivity ?? 1;
    ctx.globalCompositeOperation = "lighter";
    for (let c = 0; c < curtains; c++) {
      const p = c / (curtains - 1);
      const band = freqAt(audio.freq, Math.floor((0.05 + p * 0.55) * audio.freq.length), cfg);
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
    ctx.globalCompositeOperation = "source-over";
  },
};

// 28. Murmuration — swarming particles flowing through a noise vector field.
// Particle positions are precomputed (deterministic) so we don't re-hash each
// frame, and we skip per-particle shadowBlur which would tank Safari/WebKit.
const murmurationSeeds: { hx: number; hy: number }[] = [];
function ensureMurmurationSeeds(count: number, w: number, h: number) {
  if (murmurationSeeds.length === count && murmurationSeeds[0]?.hx <= w) return;
  murmurationSeeds.length = 0;
  for (let i = 0; i < count; i++) {
    const seed = i * 0.6180339;
    murmurationSeeds.push({
      hx: ((seed * 53.13) % 1) * w,
      hy: ((seed * 71.71) % 1) * h,
    });
  }
}
const murmuration: Preset = {
  id: "murmuration", name: "Murmuration", category: "Organic",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const count = 140;
    ensureMurmurationSeeds(count, w, h);
    const react = cfg.reactivity ?? 1;
    const kick = audio.beat ? 1.6 : 1;
    // No shadowBlur here — 140 shadowed arcs/frame crashes Safari.
    ctx.shadowBlur = 0;
    for (let i = 0; i < count; i++) {
      const { hx, hy } = murmurationSeeds[i];
      const nx = hx * 0.005 + t * 0.25;
      const ny = hy * 0.005 + t * 0.3;
      const ang = noise2(nx, ny) * Math.PI * 4 + t * 0.4;
      const radius = (40 + audio.volume * 160 + audio.bass * 90) * cfg.size * react * kick;
      const px = hx + Math.cos(ang) * radius;
      const py = hy + Math.sin(ang) * radius * 0.85;
      const band = freqAt(audio.freq, (i * 3) % audio.freq.length, cfg);
      const r = 1 + band * 4 + (audio.beat ? 1.5 : 0);
      const col = i % 3 === 0 ? cfg.primary : i % 3 === 1 ? cfg.accent : cfg.secondary;
      ctx.fillStyle = hexA(col, 0.4 + band * 0.6);
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
  },
};


// 29. Tidal Bloom — concentric pond-ripples, continuously emitted.
const tidalBloom: Preset = {
  id: "tidal-bloom", name: "Tidal Bloom", category: "Organic",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = cfg.reactivity ?? 1;
    const ringCount = 18;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.7);
    for (let i = 0; i < ringCount; i++) {
      const cycle = 2.2;
      const localT = ((t + (i / ringCount) * cycle) % cycle) / cycle;
      const r = localT * Math.min(d.w, d.h) * 0.55 * cfg.size * (1 + audio.bass * 0.4 * react);
      const fade = 1 - localT;
      ctx.strokeStyle = hexA(i % 2 ? cfg.primary : cfg.accent, fade * (0.55 + audio.volume * 0.4));
      ctx.lineWidth = cfg.thickness * (0.4 + fade * 1.4);
      ctx.beginPath();
      const segs = 80;
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const band = freqAt(audio.freq, Math.floor(((s / segs) * 0.5) * audio.freq.length), cfg);
        const wob = Math.sin(a * 6 + t * 2 + i) * (4 + audio.mid * 24) +
                    Math.sin(a * 14 - t * 3) * (audio.treble * 16);
        const rr = r + wob + band * 30 * fade;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
    }
    ctx.shadowBlur = 0;
  },
};

// 30. Silk Strands — many thin strands at different frequencies and phases.
const silkStrands: Preset = {
  id: "silk-strands", name: "Silk Strands", category: "Organic",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const strands = 22;
    const react = cfg.reactivity ?? 1;
    const levels = bandLevels(audio.freq, strands, 0.8, cfg);
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.5);
    for (let s = 0; s < strands; s++) {
      const p = s / (strands - 1);
      const v = levels[s];
      const freq = 0.6 + p * 3.4;
      const phase = t * freq + p * 6.28;
      const amp = (18 + v * 140 + audio.volume * 30) * cfg.size * react;
      const cyBase = h * (0.5 + Math.sin(p * 3.1 + t * 0.3) * 0.06);
      const col = s % 3 === 0 ? cfg.primary : s % 3 === 1 ? cfg.accent : cfg.secondary;
      ctx.strokeStyle = hexA(col, 0.3 + v * 0.6);
      ctx.lineWidth = (cfg.thickness * 0.4) + v * cfg.thickness;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const y = cyBase
          + Math.sin(x * 0.008 + phase) * amp
          + Math.sin(x * 0.025 + phase * 1.7) * amp * 0.3
          + (p - 0.5) * 220 * cfg.size;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  },
};

// ============================================================
// CUSTOM EQUALIZER — driven entirely by cfg.custom so users can
// dial in shape/count/spacing/etc. without writing code. Same
// draw fn runs in the live canvas AND the Lambda render, so the
// output is guaranteed identical.
// ============================================================
const customEqualizer: Preset = {
  id: "custom-equalizer", name: "Custom Equalizer", category: "Custom",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const c = cfg.custom;
    const count = Math.max(3, Math.min(256, c.count | 0));
    const levels = bandLevels(audio.freq, count, 0.75, cfg);
    const react = c.reactivity * (cfg.reactivity ?? 1);
    const stroke = c.thickness > 0 ? c.thickness : cfg.thickness;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * 0.7);
    ctx.lineCap = c.rounded ? "round" : "butt";

    const grad = (x1: number, y1: number, x2: number, y2: number) => {
      const g = ctx.createLinearGradient(x1, y1, x2, y2);
      g.addColorStop(0, cfg.primary);
      g.addColorStop(0.5, cfg.accent);
      g.addColorStop(1, cfg.secondary);
      return g;
    };

    // Symmetric mode mirrors the spectrum around the center so the same
    // bands appear on both sides (bass in the middle, treble fanning out).
    // The old implementation multiplied amplitude by |i - mid|/mid, which
    // forced the center bars (the mid-frequency range) to zero — that's
    // what caused the AI-generated wave preset to look like a V with no
    // vocals or snare visible. Mirroring the *index* fixes it without
    // suppressing any frequency band.
    const bandIndex = (i: number) => {
      if (!c.symmetric) return i;
      const half = count / 2;
      return i < half ? Math.floor(half - 1 - i) : Math.floor(i - half);
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
          ctx.fillStyle = grad(x, baseY, x, y);
          ctx.beginPath();
          if (c.rounded) ctx.roundRect(x, Math.min(y, baseY), bw, Math.abs(baseY - y), bw / 2);
          else ctx.rect(x, Math.min(y, baseY), bw, Math.abs(baseY - y));
          ctx.fill();
        } else if (c.shape === "mirrored") {
          const bh = v * h * 0.4 * cfg.size;
          ctx.fillStyle = grad(x, mid - bh, x, mid + bh);
          ctx.beginPath();
          if (c.rounded) ctx.roundRect(x, mid - bh, bw, bh * 2, bw / 2);
          else ctx.rect(x, mid - bh, bw, bh * 2);
          ctx.fill();
        } else {
          const bh = v * h * 0.75 * cfg.size;
          ctx.fillStyle = grad(x, h, x, h - bh);
          ctx.beginPath();
          if (c.rounded) ctx.roundRect(x, h - bh, bw, bh, bw / 2);
          else ctx.rect(x, h - bh, bw, bh);
          ctx.fill();
        }
      }
    } else if (c.shape === "radial" || c.shape === "ring") {
      const cx = w / 2 + cfg.position.x * w / 2;
      const cy = h / 2 + cfg.position.y * h / 2;
      const baseR = Math.min(w, h) * c.innerRadius * cfg.size;
      ctx.lineWidth = Math.max(1, stroke * 1.4);
      for (let i = 0; i < count; i++) {
        const v = levels[bandIndex(i)] * c.amplitude * react;
        const a = (i / count) * Math.PI * 2 + cfg.rotation;
        if (c.shape === "ring") {
          const r = baseR + v * Math.min(w, h) * 0.25 * cfg.size;
          ctx.strokeStyle = grad(cx, cy - r, cx, cy + r);
          ctx.beginPath();
          const next = ((i + 1) / count) * Math.PI * 2 + cfg.rotation;
          ctx.arc(cx, cy, r, a, next);
          ctx.stroke();
        } else {
          const len = 20 + v * Math.min(w, h) * 0.3 * cfg.size;
          const x1 = cx + Math.cos(a) * baseR;
          const y1 = cy + Math.sin(a) * baseR;
          const x2 = cx + Math.cos(a) * (baseR + len);
          const y2 = cy + Math.sin(a) * (baseR + len);
          ctx.strokeStyle = grad(x1, y1, x2, y2);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
      }
    } else if (c.shape === "dots") {
      const cx = w / 2 + cfg.position.x * w / 2;
      const cy = h / 2 + cfg.position.y * h / 2;
      const baseR = Math.min(w, h) * c.innerRadius * cfg.size;
      for (let i = 0; i < count; i++) {
        const v = levels[bandIndex(i)] * c.amplitude * react;
        const a = (i / count) * Math.PI * 2 + cfg.rotation;
        const r = baseR + v * Math.min(w, h) * 0.25 * cfg.size;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        const dotR = Math.max(1, stroke) + v * 12;
        ctx.fillStyle = hexA(i % 2 ? cfg.primary : cfg.accent, 0.6 + v * 0.4);
        ctx.beginPath(); ctx.arc(x, y, dotR, 0, Math.PI * 2); ctx.fill();
      }
    } else if (c.shape === "triangles") {
      const slot = w / count;
      const bw = Math.max(2, slot * (1 - c.spacing));
      const baseY = h - 40;
      for (let i = 0; i < count; i++) {
        const v = levels[bandIndex(i)] * c.amplitude * react;
        const x = i * slot + slot / 2;
        const peak = baseY - v * h * 0.7 * cfg.size;
        ctx.fillStyle = grad(x, baseY, x, peak);
        ctx.beginPath();
        ctx.moveTo(x - bw / 2, baseY);
        ctx.lineTo(x + bw / 2, baseY);
        ctx.lineTo(x, peak);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.shadowBlur = 0; ctx.lineCap = "butt";
  },
};

// 31. Noodle Equalizer — each frequency band is a long curved ribbon that
// undulates with sine-wave distortion. Amplitude bends the wave; the curve
// itself never snaps up and down like a bar. Warm pasta/wheat palette is
// applied per-strand so it reads as "noodles" regardless of cfg colors.
const PASTA_TONES = [
  "#e8c98a", // wheat
  "#d9a86c", // toasted pasta
  "#c98a4a", // bronze crust
  "#f0d9a0", // semolina
  "#b87333", // amber
  "#e0b074", // golden
];
const noodleEqualizer: Preset = {
  id: "noodle-equalizer", name: "Noodle Equalizer", category: "Organic",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const strands = Math.max(6, Math.min(24, cfg.bandCount || 12));
    const levels = bandLevels(audio.freq, strands, 0.8, cfg);
    const react = cfg.reactivity ?? 1;
    const baseY = h / 2 + cfg.position.y * h / 2;
    const bandSpacing = (h * 0.55 * cfg.size) / strands;

    setGlow(ctx, "#caa472", cfg.glowIntensity * 0.55);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let s = 0; s < strands; s++) {
      const p = s / Math.max(1, strands - 1);
      const v = levels[s] * react;

      // Each strand has its own slow phase + frequency so they drift out of
      // sync, like noodles swirling in a pot rather than parallel bars.
      const freq1 = 0.6 + p * 1.8;
      const freq2 = 1.4 + p * 2.6;
      const phase = t * (0.5 + p * 0.7) + p * 6.28;

      // Amplitude is driven by the band level + a tiny constant so the
      // noodle is always slightly wavy even in silence.
      const amp = (12 + v * 90 + audio.volume * 18) * cfg.size;

      // Vertical center for this strand — gently breathing up/down so the
      // whole tangle feels alive.
      const cy = baseY + (p - 0.5) * bandSpacing * strands * 0.6
                       + Math.sin(t * 0.4 + p * 2.3) * 6;

      const color = PASTA_TONES[s % PASTA_TONES.length];
      const next = PASTA_TONES[(s + 2) % PASTA_TONES.length];
      const g = ctx.createLinearGradient(0, cy - amp, w, cy + amp);
      g.addColorStop(0, hexA(color, 0.55 + v * 0.4));
      g.addColorStop(1, hexA(next, 0.55 + v * 0.4));
      ctx.strokeStyle = g;
      ctx.lineWidth = (cfg.thickness * 0.6) + 2 + v * cfg.thickness * 1.4;

      // Build the noodle as a quadratic-smoothed polyline. Two sine layers
      // at different frequencies make the curl feel organic; the third
      // term adds a subtle frequency-driven bulge so the noodle "pulses"
      // along its length.
      ctx.beginPath();
      const step = 12;
      for (let x = 0; x <= w; x += step) {
        const u = x / w;
        const wave1 = Math.sin(u * Math.PI * 2 * freq1 + phase) * amp;
        const wave2 = Math.sin(u * Math.PI * 2 * freq2 - phase * 1.3) * amp * 0.35;
        const bulge = Math.sin(u * Math.PI + phase * 0.5) * v * 24 * cfg.size;
        // Soft envelope so noodles taper at the screen edges instead of
        // hitting the wall flat.
        const env = Math.sin(u * Math.PI);
        const y = cy + (wave1 + wave2 + bulge) * env;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    ctx.shadowBlur = 0;
  },
};

export const PRESETS: Preset[] = [
  circular, doubleCircular, pulsingRing, bassGlow, waveform, eqBars, mirroredBars,
  radialBars, particleBurst, liquidBlob, oscilloscope, ribbons, tunnel, diamond,
  logoOutline, bottomWave, ambient, floatingOrb, snowField, lightWave,
  rollingWave, spiralBars, fractalTree, leafBorder, lissajous,
  // Organic motion — natural flow, layered movement across the spectrum
  fluidFlow, auroraVeil, murmuration, tidalBloom, silkStrands, noodleEqualizer,
  // User-tunable preset (Custom Builder + AI Generator write to cfg.custom)
  customEqualizer,
];

export const getPreset = (id: string) => PRESETS.find(p => p.id === id) || PRESETS[0];
