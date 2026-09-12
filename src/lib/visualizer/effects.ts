// Effects layer: particles, atmosphere and beat-reactive overlays drawn on
// top of the visualizer by the shared pipeline (render-shared.ts).
//
// Everything here is a pure function of (t, audio, effects). The Lambda
// render splits a song into independent chunks, so nothing may depend on
// Math.random, Date or frame-to-frame state — per-particle variation comes
// from deterministic hashes and value noise instead.
//
// Cost discipline (Lambda rasterises on the CPU): no per-primitive shadowBlur,
// no per-particle gradients. Glows are cached radial sprites stamped with
// drawImage; the only blur pass is the single withGlowLayer() around ripples.

import type { DrawContext } from "./presets";
import type { EffectsConfig, ParticlesConfig } from "../project/types";
import {
  TAU, clamp01, lerp, smoothstep, hexA, hexRGB, mixHex, hash1, noise2, fbm2, center,
  withGlowLayer, getGlowSprite, stampGlow,
  kickOf, snareOf, hatOf, energyOf, kickAgeOf, snareAgeOf, decayFromAge,
} from "./draw-utils";

// Deterministic pseudo-random per index — keeps look stable across re-renders
const rand = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
/** Blend two hex colours → "#rrggbb" (the sprite cache keys on hex strings). */
const mixToHex = (a: string, b: string, t: number) => {
  const A = hexRGB(a), B = hexRGB(b), k = clamp01(t);
  return `#${hex2(lerp(A.r, B.r, k))}${hex2(lerp(A.g, B.g, k))}${hex2(lerp(A.b, B.b, k))}`;
};

type Particle = {
  bx: number; by: number;      // base position (0-1)
  vx: number; vy: number;      // velocity (px/sec at speed=1, signed)
  size: number;                // size multiplier
  rot: number;                 // rotation phase
  rotSpeed: number;
  driftAmp: number;            // horizontal sway amplitude
  driftFreq: number;
  shape: number;               // 0-3 for snowflake variants
  alpha: number;
  hueShift: number;
  phaseOffset: number;         // per-particle phase offset (0-1) — desyncs wrapping
  twinkleFreq: number;
  twinklePhase: number;
};

// Cache particle pools so changing density/speed doesn't reshuffle existing ones
const pools = new Map<string, Particle[]>();
function getPool(type: string, count: number): Particle[] {
  let pool = pools.get(type);
  if (!pool) { pool = []; pools.set(type, pool); }
  while (pool.length < count) {
    const i = pool.length;
    // Wider, signed velocity ranges and a per-particle phase offset so
    // particles don't all wrap the screen at the same moment.
    pool.push({
      bx: rand(i, 1),
      by: rand(i, 2),
      vx: (rand(i, 3) - 0.5) * 2.0,           // -1..1
      vy: (rand(i, 4) - 0.5) * 2.0 + 0.2,     // mostly down for snow, signed for others
      size: 0.4 + rand(i, 5) * 1.8,
      rot: rand(i, 6) * Math.PI * 2,
      rotSpeed: (rand(i, 7) - 0.5) * 1.2,
      driftAmp: 0.02 + rand(i, 8) * 0.08,
      driftFreq: 0.3 + rand(i, 9) * 1.5,
      shape: Math.floor(rand(i, 10) * 4),
      alpha: 0.5 + rand(i, 11) * 0.5,
      hueShift: (rand(i, 12) - 0.5) * 40,
      phaseOffset: rand(i, 13),
      twinkleFreq: 1 + rand(i, 14) * 4,
      twinklePhase: rand(i, 15) * Math.PI * 2,
    });
  }
  return pool;
}

// Wrap a value into [0, range) without snapping the whole field at once —
// each particle gets its own phaseOffset added before the modulo.
const wrap = (v: number, range: number) => ((v % range) + range) % range;

