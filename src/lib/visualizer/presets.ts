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


// 1. Circular spectrum
const circular: Preset = {
  id: "circular-spectrum", name: "Circular Spectrum", category: "Circular",
  draw: ({ ctx, w, h, cfg, audio }) => {
    const { cx, cy } = center({ ctx, w, h, cfg, audio, t: 0 } as DrawContext);
    const radius = Math.min(w, h) * 0.22 * cfg.size;
    const bars = 96;
    const freq = audio.freq;
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    ctx.lineWidth = cfg.thickness;
    for (let i = 0; i < bars; i++) {
      const v = freqAt(freq, Math.floor((i / bars) * freq.length * 0.6), cfg);
      const len = v * 120 * cfg.size + 4;
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

// 2. Double circular
const doubleCircular: Preset = {
  id: "double-circular", name: "Double Circular", category: "Circular",
  draw: (d) => {
    circular.draw(d);
    const { ctx, w, h, cfg, audio } = d;
    const { cx, cy } = center(d);
    const radius = Math.min(w, h) * 0.34 * cfg.size;
    const bars = 64;
    setGlow(ctx, cfg.secondary, cfg.glowIntensity * 0.8);
    ctx.lineWidth = cfg.thickness * 0.7;
    ctx.strokeStyle = cfg.secondary;
    for (let i = 0; i < bars; i++) {
      const v = freqAt(audio.freq, Math.floor((i / bars) * audio.freq.length * 0.5), cfg);
      const len = v * 80 * cfg.size + 2;
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

// 3. Pulsing ring
const pulsingRing: Preset = {
  id: "pulsing-ring", name: "Pulsing Ring", category: "Circular",
  draw: (d) => {
    const { ctx, cfg, audio } = d;
    const { cx, cy } = center(d);
    const base = Math.min(d.w, d.h) * 0.22 * cfg.size;
    const r = base + audio.bass * 80 * cfg.size;
    setGlow(ctx, cfg.glow, cfg.glowIntensity * (1 + audio.bass));
    ctx.lineWidth = cfg.thickness + audio.volume * 8;
    ctx.strokeStyle = cfg.primary;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = cfg.thickness * 0.5;
    ctx.strokeStyle = hexA(cfg.accent, 0.6);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.2 + audio.mid * 30, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
  },
};

// 4. Soft bass glow
const bassGlow: Preset = {
  id: "bass-glow", name: "Soft Bass Glow", category: "Ambient",
  draw: (d) => {
    const { ctx, cfg, audio } = d;
    const { cx, cy } = center(d);
    const r = Math.min(d.w, d.h) * (0.25 + audio.bass * 0.3) * cfg.size;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, hexA(cfg.primary, 0.6 * cfg.glowIntensity));
    g.addColorStop(0.6, hexA(cfg.accent, 0.2 * cfg.glowIntensity));
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

// 10. Liquid blob
const liquidBlob: Preset = {
  id: "liquid-blob", name: "Liquid Blob", category: "Morph",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const base = Math.min(d.w, d.h) * 0.2 * cfg.size;
    const points = 80;
    setGlow(ctx, cfg.glow, cfg.glowIntensity);
    ctx.fillStyle = hexA(cfg.primary, 0.7);
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2;
      const v = freqAt(audio.freq, Math.floor((i / points) * audio.freq.length * 0.4), cfg);
      const r = base + v * 60 + Math.sin(t * 2 + i * 0.3) * 12;
      const x = cx + Math.cos(a) * r; const y = cy + Math.sin(a) * r;
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

// 13. Frequency tunnel
const tunnel: Preset = {
  id: "tunnel", name: "Frequency Tunnel", category: "3D",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const rings = 14;
    for (let i = 0; i < rings; i++) {
      const p = ((i + (t * 0.5) % 1) / rings);
      const r = p * Math.min(d.w, d.h) * 0.7 * cfg.size;
      ctx.strokeStyle = hexA(i % 2 ? cfg.primary : cfg.accent, 1 - p);
      ctx.lineWidth = (1 - p) * cfg.thickness * 2;
      ctx.beginPath();
      const verts = 60;
      for (let v = 0; v <= verts; v++) {
        const a = (v / verts) * Math.PI * 2;
        const f = freqAt(audio.freq, (v * 4) % audio.freq.length, cfg);
        const rr = r + f * 30;
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

// 16. Minimal bottom waveform
const bottomWave: Preset = {
  id: "bottom-wave", name: "Minimal Bottom Wave", category: "Wave",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const baseY = h - 60;
    ctx.fillStyle = hexA(cfg.primary, 0.85);
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) {
      const i = Math.floor((x / w) * audio.freq.length * 0.5);
      const v = freqAt(audio.freq, i, cfg);
      const y = baseY - v * 90 * cfg.size;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  },
};

// 17. Ambient pulse
const ambient: Preset = {
  id: "ambient-pulse", name: "Ambient Pulse", category: "Ambient",
  draw: (d) => {
    const { ctx, w, h, cfg, audio } = d;
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h));
    g.addColorStop(0, hexA(cfg.primary, 0.25 + audio.volume * 0.4));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  },
};

// 18. Floating orb
const floatingOrb: Preset = {
  id: "floating-orb", name: "Floating Orb", category: "Ambient",
  draw: (d) => {
    const { ctx, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const x = cx + Math.sin(t * 0.7) * 80;
    const y = cy + Math.cos(t * 0.5) * 50;
    const r = 80 * cfg.size + audio.bass * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(cfg.primary, 0.9));
    g.addColorStop(0.4, hexA(cfg.accent, 0.5));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
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

export const PRESETS: Preset[] = [
  circular, doubleCircular, pulsingRing, bassGlow, waveform, eqBars, mirroredBars,
  radialBars, particleBurst, liquidBlob, oscilloscope, ribbons, tunnel, diamond,
  logoOutline, bottomWave, ambient, floatingOrb, snowField, lightWave,
  rollingWave, spiralBars, fractalTree, leafBorder, lissajous,
  // Organic motion — natural flow, layered movement across the spectrum
  fluidFlow, auroraVeil, murmuration, tidalBloom, silkStrands,
];

export const getPreset = (id: string) => PRESETS.find(p => p.id === id) || PRESETS[0];
