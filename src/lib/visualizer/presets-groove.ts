// Preset pack: groove — drum-machine pads, logo shockwaves, fireworks, an LED
// wall, a polar scope and a mandala: looks that lock onto the kick, snare and
// hats rather than the raw spectrum alone. See presets-core.ts for the
// DrawContext/Preset contract and draw-utils.ts for the shared helpers every
// preset must use.
//
// Every draw() in this file is a pure function of (t, audio, cfg): no
// module-level mutable state, no Math.random / Date / performance.now —
// anything that needs to look random goes through hash1(i, salt) / noise2.
// This is what lets the Lambda render start on any frame and match the
// preview. (The only module-level arrays are scratch buffers that are fully
// rewritten before every read, so they never change the picture.)
//
// Glow discipline: all glowing geometry of a preset is drawn inside ONE
// withGlowLayer() call. Never shadowBlur inside a loop; many glowing dots go
// through getGlowSprite + stampGlow instead of arc + fill.

import type { VisualizerConfig } from "../project/types";
import type { Preset } from "./presets-core";
import {
  TAU,
  clamp,
  clamp01,
  lerp,
  smoothstep,
  easeOutCubic,
  hexA,
  mixHex,
  center,
  hash1,
  noise2,
  bandLevels,
  mirroredIndex,
  bandMulForHz,
  withGlowLayer,
  roundRectPath,
  smoothPath,
  getGlowSprite,
  stampGlow,
  kickOf,
  snareOf,
  hatOf,
  energyOf,
  kickAgeOf,
  decayFromAge,
  historyRow,
} from "./draw-utils";

type Pt = { x: number; y: number };

const fin = (v: unknown, fb = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fb);
const reactOf = (cfg: VisualizerConfig) => clamp(fin(cfg.reactivity, 1), 0, 4);
const sizeOf = (cfg: VisualizerConfig) => clamp(fin(cfg.size, 1), 0.1, 3);
const thickOf = (cfg: VisualizerConfig) => clamp(fin(cfg.thickness, 4), 0.5, 60);
const moveOf = (cfg: VisualizerConfig) => clamp01(fin(cfg.movement, 0));
const glowOf = (cfg: VisualizerConfig) => clamp(fin(cfg.glowIntensity, 0.8), 0, 3);
/** Static rotation (radians, like every other pack — store.ts clamps it to ±2π). */
const rotOf = (cfg: VisualizerConfig) => fin(cfg.rotation, 0);
/** Radius guard: Canvas throws on negative radii and NaN poisons whole paths. */
const safeR = (r: number, min = 1) => (Number.isFinite(r) ? Math.max(min, r) : min);

const imgW = (img: HTMLImageElement) => fin(img.naturalWidth, 0) || fin(img.width, 0);
const imgH = (img: HTMLImageElement) => fin(img.naturalHeight, 0) || fin(img.height, 0);
/** True when the logo has decoded far enough to have real dimensions. */
const logoReady = (img?: HTMLImageElement | null): img is HTMLImageElement =>
  !!img && imgW(img) > 0 && imgH(img) > 0;

/** Contain-fit the logo centred on (x, y) inside a `side` square. False if it cannot be drawn yet. */
function drawLogoContain(
  g: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  side: number,
): boolean {
  const iw = imgW(img),
    ih = imgH(img);
  if (!(iw > 0 && ih > 0 && side > 0)) return false;
  const s = Math.min(side / iw, side / ih);
  const dw = iw * s,
    dh = ih * s;
  try {
    g.drawImage(img, x - dw / 2, y - dh / 2, dw, dh);
    return true;
  } catch {
    return false;
  }
}