// 256×256 monochrome noise tile, generated once from the deterministic hash.
let noiseTile: HTMLCanvasElement | null = null;
function getNoiseTile(): HTMLCanvasElement | null {
  if (noiseTile) return noiseTile;
  if (typeof document === "undefined") return null;
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const cx = c.getContext("2d");
  if (!cx) return null;
  const img = cx.createImageData(size, size);
  const data = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = rand(i, 77) > 0.5 ? 255 : 0;
    const a = rand(i, 78) > 0.6 ? 255 : 0; // ~40% of pixels carry grain
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = a;
  }
  cx.putImageData(img, 0, 0);
  noiseTile = c;
  return c;
}

// 128×128 fbm-shaped fog puff, tinted in the fog colour and radially masked so
// it has no visible edge when scaled up to frame size. One per colour.
const fogSprites = new Map<string, HTMLCanvasElement>();
function getFogSprite(color: string): HTMLCanvasElement | null {
  const cached = fogSprites.get(color);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const cx = c.getContext("2d");
  if (!cx) return null;
  const img = cx.createImageData(size, size);
  const data = img.data;
  const { r, g, b } = hexRGB(color);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size, ny = y / size;
      const n = fbm2(nx * 3.3 + 17.3, ny * 3.3 + 5.1);
      const dx = nx - 0.5, dy = ny - 0.5;
      const mask = clamp01(1 - (dx * dx + dy * dy) * 4.2);
      const a = clamp01((n - 0.22) * 1.7) * mask * mask;
      const o = (y * size + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = Math.round(a * 255);
    }
  }
  cx.putImageData(img, 0, 0);
  if (fogSprites.size >= 6) {
    const first = fogSprites.keys().next().value;
    if (first) fogSprites.delete(first);
  }
  fogSprites.set(color, c);
  return c;
}

function drawSnowflake(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, rot: number, shape: number, color: string, alpha: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5, size * 0.18);
  ctx.lineCap = "round";

  if (shape === 0) {
    for (let i = 0; i < 6; i++) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -size * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -size * 1.2);
      ctx.lineTo(size * 0.5, -size * 1.6);
      ctx.moveTo(0, -size * 1.2);
      ctx.lineTo(-size * 0.5, -size * 1.6);
      ctx.stroke();
    }
  } else if (shape === 1) {
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === 2) {
    ctx.beginPath();
    ctx.moveTo(0, -size * 2);
    ctx.lineTo(size * 0.4, 0);
    ctx.lineTo(0, size * 2);
    ctx.lineTo(-size * 0.4, 0);
    ctx.closePath();
    ctx.fill();
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -size * 1.4);
    ctx.lineTo(size * 0.3, 0);
    ctx.lineTo(0, size * 1.4);
    ctx.lineTo(-size * 0.3, 0);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const px = Math.cos(a) * size;
      const py = Math.sin(a) * size;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ─── Particles ───────────────────────────────────────────────────────────

function drawParticles(d: DrawContext, P: ParticlesConfig) {
  const { ctx, w, h, audio, t } = d;
  const count = Math.max(0, Math.min(200, Math.round(P.density)));
  if (count <= 0) return;
  const type = P.type;
  const pool = getPool(type, count);
  const baseColor = P.color;
  const rgb = hexRGB(baseColor);
  const opacity = clamp01(P.opacity);
  const speed = Math.max(0, P.speed);
  const sizeMul = Math.max(0.05, P.size ?? 1);
  const jitter = clamp01(P.jitter ?? 0.3);
  const burst = Math.max(0, P.burst ?? 0);
  const trigger = P.trigger ?? "volume";
  const drive = clamp01(
    trigger === "kick" ? kickOf(audio)
      : trigger === "snare" ? snareOf(audio)
        : trigger === "hat" ? hatOf(audio)
          : audio.volume,
  );
  // Reactivity used to multiply the integrated velocity (t * v * speed), so
  // any change in loudness teleported every particle by t·Δv. It is now a
  // bounded surge along the travel direction that eases back as the trigger
  // envelope decays — deterministic and identical in every render chunk.
  const surge = drive * Math.max(0, P.reactivity);
  const burstDrive = burst * drive;
  // 1 at burst=0; 0.7 + 0.3*drive once burst >= 1.
  const alphaMod = 1 - Math.min(1, burst) * 0.3 * (1 - drive);
  const burstSize = (i: number) => 1 + burstDrive * (0.5 + hash1(i, 9));
  const jitterGain = jitter * (1 + surge * 0.5);
  // Per-particle wander from value noise: smooth, seedable, allocation-free.
  const jitX = (i: number, p: Particle, rate: number) =>
    jitter > 0 ? (noise2(t * rate * (0.6 + p.driftFreq * 0.5) + i * 7.31, i * 3.17) - 0.5) * 2 * jitterGain : 0;
  const jitY = (i: number, p: Particle, rate: number) =>
    jitter > 0 ? (noise2(i * 5.13, t * rate * (0.6 + p.driftFreq * 0.5) + i * 2.71) - 0.5) * 2 * jitterGain : 0;

  const additive = type === "sparks" || type === "bokeh" || type === "lights" || type === "embers" || type === "stars";
  ctx.save();
  ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;

  // ───────────────────────────────────────────────────────────────
  // SNOW — gentle downward fall with horizontal sway
  // ───────────────────────────────────────────────────────────────
  if (type === "snow") {
    const fallRange = h + 80;
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const fallSpeed = (40 + Math.abs(p.vy) * 60) * speed;
      const y = wrap(p.by * fallRange + p.phaseOffset * fallRange + t * fallSpeed + surge * 40 + jitY(i, p, 0.3) * 30, fallRange) - 40;
      const sway = Math.sin(t * p.driftFreq + p.rot) * p.driftAmp * w;
      const x = wrap(p.bx * w + sway + p.phaseOffset * w + jitX(i, p, 0.3) * w * 0.05, w);
      const size = (2 + p.size * 4) * sizeMul * burstSize(i);
      const rot = p.rot + t * p.rotSpeed;
      drawSnowflake(ctx, x, y, size, rot, p.shape, hexA(baseColor, opacity * p.alpha * alphaMod), 1);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // DUST — tiny slow specks drifting in all directions
  // ───────────────────────────────────────────────────────────────
  else if (type === "dust") {
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const vx = p.vx * 15 * speed;
      const vy = p.vy * 12 * speed;
      const x = wrap(p.bx * w + p.phaseOffset * w + t * vx + jitX(i, p, 0.4) * w * 0.04 + p.vx * surge * 60, w);
      const y = wrap(p.by * h + p.phaseOffset * h + t * vy + jitY(i, p, 0.4) * h * 0.04 + p.vy * surge * 60, h);
      const size = (0.6 + p.size * 1.2) * sizeMul * burstSize(i);
      const tw = 0.5 + 0.5 * Math.sin(t * p.twinkleFreq + p.twinklePhase);
      ctx.fillStyle = hexA(baseColor, opacity * p.alpha * (0.4 + tw * 0.6) * alphaMod);
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }
  }

  // ───────────────────────────────────────────────────────────────
  // SPARKS — bright streaks with trails + warm glow, fast & erratic
  // ───────────────────────────────────────────────────────────────
  else if (type === "sparks") {
    const glow = getGlowSprite("#ffb066", 64, 0.3);
    ctx.lineCap = "round";
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const vx = p.vx * 220 * speed;
      const vy = (p.vy * 80 - 90) * speed; // sparks tend to rise/scatter
      const mag = Math.hypot(vx, vy) || 1;
      const ux = vx / mag, uy = vy / mag;
      const x = wrap(p.bx * w + p.phaseOffset * w + t * vx + jitX(i, p, 1.2) * w * 0.03 + ux * surge * 140, w);
      const y = wrap(p.by * h + p.phaseOffset * h + t * vy + jitY(i, p, 1.2) * h * 0.03 + uy * surge * 140, h);
      const size = (1 + p.size * 1.5) * sizeMul * burstSize(i);
      const flick = 0.55 + 0.45 * Math.sin(t * (8 + p.twinkleFreq * 6) + p.twinklePhase);
      const alpha = clamp01(opacity * p.alpha * flick * alphaMod);
      const len = (8 + p.size * 14) * (1 + drive * 0.6) * (1 + burstDrive) * Math.sqrt(sizeMul);
      const tx = x - ux * len;
      const ty = y - uy * len;

      // glowing trail
      const grad = ctx.createLinearGradient(tx, ty, x, y);
      grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
      grad.addColorStop(0.6, `rgba(255,180,80,${alpha * 0.6})`);
      grad.addColorStop(1, `rgba(255,240,200,${alpha})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();

      // hot core — cached glow sprite instead of a per-spark shadowBlur pass
      stampGlow(ctx, glow, x, y, size * 9, alpha * 0.85);
      ctx.fillStyle = `rgba(255,245,220,${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, size * 1.1, 0, TAU);
      ctx.fill();
    }
  }

  // ───────────────────────────────────────────────────────────────
  // BOKEH — large soft out-of-focus orbs
  // ───────────────────────────────────────────────────────────────
  else if (type === "bokeh") {
    const sprite = getGlowSprite(baseColor, 128, 0.02);
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const vx = p.vx * 12 * speed;
      const vy = p.vy * 10 * speed;
      const x = wrap(p.bx * w + p.phaseOffset * w + t * vx + jitX(i, p, 0.15) * w * 0.05 + p.vx * surge * 40, w);
      const y = wrap(p.by * h + p.phaseOffset * h + t * vy + jitY(i, p, 0.15) * h * 0.05 + p.vy * surge * 40, h);
      const r = (10 + p.size * 22) * sizeMul * burstSize(i);
      const a = opacity * p.alpha * 0.55 * alphaMod;
      stampGlow(ctx, sprite, x, y, r * 2, a);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // LIGHTS — bright glowing bulbs with halo, pulse on bass
  // ───────────────────────────────────────────────────────────────
  else if (type === "lights") {
    const halo = getGlowSprite(baseColor, 128, 0.18);
    const core = getGlowSprite("#ffffff", 32, 0.55);
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const vx = p.vx * 20 * speed;
      const vy = p.vy * 18 * speed;
      const x = wrap(p.bx * w + p.phaseOffset * w + t * vx + jitX(i, p, 0.3) * w * 0.03 + p.vx * surge * 50, w);
      const y = wrap(p.by * h + p.phaseOffset * h + t * vy + jitY(i, p, 0.3) * h * 0.03 + p.vy * surge * 50, h);
      const pulse = 1 + Math.max(audio.bass, drive) * 0.5 + (audio.beat ? 0.2 : 0);
      const twinkle = 0.7 + 0.3 * Math.sin(t * p.twinkleFreq + p.twinklePhase);
      const coreR = (2 + p.size * 3) * pulse * sizeMul * burstSize(i);
      const haloR = coreR * 6;
      const a = opacity * p.alpha * twinkle * alphaMod;
      stampGlow(ctx, halo, x, y, haloR * 2, a);
      stampGlow(ctx, core, x, y, coreR * 2.6, Math.min(1, a * 1.4));
    }
  }

  // ───────────────────────────────────────────────────────────────
  // EMBERS — warm sparks rising from the floor, flickering out near the top
  // ───────────────────────────────────────────────────────────────
  else if (type === "embers") {
    const tints = ["#ffd27a", "#ff9a3c", "#ff6a1a", "#ff3d12"];
    const sprites = tints.map((c) => getGlowSprite(mixToHex(baseColor, c, 0.7), 64, 0.3));
    const core = getGlowSprite("#fff1d0", 32, 0.6);
    const range = h + 80;
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const variant = Math.floor(hash1(i, 21) * 4) & 3;
      const rise = (50 + p.size * 75) * speed;
      const drift = (noise2(t * 0.45 + i * 7.31, i * 3.17) - 0.5) * w * 0.07;
      const sway = Math.sin(t * p.driftFreq * 1.4 + p.rot) * p.driftAmp * w * 0.5;
      const y = wrap(p.by * range + p.phaseOffset * range - t * rise - surge * 80, range) - 40;
      const x = wrap(p.bx * w + p.phaseOffset * w + sway + drift + jitX(i, p, 0.5) * w * 0.04, w);
      const yn = y / h;
      // Born just below the frame, burn out across the upper third.
      const life = smoothstep(1.03, 0.85, yn) * smoothstep(-0.02, 0.35, yn);
      if (life <= 0.01) continue;
      const flicker =
        (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * (7 + p.twinkleFreq * 5) + p.twinklePhase))) *
        (0.6 + 0.4 * noise2(t * 3 + i * 1.3, i * 0.7));
      const r = (1.2 + p.size * 2.2) * sizeMul * burstSize(i);
      const a = opacity * p.alpha * flicker * life * alphaMod;
      stampGlow(ctx, sprites[variant], x, y, r * 7, a * 0.9);
      stampGlow(ctx, core, x, y, r * 2.2, a);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // STARS — twinkling 4-point stars, near-static with slow depth parallax
  // ───────────────────────────────────────────────────────────────
  else if (type === "stars") {
    const sprite = getGlowSprite(baseColor, 64, 0.35);
    ctx.strokeStyle = mixHex(baseColor, "#ffffff", 0.6, 1);
    ctx.lineWidth = Math.max(0.6, 1.1 * sizeMul);
    ctx.lineCap = "round";
    ctx.beginPath(); // all cross strokes batched into one path → one stroke call
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const depth = p.size; // 0.4..2.2 — nearer stars are bigger and drift faster
      const x = wrap(p.bx * w + p.phaseOffset * w + t * (1.5 + depth * 5) * speed + jitX(i, p, 0.08) * w * 0.01, w);
      const y = wrap(p.by * h + Math.sin(t * 0.1 + p.rot) * 2 + jitY(i, p, 0.08) * h * 0.01, h);
      const tw = 0.5 + 0.5 * Math.sin(t * p.twinkleFreq * 1.6 + p.twinklePhase);
      const glint = smoothstep(0.72, 0.95, noise2(t * 0.9 + i * 3.1, i * 1.9));
      const br = clamp01(0.3 + 0.55 * tw + glint * 0.7 + drive * 0.35 * Math.min(1, burst + 0.3));
      const r = (0.8 + depth * 1.4) * sizeMul * burstSize(i);
      const a = opacity * p.alpha * br * alphaMod;
      stampGlow(ctx, sprite, x, y, r * 5 * (0.8 + 0.5 * br), a);
      const arm = r * (1.5 + 3.5 * br * br); // brighter star → longer spikes
      if (arm > 1) {
        ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
        ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
      }
    }
    ctx.globalAlpha = opacity * 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ───────────────────────────────────────────────────────────────
  // DOTS / fallback for unknown types
  // ───────────────────────────────────────────────────────────────
  else {
    for (let i = 0; i < count; i++) {
      const p = pool[i];
      const vx = p.vx * 40 * speed;
      const vy = p.vy * 40 * speed;
      const x = wrap(p.bx * w + p.phaseOffset * w + t * vx + jitX(i, p, 0.4) * w * 0.03, w);
      const y = wrap(p.by * h + p.phaseOffset * h + t * vy + jitY(i, p, 0.4) * h * 0.03, h);
      const size = (1 + p.size * 2) * sizeMul * burstSize(i);
      ctx.fillStyle = hexA(baseColor, opacity * p.alpha * alphaMod);
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }
  }

  ctx.restore();
}