/** Placeholder for projects without a logo: a lit primary→accent disc with a soft rim. */
function drawPlaceholderDisc(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  cfg: VisualizerConfig,
  tint?: string,
) {
  const rr = safeR(r, 2);
  if (tint) {
    g.fillStyle = tint;
  } else {
    const rg = g.createRadialGradient(x - rr * 0.35, y - rr * 0.35, rr * 0.05, x, y, rr);
    rg.addColorStop(0, cfg.primary);
    rg.addColorStop(1, cfg.accent);
    g.fillStyle = rg;
  }
  g.beginPath();
  g.arc(x, y, rr, 0, TAU);
  g.fill();
  if (tint) return;
  g.strokeStyle = "rgba(255,255,255,0.22)";
  g.lineWidth = Math.max(1, rr * 0.04);
  g.beginPath();
  g.arc(x, y, rr * 0.62, 0, TAU);
  g.stroke();
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.beginPath();
  g.arc(x, y, rr * 0.1, 0, TAU);
  g.fill();
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Drum Machine — a 4×N pad bank. Pad k lights with band k (bottom-left =
//    bass … top-right = treble); three pads are wired to the kick, snare and
//    hat envelopes. Unlit bodies go straight to the canvas, every lit pad and
//    the 16-step sequencer strip share ONE glow layer.
// ─────────────────────────────────────────────────────────────────────────
const drumMachine: Preset = {
  id: "drum-machine",
  name: "Drum Machine",
  category: "Grid",
  description:
    "An MPC-style pad bank: each pad lights with its own slice of the mix, the kick, snare and hat pads punch on every hit, and a 16-step sequencer runs along the bottom.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const move = moveOf(cfg);
    const rows = 4;
    // 4×4 on portrait/square, 4×6 on 16:9 — the bank always fills the frame.
    const cols = clamp(Math.round((w / h) * 3.4), 4, 8);
    const pads = rows * cols;
    const levels = bandLevels(audio.freq, pads, 0.85, cfg, audio);
    const kick = clamp01(kickOf(audio) * react);
    const snare = clamp01(snareOf(audio) * react);
    const hat = clamp01(hatOf(audio) * react);
    const pitch = Math.max(8, Math.min((h * 0.64 * size) / rows, (w * 0.88 * size) / cols));
    const pad = pitch * 0.84;
    const inset = (pitch - pad) / 2;
    const gridW = pitch * cols,
      gridH = pitch * rows;
    const stripH = Math.max(6, pitch * 0.15);
    const stripGap = pitch * 0.2;
    const totalH = gridH + stripGap + stripH;
    const x0 = -gridW / 2,
      y0 = -totalH / 2;
    const radius = pad * 0.16;
    const steps = 16;
    const step = Math.floor(t * 8) % steps; // 16th notes at 120 BPM
    const stepW = gridW / steps;
    const stripY = y0 + gridH + stripGap;

    // Per-pad level + colour. Index (rows-1-r)*cols+c counts from the bottom-left.
    const padLevel = new Array<number>(pads).fill(0);
    const padColor = new Array<string>(pads).fill(cfg.primary);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const band = (rows - 1 - r) * cols + c;
        const isKick = r === rows - 1 && c === 0;
        const isSnare = r === rows - 1 && c === 1;
        const isHat = r === rows - 2 && c === 0;
        if (isKick) {
          padLevel[i] = kick;
          padColor[i] = cfg.accent;
        } else if (isSnare) {
          padLevel[i] = snare;
          padColor[i] = mixHex(cfg.accent, "#ffffff", 0.35);
        } else if (isHat) {
          padLevel[i] = hat;
          padColor[i] = mixHex(cfg.secondary, "#ffffff", 0.4);
        } else {
          // A touch of idle shimmer (movement) keeps the bank alive between hits.
          const idle = move * 0.08 * noise2(c * 0.9 + t * 0.35, r * 1.1 - t * 0.2);
          // Floor + steeper curve so quiet bands go dark instead of glowing evenly.
          const v = clamp01((clamp01(levels[band] * react) - 0.1) / 0.9);
          padLevel[i] = clamp01(Math.pow(v, 1.6) + idle);
          padColor[i] = mixHex(cfg.primary, cfg.secondary, band / Math.max(1, pads - 1));
        }
      }
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotOf(cfg));

    // Chassis plate.
    const margin = pitch * 0.22;
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    roundRectPath(
      ctx,
      x0 - margin,
      y0 - margin,
      gridW + margin * 2,
      totalH + margin * 2,
      radius * 1.6,
    );
    ctx.fill();
    ctx.stroke();

    // Unlit pad bodies: top-lit rubber with a faint inner bevel.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px = x0 + c * pitch + inset,
          py = y0 + r * pitch + inset;
        const body = ctx.createLinearGradient(0, py, 0, py + pad);
        body.addColorStop(0, "#23232c");
        body.addColorStop(1, "#0f0f14");
        ctx.fillStyle = body;
        ctx.beginPath();
        roundRectPath(ctx, px, py, pad, pad, radius);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        roundRectPath(ctx, px + 1.5, py + 1.5, pad - 3, pad - 3, Math.max(1, radius - 1));
        ctx.stroke();
      }
    }
    // Unlit sequencer cells.
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    for (let i = 0; i < steps; i++) {
      roundRectPath(ctx, x0 + i * stepW + stepW * 0.1, stripY, stepW * 0.8, stripH, stripH * 0.25);
    }
    ctx.fill();

    withGlowLayer(
      ctx,
      { color: cfg.glow, intensity: glowOf(cfg) * (0.8 + kick * 0.5), radius: 22 },
      (g) => {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const v = padLevel[i];
            if (v < 0.04) continue;
            const px = x0 + c * pitch + inset,
              py = y0 + r * pitch + inset;
            g.globalAlpha = 0.18 + 0.82 * v;
            g.fillStyle = padColor[i];
            g.beginPath();
            roundRectPath(g, px, py, pad, pad, radius);
            g.fill();
            // Inner bevel rim.
            g.globalAlpha = v;
            g.strokeStyle = "rgba(255,255,255,0.45)";
            g.lineWidth = Math.max(1, pad * 0.02);
            g.beginPath();
            roundRectPath(
              g,
              px + pad * 0.08,
              py + pad * 0.08,
              pad * 0.84,
              pad * 0.84,
              radius * 0.7,
            );
            g.stroke();
            // Hot core on hard hits.
            if (v > 0.35) {
              const mx = px + pad / 2,
                my = py + pad / 2;
              const core = g.createRadialGradient(mx, my, 0, mx, my, pad * 0.55);
              core.addColorStop(0, "rgba(255,255,255,0.9)");
              core.addColorStop(1, "rgba(255,255,255,0)");
              g.globalAlpha = ((v - 0.35) / 0.65) * 0.85;
              g.fillStyle = core;
              g.beginPath();
              roundRectPath(g, px, py, pad, pad, radius);
              g.fill();
            }
          }
        }

        // Step sequencer: a fixed programmed pattern plus the moving playhead.
        for (let i = 0; i < steps; i++) {
          const programmed = i % 4 === 0 || hash1(i, 7) < 0.45;
          const isNow = i === step;
          if (!programmed && !isNow) continue;
          g.globalAlpha = isNow ? 0.9 + kick * 0.1 : 0.35;
          g.fillStyle = isNow ? cfg.accent : cfg.primary;
          g.beginPath();
          roundRectPath(
            g,
            x0 + i * stepW + stepW * 0.1,
            stripY,
            stepW * 0.8,
            stripH,
            stripH * 0.25,
          );
          g.fill();
        }
        // Playhead marker.
        g.globalAlpha = 1;
        g.fillStyle = "#ffffff";
        const mx = x0 + (step + 0.5) * stepW;
        g.beginPath();
        g.moveTo(mx - stripH * 0.3, stripY - stripH * 0.4);
        g.lineTo(mx + stripH * 0.3, stripY - stripH * 0.4);
        g.lineTo(mx, stripY - stripH * 0.08);
        g.closePath();
        g.fill();
      },
    );
    ctx.restore();
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 2. Logo Shockwave — the logo breathes with the bass; each kick launches a
//    ring (current kick + two older ones at fixed age offsets, like the
//    effects.ts ripples) that bulges the radial spectrum it passes through.
//    Snares draw a chromatic double image of the logo. Spokes + rings + kick
//    halo share ONE glow layer; the logo itself is composited on top.
// ─────────────────────────────────────────────────────────────────────────
const logoShockwave: Preset = {
  id: "logo-shockwave",
  name: "Logo Shockwave",
  category: "Logo",
  consumesLogo: true,
  description:
    "Your logo breathes with the bass while every kick fires a shockwave ring out through the spectrum around it — snares split it into a chromatic double image.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t, logo } = d;
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const thick = thickOf(cfg);
    const move = moveOf(cfg);
    // Anchored on the logo position (this preset owns the logo, so the logo
    // controls move it — same convention as the other consumesLogo presets).
    const fxScale = clamp(fin(d.logoFx?.scale, 1), 0.5, 2);
    const hop = clamp(fin(d.logoFx?.hop, 0), -h, h);
    const cx = w / 2 + (clamp(fin(cfg.logoPosition?.x, 0), -1, 1) * w) / 2;
    const cy = h / 2 + (clamp(fin(cfg.logoPosition?.y, 0), -1, 1) * h) / 2 + hop;
    const kick = clamp01(kickOf(audio) * react);
    const snare = clamp01(snareOf(audio) * react);
    const bass = clamp01(audio.bass * react);
    const minSide = Math.min(w, h);
    const lr = safeR(
      minSide *
        clamp(fin(cfg.logoSize, 0.35), 0.05, 1.5) *
        0.5 *
        fxScale *
        (1 + bass * 0.08 + kick * 0.05),
      6,
    );

    // Shockwave rings: the current kick plus two echoes at fixed age offsets.
    const age = kickAgeOf(audio);
    const life = 1.4;
    const rMin = lr * 1.05;
    const rMax = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * (0.5 + 0.35 * size);
    const rings: { r: number; u: number; strength: number }[] = [];
    if (Number.isFinite(age) && age >= 0) {
      const ages = [age, age + 0.5, age + 1.0];
      for (let k = 0; k < ages.length; k++) {
        const u = ages[k] / life;
        if (u >= 1) continue;
        rings.push({
          // Gentle ease so the ring spends its first ~0.4 s crossing the spokes.
          r: lerp(rMin, rMax, 1 - Math.pow(1 - u, 1.5)),
          u,
          strength: Math.pow(1 - u, 1.5) * (k === 0 ? 1 : 0.6),
        });
      }
    }

    // Radial spectrum: N spokes, bass at the top/bottom, each a 4-segment
    // polyline so a passing ring can bulge it outward.
    const N = clamp(Math.round((cfg.bandCount || 48) / 2) * 2, 32, 128);
    const levels = bandLevels(audio.freq, N / 2, 0.8, cfg, audio);
    const rIn = lr * 1.22;
    const amp = minSide * 0.27 * size;
    const sigma = minSide * 0.05;
    const pushAmp = minSide * 0.065 * react;
    const push = (r: number) => {
      let p = 0;
      for (const rg of rings) {
        const x = (r - rg.r) / sigma;
        p += rg.strength * Math.exp(-x * x);
      }
      return p * pushAmp;
    };
    const spin = rotOf(cfg) + t * 0.12 * move;

    withGlowLayer(ctx, { color: cfg.glow, intensity: glowOf(cfg) * (0.8 + kick * 0.6) }, (g) => {
      // Kick halo behind the logo.
      if (kick > 0.02) {
        const hr = safeR(lr * 1.7);
        const halo = g.createRadialGradient(cx, cy, lr * 0.8, cx, cy, hr);
        halo.addColorStop(0, hexA(cfg.glow, 0.55 * kick));
        halo.addColorStop(1, hexA(cfg.glow, 0));
        g.fillStyle = halo;
        g.beginPath();
        g.arc(cx, cy, hr, 0, TAU);
        g.fill();
      }

      // Spokes (one batched path, one radial gradient stroke).
      const sg = g.createRadialGradient(cx, cy, rIn, cx, cy, safeR(rIn + amp + pushAmp));
      sg.addColorStop(0, hexA(cfg.primary, 0.8));
      sg.addColorStop(1, hexA(cfg.accent, 0.3));
      g.strokeStyle = sg;
      g.lineWidth = Math.max(1, thick * 0.45);
      g.lineCap = "round";
      g.beginPath();
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU - Math.PI / 2 + spin;
        const v = clamp01(levels[mirroredIndex(i, N)] * react);
        const len = 8 * size + amp * Math.pow(v, 0.9);
        const ca = Math.cos(a),
          sa = Math.sin(a);
        for (let j = 0; j <= 4; j++) {
          const r0 = rIn + (len * j) / 4;
          const r = r0 + push(r0);
          const x = cx + ca * r,
            y = cy + sa * r;
          if (j === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
      }
      g.stroke();

      // Rings: coloured body + thin white leading edge.
      for (const rg of rings) {
        const lw = lerp(thick * 3.5, thick * 0.6, rg.u);
        g.globalAlpha = clamp01(rg.strength);
        g.lineWidth = lw;
        g.strokeStyle = mixHex(cfg.accent, cfg.primary, rg.u);
        g.beginPath();
        g.arc(cx, cy, safeR(rg.r), 0, TAU);
        g.stroke();
        g.globalAlpha = clamp01(rg.strength * 0.7);
        g.lineWidth = Math.max(1, lw * 0.3);
        g.strokeStyle = "#ffffff";
        g.beginPath();
        g.arc(cx, cy, safeR(rg.r + lw * 0.3), 0, TAU);
        g.stroke();
      }
      g.globalAlpha = 1;
    });

    // Soft disc under the logo so it reads as sitting in front of the spokes.
    const under = ctx.createRadialGradient(cx, cy, 0, cx, cy, safeR(lr * 1.25));
    under.addColorStop(0, "rgba(0,0,0,0.55)");
    under.addColorStop(0.78, "rgba(0,0,0,0.35)");
    under.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = under;
    ctx.beginPath();
    ctx.arc(cx, cy, safeR(lr * 1.25), 0, TAU);
    ctx.fill();

    const drawLogo = (x: number, y: number, tint?: string) => {
      if (logoReady(logo) && drawLogoContain(ctx, logo, x, y, lr * 2)) return;
      drawPlaceholderDisc(ctx, x, y, lr * 0.92, cfg, tint);
    };

    // Snare: chromatic double image (two additive ghosts, shifted apart).
    if (snare > 0.04) {
      const off = (4 + 26 * snare) * size;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5 * snare;
      drawLogo(cx - off, cy, cfg.primary);
      drawLogo(cx + off, cy, cfg.accent);
      ctx.restore();
    }
    drawLogo(cx, cy);
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 3. Fireworks — deterministic shells. Four launch lanes with fixed intervals
//    open up as the energy rises; slot index floor((t − phase) / interval)
//    seeds every shell (position, colour, spark count, type) via hash1, so
//    any frame can be rendered on its own. Sparks are glow-sprite stamps on
//    dragged ballistic arcs with a 3-stamp tail. Every kick also lofts a
//    shell near the centre.
// ─────────────────────────────────────────────────────────────────────────
const LANES: { interval: number; threshold: number }[] = [
  { interval: 1.35, threshold: 0 },
  { interval: 1.05, threshold: 0.25 },
  { interval: 1.7, threshold: 0.45 },
  { interval: 0.85, threshold: 0.65 },
];

const fireworks: Preset = {
  id: "fireworks",
  name: "Fireworks",
  category: "Particles",
  description:
    "Rockets climb and burst in your three colours — the louder the track gets, the faster they come, and every kick sets off an extra shell right in the middle.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const move = moveOf(cfg);
    const energy = clamp01(energyOf(audio) * react);
    const minSide = Math.min(w, h);
    const palette = [cfg.primary, cfg.secondary, cfg.accent];
    const sprites = palette.map((c) => getGlowSprite(c, 48, 0.28));
    const white = getGlowSprite("#ffffff", 48, 0.35);
    const gravity = minSide * 0.32; // baseline px / s²
    const drag = 1.6; // 1 / s
    const life = 1.5; // seconds a shell stays visible after bursting
    const rise = 0.55; // seconds the rocket climbs

    const paint = (g: CanvasRenderingContext2D) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(rotOf(cfg));
      g.translate(-cx, -cy);
      g.globalCompositeOperation = "lighter";

      const shell = (
        key: number,
        ox: number,
        oy: number,
        age: number,
        R: number,
        n: number,
        ci: number,
        gain: number,
      ) => {
        if (age < 0 || age >= life || gain <= 0.01) return;
        const sprite = sprites[ci];
        const fade = Math.pow(1 - age / life, 1.1) * gain;
        // Muzzle flash + a wide soft bloom that lingers like smoke.
        if (age < 0.16)
          stampGlow(g, white, ox, oy, R * (0.5 + age / 0.16), (1 - age / 0.16) * gain);
        // Soft bloom while the shell is fresh (kept small: a big blended sprite is the
        // single most expensive thing here on a CPU rasteriser).
        if (age < 0.6) stampGlow(g, sprite, ox, oy, R * 1.5, 0.14 * fade * (1 - age / 0.6));
        const ring = hash1(key, 6) < 0.3;
        const wind = Math.sin(t * 0.4 + key) * move * minSide * 0.05;
        const trHead = (1 - Math.exp(-drag * age)) / drag;
        const aTail = Math.max(0, age - 0.09);
        const trTail = (1 - Math.exp(-drag * aTail)) / drag;
        const headD = (14 + 10 * hash1(key, 9)) * size * (1 - (0.4 * age) / life);
        const dying = age > life * 0.5;
        // Pass 1: every tail as one batched streak path (one stroke per shell).
        const pos = new Float32Array(n * 4);
        g.strokeStyle = hexA(palette[ci], clamp01(fade * 0.55));
        g.lineWidth = Math.max(1, headD * 0.22);
        g.lineCap = "round";
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const si = key * 131 + i;
          const ang = ring ? (i / n) * TAU + hash1(key, 8) : hash1(si, 21) * TAU;
          const spd =
            R *
            drag *
            (ring ? 0.9 + hash1(si, 22) * 0.15 : 0.35 + Math.pow(hash1(si, 22), 0.7) * 0.7);
          const dx = Math.cos(ang) * spd,
            dy = Math.sin(ang) * spd;
          const hx = ox + dx * trHead + wind * age;
          const hy = oy + dy * trHead + 0.5 * gravity * age * age;
          const tx = ox + dx * trTail + wind * aTail;
          const ty = oy + dy * trTail + 0.5 * gravity * aTail * aTail;
          pos[i * 4] = hx;
          pos[i * 4 + 1] = hy;
          pos[i * 4 + 2] = tx;
          pos[i * 4 + 3] = ty;
          g.moveTo(tx, ty);
          g.lineTo(hx, hy);
        }
        g.stroke();
        // Pass 2: glowing heads (twinkling once the shell starts to die), white-hot early on.
        for (let i = 0; i < n; i++) {
          const si = key * 131 + i;
          const tw = dying ? 0.5 + 0.5 * Math.sin(age * (28 + hash1(si, 23) * 18) + i * 1.7) : 1;
          const alpha = fade * tw;
          if (alpha < 0.02) continue;
          const dia = headD * (0.8 + hash1(si, 24) * 0.4);
          stampGlow(g, sprite, pos[i * 4], pos[i * 4 + 1], dia, alpha);
          if (age < 0.35)
            stampGlow(g, white, pos[i * 4], pos[i * 4 + 1], dia * 0.45, alpha * (1 - age / 0.35));
        }
      };

      const rocket = (x: number, yTo: number, p: number, ci: number, gain: number) => {
        for (let k = 0; k < 4; k++) {
          const pk = p - k * 0.05;
          if (pk <= 0) break;
          const y = lerp(h + 20, yTo, easeOutCubic(pk));
          const wob = Math.sin(pk * 40) * 3 * size;
          stampGlow(
            g,
            k === 0 ? white : sprites[ci],
            x + wob,
            y,
            (k === 0 ? 14 : 11 - k) * size,
            gain * (k === 0 ? 0.9 : 0.35 / k),
          );
        }
      };

      for (let l = 0; l < LANES.length; l++) {
        const { interval, threshold } = LANES[l];
        const gate = threshold === 0 ? 1 : smoothstep(threshold - 0.12, threshold + 0.12, energy);
        if (gate <= 0.01) continue;
        const phase = hash1(l, 11) * interval;
        const slot = Math.floor((t - phase) / interval);
        // A shell can outlive its lane interval, so the previous slot may still be in the air.
        for (let s = slot - 1; s <= slot; s++) {
          const age = t - (s * interval + phase);
          if (age < 0 || age >= rise + life) continue;
          const key = s * 4 + l;
          const ox = cx + (hash1(key, 1) - 0.5) * w * 0.8;
          const oy = cy - h * 0.02 - hash1(key, 2) * h * 0.32;
          const ci = (((s + l) % 3) + 3) % 3;
          if (age < rise) {
            rocket(ox, oy, age / rise, ci, gate);
          } else {
            const R = minSide * (0.17 + hash1(key, 4) * 0.12) * size * (0.75 + energy * 0.5);
            shell(key, ox, oy, age - rise, R, 60 + Math.floor(hash1(key, 3) * 31), ci, gate);
          }
        }
      }

      // Kick shell near the centre. kickOf() itself only exceeds 0.7 for the
      // first ~50 ms of a hit, so the shell is timed off kickAgeOf() instead
      // and simply fires for every kick (its size follows the reactivity).
      const kAge = kickAgeOf(audio);
      if (Number.isFinite(kAge) && kAge >= 0 && kAge < life) {
        const key = 7000 + Math.round((t - kAge) * 8);
        shell(
          key,
          cx + (hash1(key, 1) - 0.5) * w * 0.16,
          cy - h * 0.06 + (hash1(key, 2) - 0.5) * h * 0.1,
          kAge,
          minSide * 0.24 * size * (0.7 + 0.5 * react),
          78,
          ((key % 3) + 3) % 3,
          0.9,
        );
      }
      g.restore();
    };

    // The sprites already glow; the blur layer only adds bloom above 1.
    if (glowOf(cfg) > 1) {
      withGlowLayer(ctx, { color: cfg.glow, intensity: (glowOf(cfg) - 1) * 0.8 }, paint);
    } else {
      paint(ctx);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 4. LED Wall — a coarse LED matrix (≈64×36 on 16:9) showing the spectral
//    history as a waterfall: newest row at the bottom, bass on the left.
//    Brightness is quantised to 6 levels so the whole wall is 1 off-path +
//    5 lit paths; the lit paths share ONE glow layer for the bloom. Falls
//    back to a bandLevels bar graph when the engine has no history.
// ─────────────────────────────────────────────────────────────────────────
const HIST_LO = Math.log(30),
  HIST_HI = Math.log(16000);
/** Scratch buffers, fully rewritten before every read (pure caches). */
const ledRow = new Float32Array(64);
let ledQ = new Uint8Array(0);

const ledWall: Preset = {
  id: "led-wall",
  name: "LED Wall",
  category: "Grid",
  description:
    "A chunky LED video wall: the spectrum scrolls up it like a waterfall, bass on the left and highs on the right, every LED stepping through six brightness levels.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const move = moveOf(cfg);
    const kick = clamp01(kickOf(audio) * react);
    const rot = rotOf(cfg);
    const pitch = clamp(30 * size, 16, 90);
    // Enough cells to reach the farthest corner from the centre whatever the
    // position offset or rotation.
    const reachX = Math.max(cx, w - cx),
      reachY = Math.max(cy, h - cy);
    const reach = Math.hypot(reachX, reachY);
    const halfCols = Math.ceil((rot !== 0 ? reach : reachX) / pitch);
    const halfRows = Math.ceil((rot !== 0 ? reach : reachY) / pitch);
    const cols = halfCols * 2,
      rows = halfRows * 2;
    const cells = cols * rows;
    if (ledQ.length < cells) ledQ = new Uint8Array(cells);
    const gain = (0.8 + kick * 0.2) * react;

    // Column → history band (64 log-spaced bands, 30 Hz–16 kHz) with the same
    // sensitivity multipliers + gentle high tilt bandLevels() applies.
    const colBand = new Float32Array(cols);
    const colMul = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const p = (c + 0.5) / cols;
      colBand[c] = clamp(p * 64 - 0.5, 0, 63);
      const hz = Math.exp(HIST_LO + p * (HIST_HI - HIST_LO));
      colMul[c] = bandMulForHz(hz, cfg) * (1 + 0.5 * p);
    }

    // 6 brightness levels (0 = off); the power curve keeps the top levels for real peaks.
    const quant = (v: number) =>
      v <= 0.02 ? 0 : Math.min(5, Math.floor(Math.pow(clamp01(v), 1.35) * 6));
    if (historyRow(audio, 0, ledRow)) {
      // ~2.2 s of history across the wall (rows are 20 ms apart).
      const stride = clamp(Math.round(110 / rows), 1, 8);
      for (let r = 0; r < rows; r++) {
        const row = historyRow(audio, r * stride, ledRow);
        for (let c = 0; c < cols; c++) {
          let v = 0;
          if (row) {
            const b = colBand[c];
            const b0 = Math.floor(b);
            const b1 = Math.min(63, b0 + 1);
            v = lerp(row[b0], row[b1], b - b0) * colMul[c];
          }
          v = v * gain + move * 0.06 * noise2(c * 0.2 + t * 0.4, r * 0.2 - t * 0.1);
          ledQ[r * cols + c] = quant(v);
        }
      }
    } else {
      // No history: classic LED spectrum analyser (columns of LEDs per band).
      const levels = bandLevels(audio.freq, cols, 0.8, cfg, audio);
      for (let c = 0; c < cols; c++) {
        const hgt = clamp01(levels[c] * gain) * rows;
        for (let r = 0; r < rows; r++) {
          ledQ[r * cols + c] = r < hgt ? Math.min(5, 1 + Math.floor((5 * r) / rows)) : 0;
        }
      }
    }

    const gapX = pitch * 0.18,
      gapY = pitch * 0.36; // taller gaps read as scanlines
    const cw = pitch - gapX,
      ch = pitch - gapY;
    const xAt = (c: number) => (c - halfCols) * pitch + gapX / 2;
    const yAt = (r: number) => (halfRows - 1 - r) * pitch + gapY / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);

    // One pass buckets every cell into 6 paths (Path2D when available, else
    // one pass per level); off LEDs go straight to the canvas, lit levels bloom
    // together in a single glow layer.
    const buckets: (Path2D | null)[] = new Array(6).fill(null);
    if (typeof Path2D === "function") {
      for (let L = 0; L <= 5; L++) buckets[L] = new Path2D();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          buckets[ledQ[r * cols + c]]?.rect(xAt(c), yAt(r), cw, ch);
        }
      }
    }
    const fillLevel = (g: CanvasRenderingContext2D, L: number) => {
      const b = buckets[L];
      if (b) {
        g.fill(b);
        return;
      }
      g.beginPath();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (ledQ[r * cols + c] === L) g.rect(xAt(c), yAt(r), cw, ch);
        }
      }
      g.fill();
    };

    // Off LEDs: the matrix itself, faintly tinted.
    ctx.fillStyle = hexA(cfg.primary, 0.07);
    fillLevel(ctx, 0);

    withGlowLayer(ctx, { color: cfg.glow, intensity: glowOf(cfg) * 0.9, radius: 18 }, (g) => {
      const alphas = [0.32, 0.5, 0.68, 0.85, 1];
      for (let L = 1; L <= 5; L++) {
        g.fillStyle =
          L === 5
            ? mixHex(cfg.accent, "#ffffff", 0.35)
            : mixHex(cfg.primary, cfg.accent, (L - 1) / 4, alphas[L - 1]);
        fillLevel(g, L);
      }
    });
    ctx.restore();
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 5. Polar Scope — the waveform wrapped `turns` times around the centre on a
//    slowly drifting lobed base radius, so successive turns braid into a
//    rosette. Stroked as 24 gradient chunks (primary → secondary along the
//    path); hats sprinkle sprite sparkles at the outer radius. One glow layer.
// ─────────────────────────────────────────────────────────────────────────
const polarScope: Preset = {
  id: "polar-scope",
  name: "Polar Scope",
  category: "Wave",
  description:
    "An oscilloscope bent into a circle: the waveform wraps around the centre several times into a spinning rosette that thickens on the bass and throws sparks on every hi-hat.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const thick = thickOf(cfg);
    const move = moveOf(cfg);
    const wave = audio.wave;
    const len = wave.length;
    const kick = clamp01(kickOf(audio) * react);
    const bass = clamp01(audio.bass * react);
    const hat = clamp01(hatOf(audio) * react);
    const turns = clamp(Math.round((cfg.bandCount || 48) / 16), 2, 6);
    const M = 512;
    const minSide = Math.min(w, h);
    const R0 = minSide * 0.26 * size * (1 + kick * 0.04);
    const A = R0 * (0.42 + bass * 0.4);
    const spin = rotOf(cfg) + t * (0.06 + move * 0.7);
    const lobes = turns + 1;

    const pts: Pt[] = new Array(M + 1);
    for (let i = 0; i <= M; i++) {
      const u = i / M;
      const th = u * turns * TAU + spin;
      const s = len ? (wave[Math.min(len - 1, Math.floor(u * (len - 1)))] - 128) / 128 : 0;
      const rb = R0 * (0.8 + 0.2 * Math.sin((th * lobes) / turns + t * 0.4));
      const r = safeR(rb + s * A, 2);
      pts[i] = { x: cx + Math.cos(th) * r, y: cy + Math.sin(th) * r };
    }

    // Graticule.
    ctx.strokeStyle = hexA(cfg.primary, 0.12);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const k of [0.5, 1, 1.45]) {
      ctx.moveTo(cx + R0 * k, cy);
      ctx.arc(cx, cy, safeR(R0 * k), 0, TAU);
    }
    ctx.moveTo(cx - R0 * 1.6, cy);
    ctx.lineTo(cx + R0 * 1.6, cy);
    ctx.moveTo(cx, cy - R0 * 1.6);
    ctx.lineTo(cx, cy + R0 * 1.6);
    ctx.stroke();

    const chunks = 24;
    const per = M / chunks;
    withGlowLayer(ctx, { color: cfg.glow, intensity: glowOf(cfg) * (0.85 + kick * 0.4) }, (g) => {
      g.lineCap = "round";
      g.lineJoin = "round";
      // Faint phosphor body inside the trace.
      g.fillStyle = hexA(cfg.primary, 0.07 + bass * 0.05);
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i <= M; i++) g.lineTo(pts[i].x, pts[i].y);
      g.closePath();
      g.fill("evenodd");

      g.lineWidth = Math.max(1.5, thick * (0.6 + bass * 1.8));
      for (let c = 0; c < chunks; c++) {
        const i0 = Math.floor(c * per),
          i1 = Math.min(M, Math.floor((c + 1) * per));
        if (i1 <= i0) continue;
        const p0 = pts[i0],
          p1 = pts[i1];
        const k0 = c / chunks,
          k1 = (c + 1) / chunks;
        if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1) {
          g.strokeStyle = mixHex(cfg.primary, cfg.secondary, k0);
        } else {
          const gr = g.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
          gr.addColorStop(0, mixHex(cfg.primary, cfg.secondary, k0));
          gr.addColorStop(1, mixHex(cfg.primary, cfg.secondary, k1));
          g.strokeStyle = gr;
        }
        g.beginPath();
        g.moveTo(p0.x, p0.y);
        for (let i = i0 + 1; i <= i1; i++) g.lineTo(pts[i].x, pts[i].y);
        g.stroke();
      }

      // Hat sparkles at the outer radius (sprite + a thin cross).
      if (hat > 0.05) {
        const sprite = getGlowSprite(cfg.secondary, 32, 0.3);
        const rS = R0 + A * 1.05 + 10 * size;
        const n = 20;
        const cross: Pt[] = [];
        for (let j = 0; j < n; j++) {
          const a = hash1(j, 31) * TAU + spin * 0.6;
          const tw = 0.5 + 0.5 * Math.sin(t * 21 + j * 2.3);
          const al = hat * tw;
          if (al < 0.03) continue;
          const rr = rS * (0.96 + hash1(j, 32) * 0.1);
          const x = cx + Math.cos(a) * rr,
            y = cy + Math.sin(a) * rr;
          const dia = (10 + 30 * al) * size;
          stampGlow(g, sprite, x, y, dia, al);
          cross.push({ x, y }, { x: dia * 0.45, y: 0 });
        }
        g.strokeStyle = `rgba(255,255,255,${clamp01(hat * 0.8)})`;
        g.lineWidth = Math.max(1, thick * 0.2);
        g.beginPath();
        for (let k = 0; k < cross.length; k += 2) {
          const p = cross[k],
            s = cross[k + 1].x;
          g.moveTo(p.x - s, p.y);
          g.lineTo(p.x + s, p.y);
          g.moveTo(p.x, p.y - s);
          g.lineTo(p.x, p.y + s);
        }
        g.stroke();
      }

      // Beam origin.
      g.fillStyle = "#ffffff";
      g.globalAlpha = 0.9;
      g.beginPath();
      g.arc(cx, cy, safeR((3 + kick * 6) * size), 0, TAU);
      g.fill();
      g.globalAlpha = 1;
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 6. Mandala — 8/12/16-fold symmetry (from bandCount). Three rings of
//    petals: each petal outline is S points whose radius follows a mirrored
//    slice of the spectrum (tip = the ring's lowest band), rotated `folds`
//    times by plain trig into ONE path per ring. Rings counter-rotate, the
//    outer ring blooms on the kick and treble etches filigree between them.
//    One glow layer.
// ─────────────────────────────────────────────────────────────────────────
const mandala: Preset = {
  id: "mandala",
  name: "Mandala",
  category: "Sacred",
  description:
    "A living mandala: three rings of petals fold the mix into 8-, 12- or 16-way symmetry, the rings turn against each other, the outer ring blooms on every kick and the highs etch fine filigree between them.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const size = sizeOf(cfg);
    const thick = thickOf(cfg);
    const move = moveOf(cfg);
    const bc = cfg.bandCount || 48;
    const folds = bc < 32 ? 8 : bc < 64 ? 12 : 16;
    const sector = TAU / folds;
    const S = 9; // outline samples per petal (odd → one tip point)
    const half = 5; // distinct bands per petal (mirrored)
    const levels = bandLevels(audio.freq, half * 3, 0.85, cfg, audio);
    const kick = clamp01(kickOf(audio) * react);
    const bloom = clamp01(decayFromAge(kickAgeOf(audio), 0.55) * react);
    const treble = clamp01(audio.treble * 1.3 * react);
    const bass = clamp01(audio.bass * react);
    const base = Math.min(w, h) * 0.07 * size;
    const spin = 0.04 + move * 0.35;
    const rot = rotOf(cfg);
    const colours = [cfg.primary, cfg.secondary, cfg.accent];
    const rings = [
      { rIn: base * 1.05, len: base * 1.45, dir: 1, off: 0 },
      { rIn: base * 2.25, len: base * 1.7, dir: -0.7, off: sector / 2 },
      {
        rIn: base * 3.6 + bloom * base * 0.55,
        len: base * 2.0 * (1 + bloom * 0.35),
        dir: 0.5,
        off: 0,
      },
    ];
    const angleOf = (j: number) => rot + rings[j].off + t * spin * rings[j].dir;

    // Petal outlines per ring (folds × S points), shared by fill and stroke.
    const petals: Pt[][][] = rings.map((ring, j) => {
      const a0 = angleOf(j);
      const rIn = ring.rIn * (1 + bass * 0.04);
      const out: Pt[][] = new Array(folds);
      for (let f = 0; f < folds; f++) {
        const pts: Pt[] = new Array(S);
        for (let s = 0; s < S; s++) {
          const u = s / (S - 1);
          const bi = Math.round(Math.abs(s - (S - 1) / 2)); // 4,3,2,1,0,1,2,3,4
          const v = clamp01(levels[j * half + bi] * react);
          const shape = Math.pow(Math.cos((u - 0.5) * Math.PI), 0.85);
          const rho = rIn + ring.len * shape * (0.3 + 0.7 * v);
          const ang = a0 + f * sector + (u - 0.5) * sector * 0.92;
          pts[s] = { x: cx + Math.cos(ang) * rho, y: cy + Math.sin(ang) * rho };
        }
        out[f] = pts;
      }
      return out;
    });

    withGlowLayer(ctx, { color: cfg.glow, intensity: glowOf(cfg) * (0.8 + kick * 0.5) }, (g) => {
      g.lineJoin = "round";
      // Outer ring first so the inner rings sit on top.
      for (let j = 2; j >= 0; j--) {
        const ring = rings[j];
        const col = colours[j];
        const rOut = ring.rIn + ring.len;
        const fillG = g.createRadialGradient(cx, cy, safeR(ring.rIn * 0.9), cx, cy, safeR(rOut));
        fillG.addColorStop(0, hexA(col, 0.1));
        fillG.addColorStop(0.65, hexA(col, 0.42 + (j === 2 ? bloom * 0.3 : 0)));
        fillG.addColorStop(1, mixHex(col, "#ffffff", 0.45, 0.7));
        g.fillStyle = fillG;
        g.beginPath();
        for (const pts of petals[j]) smoothPath(g, pts, true, 0.55);
        g.fill();
        g.strokeStyle = hexA(col, 0.9);
        g.lineWidth = Math.max(1, thick * 0.35);
        g.stroke();
      }

      // Treble filigree: thin arcs from the middle ring out to the outer ring.
      if (treble > 0.04) {
        const a1 = angleOf(1);
        const r1 = rings[1].rIn + rings[1].len * 0.55;
        const r2 = rings[2].rIn + rings[2].len * 0.9;
        const rm = (r1 + r2) * 0.5 * (1 + treble * 0.08);
        g.strokeStyle = hexA(cfg.glow, clamp01(treble * 0.9));
        g.lineWidth = Math.max(0.8, thick * 0.16);
        g.beginPath();
        for (let f = 0; f < folds; f++) {
          const a = a1 + f * sector;
          for (let sgn = -1; sgn <= 1; sgn += 2) {
            const am = a + sgn * sector * 0.2;
            const ae = a + sgn * sector * 0.5;
            g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
            g.quadraticCurveTo(
              cx + Math.cos(am) * rm,
              cy + Math.sin(am) * rm,
              cx + Math.cos(ae) * r2,
              cy + Math.sin(ae) * r2,
            );
          }
        }
        g.stroke();
        // Beads on the outer petal tips.
        const a2 = angleOf(2);
        const rt =
          rings[2].rIn + rings[2].len * (0.3 + 0.7 * clamp01(levels[2 * half] * react)) + 4;
        const br = safeR((2 + treble * 5) * size);
        g.fillStyle = `rgba(255,255,255,${clamp01(0.3 + treble * 0.7)})`;
        g.beginPath();
        for (let f = 0; f < folds; f++) {
          const a = a2 + f * sector;
          const x = cx + Math.cos(a) * rt,
            y = cy + Math.sin(a) * rt;
          g.moveTo(x + br, y);
          g.arc(x, y, br, 0, TAU);
        }
        g.fill();
      }

      // Inner polygon turning with the middle ring.
      const a1 = angleOf(1);
      const rp = base * 0.95;
      g.strokeStyle = hexA(cfg.secondary, 0.6);
      g.lineWidth = Math.max(1, thick * 0.25);
      g.beginPath();
      for (let f = 0; f < folds; f++) {
        const a = a1 + f * sector;
        const x = cx + Math.cos(a) * rp,
          y = cy + Math.sin(a) * rp;
        if (f === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();

      // Hub.
      const hubR = safeR(base * (0.5 + kick * 0.3) * 1.8);
      const hub = g.createRadialGradient(cx, cy, 0, cx, cy, hubR);
      hub.addColorStop(0, "rgba(255,255,255,0.95)");
      hub.addColorStop(0.35, hexA(cfg.glow, 0.8));
      hub.addColorStop(1, hexA(cfg.primary, 0));
      g.fillStyle = hub;
      g.beginPath();
      g.arc(cx, cy, hubR, 0, TAU);
      g.fill();
    });
  },
};

export const GROOVE_PRESETS: Preset[] = [
  drumMachine,
  logoShockwave,
  fireworks,
  ledWall,
  polarScope,
  mandala,
];