// ─── Colour wash ─────────────────────────────────────────────────────────
// Large soft colour fields from the project palette, orbiting slowly and
// swelling with the bass. 'screen' so they lift the picture without muddying.

function drawGradientWash(d: DrawContext, intensity: number) {
  const { ctx, w, h, audio, t, cfg } = d;
  const I = clamp01(intensity);
  const R = Math.max(w, h) * (0.42 + 0.14 * clamp01(audio.bass));
  const fields = [
    { c: cfg.primary, x: 0.5 + 0.32 * Math.cos(t * 0.13), y: 0.5 + 0.28 * Math.sin(t * 0.17), r: R },
    { c: cfg.accent, x: 0.5 + 0.34 * Math.cos(t * 0.11 + 2.4), y: 0.5 + 0.30 * Math.sin(t * 0.09 + 1.1), r: R * 0.9 },
    { c: cfg.secondary, x: 0.5 + 0.30 * Math.cos(t * 0.07 + 4.2), y: 0.5 + 0.26 * Math.sin(t * 0.12 + 3.3), r: R * 0.7 },
  ];
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = I * 0.6;
  for (const f of fields) {
    const cx = f.x * w, cy = f.y * h;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, f.r);
    g.addColorStop(0, hexA(f.c, 0.55));
    g.addColorStop(0.5, hexA(f.c, 0.18));
    g.addColorStop(1, hexA(f.c, 0));
    ctx.fillStyle = g;
    // Only rasterise the circle's bounding box, not the whole frame.
    ctx.fillRect(cx - f.r, cy - f.r, f.r * 2, f.r * 2);
  }
  ctx.restore();
}

// ─── Fog ─────────────────────────────────────────────────────────────────
// Three fbm puffs (one cached sprite) drifting on slow sine paths with a
// touch of noise; a bit denser as the song gets louder.

function drawFog(d: DrawContext, fog: { density: number; color: string; speed: number }) {
  const { ctx, w, h, audio, t } = d;
  const sprite = getFogSprite(fog.color);
  if (!sprite) return;
  const density = clamp01(fog.density);
  const speed = Math.max(0, fog.speed);
  const energy = clamp01(energyOf(audio));
  const alpha = density * 0.6 * (0.75 + 0.25 * energy);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  for (let k = 0; k < 3; k++) {
    const ph = k * 2.09;
    const sx = w * 1.15 * (0.85 + 0.3 * hash1(k, 41));
    const sy = sx * 0.62;
    const cx = w * (0.5 + 0.38 * Math.sin(t * 0.15 * speed + ph) + 0.1 * (noise2(t * 0.11 * speed + k * 9.7, k * 3.3) - 0.5));
    const cy = h * (0.55 + 0.25 * Math.cos(t * 0.11 * speed + ph * 1.3));
    const rot = (k % 2 ? 1 : -1) * t * 0.03 * speed + ph;
    const a = alpha * (0.7 + 0.3 * noise2(t * 0.2 * speed + k * 5.1, k));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.globalAlpha = clamp01(a);
    ctx.drawImage(sprite, -sx / 2, -sy / 2, sx, sy);
    ctx.restore();
  }
  ctx.restore();
}

// ─── Light streaks ───────────────────────────────────────────────────────
// Long soft diagonal beams (rotated rects with a cross-fade gradient) that
// sweep across the frame on kicks (→) and snares (←) and fade out. A faint
// idle pair drifts with the energy so the layer is never completely dead.

function drawLightStreaks(d: DrawContext, ls: { intensity: number; color: string }) {
  const { ctx, w, h, audio, t } = d;
  const I = clamp01(ls.intensity);
  const color = ls.color;
  const kDecay = decayFromAge(kickAgeOf(audio), 0.6);
  const sDecay = decayFromAge(snareAgeOf(audio), 0.7);
  const energy = clamp01(energyOf(audio));
  const diag = Math.hypot(w, h);
  const length = diag * (1.2 + I * 0.4);
  const baseAngle = -0.62; // ≈ -35°

  const streak = (cx: number, cy: number, angle: number, width: number, alpha: number) => {
    if (alpha < 0.004) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    const g = ctx.createLinearGradient(0, -width / 2, 0, width / 2);
    g.addColorStop(0, hexA(color, 0));
    g.addColorStop(0.5, hexA(color, alpha));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-length / 2, -width / 2, length, width);
    ctx.restore();
  };

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // Kick set — 4 streaks sweeping left → right.
  if (kDecay > 0) {
    const sweep = 1 - Math.pow(kDecay, 2); // eased 0 → 1 over the decay
    for (let i = 0; i < 4; i++) {
      const cx = w * 0.5 + (hash1(i, 31) - 0.5) * w * 0.9 + (sweep - 0.5) * w * 0.7;
      const cy = h * 0.5 + (hash1(i, 32) - 0.5) * h * 0.5;
      const width = (60 + hash1(i, 33) * 120) * (0.6 + I * 0.8);
      const alpha = I * kDecay * kDecay * (0.35 + 0.4 * hash1(i, 34));
      streak(cx, cy, baseAngle + (hash1(i, 35) - 0.5) * 0.2, width, alpha);
    }
  }
  // Snare set — 3 streaks, mirrored angle, sweeping right → left.
  if (sDecay > 0) {
    const sweep = 1 - Math.pow(sDecay, 2);
    for (let i = 0; i < 3; i++) {
      const cx = w * 0.5 + (hash1(i, 51) - 0.5) * w * 0.9 - (sweep - 0.5) * w * 0.7;
      const cy = h * 0.5 + (hash1(i, 52) - 0.5) * h * 0.5;
      const width = (50 + hash1(i, 53) * 100) * (0.6 + I * 0.8);
      const alpha = I * sDecay * sDecay * (0.25 + 0.35 * hash1(i, 54));
      streak(cx, cy, -baseAngle + (hash1(i, 55) - 0.5) * 0.2, width, alpha);
    }
  }
  // Idle pair — very faint, slow drift, scaled by energy.
  for (let i = 0; i < 2; i++) {
    const cx = w * (0.5 + 0.35 * Math.sin(t * 0.23 + i * 2.6));
    const cy = h * (0.5 + 0.2 * Math.cos(t * 0.17 + i * 1.9));
    streak(cx, cy, (i ? -1 : 1) * baseAngle, 160 + i * 60, I * 0.08 * energy);
  }
  ctx.restore();
}

// ─── Beat ripples ────────────────────────────────────────────────────────
// Up to three rings expanding from the visualizer centre: the current kick
// plus the two previous ones (fixed offsets so it needs no history). All
// rings share ONE glow layer.

function drawRipples(d: DrawContext, intensity: number) {
  const { ctx, w, h, audio, cfg } = d;
  const I = clamp01(intensity);
  const age = kickAgeOf(audio);
  if (!Number.isFinite(age) || age < 0) return;
  const { cx, cy } = center(d);
  const minR = Math.min(w, h) * 0.06;
  const maxR = Math.hypot(w, h) * 0.55;
  const life = 1.35; // seconds a ring stays visible
  const ages = [age, age + 0.48, age + 0.97];
  if (ages[0] / life >= 1) return;
  ctx.save();
  withGlowLayer(ctx, { color: cfg.glow, intensity: 0.5 + Math.max(0, cfg.glowIntensity) * 0.5, radius: 20 }, (g) => {
    g.lineCap = "round";
    for (let k = 0; k < ages.length; k++) {
      const u = ages[k] / life;
      if (u >= 1) continue;
      const e = 1 - Math.pow(1 - u, 2.2);
      const r = lerp(minR, maxR, e);
      const alpha = Math.pow(1 - u, 1.6) * I * (k === 0 ? 1 : 0.7);
      if (alpha < 0.01) continue;
      g.globalAlpha = clamp01(alpha);
      g.lineWidth = lerp(16, 1.5, u) * (0.6 + I * 0.6);
      g.strokeStyle = mixHex(cfg.primary, cfg.accent, u);
      g.beginPath();
      g.arc(cx, cy, r, 0, TAU);
      g.stroke();
    }
    g.globalAlpha = 1;
  });
  ctx.restore();
}

// ─── Grain & vignette ────────────────────────────────────────────────────

function drawGrain(d: DrawContext, amount: number) {
  const { ctx, t } = d;
  const a = clamp01(amount);
  if (a <= 0) return;
  // Deterministic grain: a cached noise tile drawn with a per-frame offset.
  // (Math.random() made every Lambda chunk/retry differ and the preview
  // couldn't show it at all.)
  const tile = getNoiseTile();
  if (!tile) return;
  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return;
  const dw = ctx.canvas ? ctx.canvas.width : 0;
  const dh = ctx.canvas ? ctx.canvas.height : 0;
  if (!(dw > 0 && dh > 0)) return;
  const frameIdx = Math.floor(t * 24);
  const ox = Math.floor(rand(frameIdx, 91) * tile.width);
  const oy = Math.floor(rand(frameIdx, 92) * tile.height);
  ctx.save();
  // Drawn in DEVICE pixels so each grain is exactly one pixel at any
  // resolution (under the baseline scale it averaged into a flat grey veil).
  ctx.setTransform(1, 0, 0, 1, -ox, -oy);
  ctx.globalAlpha = a;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = pattern;
  ctx.fillRect(ox, oy, dw, dh);
  ctx.restore();
}

function drawVignette(d: DrawContext, breathing: number) {
  const { ctx, w, h, audio, t } = d;
  const b = clamp01(breathing);
  let inner = Math.min(w, h) * 0.3;
  let outer = Math.max(w, h) * 0.75;
  let dark = 0.65;
  if (b > 0) {
    // Tightens as the energy drops, opens back up on the loud parts, with a
    // small outward pulse on each kick and a slow resting breath.
    const tight = (1 - clamp01(energyOf(audio))) * b;
    const pulse = clamp01(kickOf(audio)) * b;
    const slow = (0.5 + 0.5 * Math.sin(t * 0.7)) * b;
    inner *= 1 - 0.55 * tight - 0.06 * slow + 0.08 * pulse;
    outer *= 1 - 0.28 * tight - 0.04 * slow + 0.04 * pulse;
    dark = clamp01(0.65 + 0.22 * tight);
  }
  const cx = w / 2, cy = h / 2;
  const g = ctx.createRadialGradient(cx, cy, Math.max(0, inner), cx, cy, Math.max(inner + 1, outer));
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${dark})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// ─── Entry point ─────────────────────────────────────────────────────────

export function drawEffects(d: DrawContext, fx: EffectsConfig) {
  const { ctx, w, h, audio } = d;

  // Behind the particles.
  if (fx.gradientWash?.enabled && fx.gradientWash.intensity > 0) drawGradientWash(d, fx.gradientWash.intensity);
  if (fx.fog?.enabled && fx.fog.density > 0) drawFog(d, fx.fog);

  if (fx.particles.enabled) drawParticles(d, fx.particles);

  if (fx.ripples?.enabled && fx.ripples.intensity > 0) drawRipples(d, fx.ripples.intensity);
  if (fx.lightStreaks?.enabled && fx.lightStreaks.intensity > 0) drawLightStreaks(d, fx.lightStreaks);

  if (fx.beatFlash && audio.beat) {
    ctx.fillStyle = `rgba(255,255,255,${0.08})`;
    ctx.fillRect(0, 0, w, h);
  }

  if (fx.lensFlare && audio.volume > 0.3) {
    const g = ctx.createRadialGradient(w * 0.8, h * 0.2, 0, w * 0.8, h * 0.2, 300);
    g.addColorStop(0, `rgba(255,240,200,${0.4 * audio.volume})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  if (fx.noise) drawGrain(d, fx.noiseAmount ?? 0.07);

  if (fx.vignette) drawVignette(d, fx.breathingVignette ?? 0);
}
