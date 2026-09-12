// Preset pack: cinematic — light, depth and motion-graphics looks.
// See presets-core.ts for the DrawContext/Preset contract and draw-utils.ts
// for the shared helpers every preset must use.
//
// Every draw() in this file is a pure function of (t, audio, cfg, dt): no
// module-level mutable state, no Math.random / Date / performance.now —
// anything that needs to look random goes through hash1(i, salt). This is
// what lets the Lambda render start on any frame and match the preview.
//
// Glow discipline: all glowing geometry of a preset is drawn inside ONE
// withGlowLayer() call (two at most: a dark drop-shadow layer + a glow
// layer). Never shadowBlur inside a loop.

import type { VisualizerConfig } from "../project/types";
import type { Preset } from "./presets-core";
import {
  TAU, hexA, mixHex, center, bandLevels, hash1, withGlowLayer, smoothPath,
  kickOf, energyOf, kickAgeOf, getGlowSprite, stampGlow, mirroredIndex, clamp01,
} from "./draw-utils";

type Pt = { x: number; y: number };

const frac = (v: number) => v - Math.floor(v);
const reactOf = (cfg: VisualizerConfig) => Math.max(0, cfg.reactivity ?? 1);
/** Radius guard: Canvas throws on negative radii and NaN poisons whole paths. */
const safeR = (r: number, min = 1) => (Number.isFinite(r) ? Math.max(min, r) : min);

/** Optional Path2D (present in every browser we render in; guarded anyway). */
const hasPath2D = () => typeof Path2D === "function";

/** Conic gradient with a graceful fallback for contexts that lack it. */
function conicOrNull(g: CanvasRenderingContext2D, angle: number, x: number, y: number): CanvasGradient | null {
  const ctx = g as CanvasRenderingContext2D & { createConicGradient?: (a: number, x: number, y: number) => CanvasGradient };
  if (typeof ctx.createConicGradient !== "function") return null;
  try { return ctx.createConicGradient(angle, x, y); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. God Rays — volumetric light beams from a central sun.
//    One glow layer, ONE shared linear gradient reused per beam via
//    rotate + scale(len, 1); the sun disc and logo occluder are drawn after.
// ─────────────────────────────────────────────────────────────────────────
const godRays: Preset = {
  id: "god-rays", name: "God Rays", category: "Ambient",
  description: "Volumetric light beams fan out from a sun that flares on every kick — the bass beams reach furthest.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    // Multiple of 4 so the two mirrored halves (bass top + bottom) divide cleanly.
    const beams = Math.max(12, Math.min(160, Math.round((cfg.bandCount || 48) / 4) * 4));
    const half = beams / 2;
    const bands = half / 2;
    const levels = bandLevels(audio.freq, bands, 0.8, cfg, audio);
    const kick = kickOf(audio);
    const bass = clamp01(audio.bass * react);
    const flash = 1 + kick * 0.6 * react;
    const rot = cfg.rotation + t * 0.06;
    const sunR = safeR(Math.min(w, h) * 0.075 * cfg.size * (1 + (kick * 0.35 + audio.bass * 0.15) * react), 4);
    // Beams never need to reach past the farthest canvas corner — every pixel
    // beyond it is wasted raster (this is the single biggest cost here).
    const corner = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) + 20;
    const maxLen = Math.max(sunR, Math.min(Math.max(w, h) * 0.62 * cfg.size, corner - sunR * 0.8));
    const slice = TAU / beams;
    const tanHalf = Math.tan(slice * (0.16 + bass * 0.26)); // ≤ 42 % of a slice: beams never fuse into a disc
    const root = Math.max(2, sunR * 0.35);

    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * (0.9 + kick * 0.6) }, (g) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(rot);
      g.globalCompositeOperation = "lighter";
      // One gradient in unit space (x 0..1); each beam scales it to its own length.
      const grad = g.createLinearGradient(0, 0, 1, 0);
      grad.addColorStop(0, "rgba(255,255,255,0.7)");
      grad.addColorStop(0.1, hexA(cfg.primary, 0.8));
      grad.addColorStop(0.5, hexA(cfg.accent, 0.4));
      grad.addColorStop(1, hexA(cfg.accent, 0));
      g.fillStyle = grad;
      for (let i = 0; i < beams; i++) {
        const lv = Math.pow(clamp01(levels[mirroredIndex(i % half, half)] * react), 1.4);
        const len = sunR * 0.8 + maxLen * (0.22 + 0.78 * lv);
        const tip = tanHalf * len;
        g.globalAlpha = clamp01((0.2 + 0.55 * lv) * flash);
        g.save();
        g.rotate(-Math.PI + i * slice);
        g.scale(len, 1);
        g.beginPath();
        g.moveTo(0, -root / len);
        g.lineTo(1, -tip);
        g.lineTo(1, tip);
        g.lineTo(0, root / len);
        g.closePath();
        g.fill();
        g.restore();
      }
      g.restore();
    });

    // Sun disc (white-hot core → glow → accent → transparent).
    const sunOuter = safeR(sunR * 2.4);
    const sun = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunOuter);
    sun.addColorStop(0, "rgba(255,255,255,1)");
    sun.addColorStop(0.22, hexA(cfg.glow, 0.95));
    sun.addColorStop(0.45, hexA(cfg.accent, 0.4));
    sun.addColorStop(1, hexA(cfg.accent, 0));
    ctx.fillStyle = sun;
    ctx.beginPath(); ctx.arc(cx, cy, sunOuter, 0, TAU); ctx.fill();

    // Dark occluder behind the logo so the rays read as coming from behind it.
    if (d.logo) {
      const lx = w / 2 + cfg.logoPosition.x * w / 2;
      const ly = h / 2 + cfg.logoPosition.y * h / 2 + (d.logoFx?.hop ?? 0);
      const lr = safeR(Math.min(w, h) * cfg.logoSize * 0.5 * (d.logoFx?.scale ?? 1) * 1.1, 2);
      const occ = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
      occ.addColorStop(0, "rgba(0,0,0,0.85)");
      occ.addColorStop(0.8, "rgba(0,0,0,0.8)");
      occ.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = occ;
      ctx.beginPath(); ctx.arc(lx, ly, lr, 0, TAU); ctx.fill();
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 2. Hyperdrive — starfield warp. Star (px, py, z0) from hash1; z = frac(z0 −
//    t·0.12) so every frame is pure in t. All strokes in one glow layer.
// ─────────────────────────────────────────────────────────────────────────
const hyperdrive: Preset = {
  id: "hyperdrive", name: "Hyperdrive", category: "3D",
  description: "A starfield warp jump — streaks stretch with the bass and every kick flashes the star cores white.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const count = Math.max(80, Math.min(800, Math.round((cfg.bandCount || 48) * 4)));
    const f = 0.6 * Math.min(w, h) * cfg.size;
    const kick = kickOf(audio);
    const treble = clamp01(audio.treble * 1.6);
    const stretch = 0.02 + (audio.bass * 0.09 + kick * 0.12) * react;
    const thick = Math.max(1, cfg.thickness);
    const spread = 0.85;
    // Anything further than the farthest corner is off-canvas whatever the rotation.
    const rOut = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) + 60;

    // Faint warp core at the vanishing point (drawn under the streaks).
    const coreR = safeR(Math.min(w, h) * 0.22 * cfg.size);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, hexA(cfg.primary, 0.28 + kick * 0.3 * react));
    core.addColorStop(0.5, hexA(cfg.accent, 0.1));
    core.addColorStop(1, hexA(cfg.accent, 0));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, TAU); ctx.fill();

    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * (0.7 + kick * 0.5) }, (g) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(cfg.rotation);
      g.lineCap = "round";
      const cores = kick > 0.04 && hasPath2D() ? new Path2D() : null;
      for (let i = 0; i < count; i++) {
        const px = (hash1(i, 1) * 2 - 1) * spread;
        const py = (hash1(i, 2) * 2 - 1) * spread;
        if (Math.abs(px) < 0.03 && Math.abs(py) < 0.03) continue; // never parked on the vanishing point
        // z^1.5 keeps the cycle monotonic (still pure in t) but lets stars spend
        // more of it close to the camera, where the streaks are.
        const z = Math.max(0.012, Math.pow(frac(hash1(i, 3) - t * 0.12), 1.6));
        const hx = px * f / z, hy = py * f / z;
        if (Math.hypot(hx, hy) > rOut) continue;
        const zt = z + stretch * (0.35 + z);
        const tx = px * f / zt, ty = py * f / zt;
        const depth = 1 - z; // 0 far → 1 near
        const tw = 0.7 + 0.3 * Math.sin(t * (7 + hash1(i, 4) * 9) + hash1(i, 5) * TAU) * treble;
        g.strokeStyle = mixHex(cfg.primary, cfg.accent, z, clamp01((0.35 + depth * 0.65) * tw));
        g.lineWidth = Math.max(1.5, thick * (0.5 + depth * depth * 2.0));
        g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.stroke();
        if (cores && depth > 0.35) {
          cores.moveTo(tx + (hx - tx) * 0.6, ty + (hy - ty) * 0.6);
          cores.lineTo(hx, hy);
        }
      }
      if (cores) {
        g.strokeStyle = `rgba(255,255,255,${clamp01(kick * 0.9)})`;
        g.lineWidth = thick * 0.55;
        g.stroke(cores);
      }
      g.restore();
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 3. Comet Trails — comets on elliptical orbits; tails are the orbit
//    re-evaluated at t − k·step. Glow sprites under "lighter": no arcs, no
//    shadows. A single glow layer only when glowIntensity > 1.
// ─────────────────────────────────────────────────────────────────────────
const cometTrails: Preset = {
  id: "comet-trails", name: "Comet Trails", category: "Particles",
  description: "A swarm of comets circling your logo — each tail stretches with its own band and the heads flare on the kick.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const n = Math.max(24, Math.min(96, Math.round(cfg.bandCount || 48)));
    const levels = bandLevels(audio.freq, n, 0.8, cfg, audio);
    const kick = kickOf(audio);
    const energy = energyOf(audio);
    const R = Math.min(w, h) * 0.34 * cfg.size * (1 + (audio.bass * 0.14 + kick * 0.08) * react);
    const sprites = [
      getGlowSprite(cfg.primary, 64, 0.16),
      getGlowSprite(cfg.accent, 64, 0.16),
      getGlowSprite(cfg.secondary, 64, 0.16),
    ];
    const headBase = (12 + cfg.thickness * 2.2) * cfg.size;
    const flare = 1 + kick * 0.7 * react;
    // Tail samples are spaced ~0.3 head diameters apart along the orbit (always
    // less than the smallest tail stamp) so they overlap into a continuous
    // streak; energy stretches the spacing a little.
    const tailStretch = 0.3 * (1 + energy * 0.5 * react);

    const paint = (g: CanvasRenderingContext2D) => {
      g.save();
      g.globalCompositeOperation = "lighter";
      for (let i = 0; i < n; i++) {
        const rr = R * (0.38 + hash1(i, 1) * 0.72);
        const e = 0.42 + hash1(i, 2) * 0.58;
        const tilt = hash1(i, 3) * TAU + cfg.rotation;
        const speed = (0.45 + hash1(i, 4) * 0.9) * (hash1(i, 5) < 0.3 ? -1 : 1);
        const phase = hash1(i, 6) * TAU;
        const pick = hash1(i, 7);
        const sprite = sprites[pick < 0.5 ? 0 : pick < 0.8 ? 1 : 2];
        const v = clamp01(levels[i] * react);
        const K = Math.round(5 + v * 11);
        const headD = headBase * (1 + v * 1.2) * flare;
        const step = Math.max(0.016, (headD * tailStretch) / Math.max(1e-3, Math.abs(speed) * rr));
        const ct = Math.cos(tilt), st = Math.sin(tilt);
        for (let k = K; k >= 0; k--) {
          const th = phase + speed * (t - k * step);
          const ox = Math.cos(th) * rr, oy = Math.sin(th) * rr * e;
          const x = cx + ox * ct - oy * st;
          const y = cy + ox * st + oy * ct;
          const fade = 1 - k / (K + 1);
          const dia = k === 0 ? headD : headD * (0.5 + 0.45 * fade);
          const alpha = k === 0 ? 0.95 : 0.6 * fade * Math.sqrt(fade);
          stampGlow(g, sprite, x, y, dia, alpha);
        }
      }
      g.restore();
    };

    if (cfg.glowIntensity > 1) {
      withGlowLayer(ctx, { color: cfg.glow, intensity: (cfg.glowIntensity - 1) * 0.8 }, paint);
    } else {
      paint(ctx);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 4. Liquid Chrome — thick polished ring. Outer + inner contour filled as one
//    even-odd path with a rotating conic "chrome" gradient and a second conic
//    specular wedge. Two layers: dark drop shadow + glow rim.
// ─────────────────────────────────────────────────────────────────────────
/** One chrome cycle: white / primary / dark (held) / accent / light. Uneven
 *  spacing gives the hard "horizon" bands polished metal has. */
const CHROME_CYCLE = (cfg: VisualizerConfig): [number, string][] => [
  [0, "#ffffff"], [0.18, cfg.primary], [0.42, "#101014"], [0.5, "#101014"], [0.62, cfg.accent], [0.85, "#e8e8ee"],
];

const liquidChrome: Preset = {
  id: "liquid-chrome", name: "Liquid Chrome", category: "Morph",
  description: "A thick polished chrome ring that ripples with the spectrum, swells on the bass and catches a rolling highlight.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const N = 64;
    const levels = bandLevels(audio.freq, N / 2, 0.8, cfg, audio);
    const kick = kickOf(audio);
    const treble = clamp01(audio.treble);
    const R = Math.min(w, h) * 0.26 * cfg.size * (1 + kick * 0.07 * react);
    const amp = Math.min(w, h) * 0.09 * cfg.size * react;
    const T = Math.max(6, (16 + cfg.thickness * 6) * cfg.size * (0.8 + audio.bass * 0.8 * react));

    const outer: Pt[] = new Array(N);
    const inner: Pt[] = new Array(N);
    for (let i = 0; i < N; i++) {
      // -π/2 offset: mirroredIndex puts band 0 (bass) at i = N/2 → bottom of the ring.
      const a = (i / N) * TAU - Math.PI / 2 + cfg.rotation;
      const v = clamp01(levels[mirroredIndex(i, N)]);
      const ripple = Math.sin(a * 9 - t * 6) * treble * 7 * react + Math.sin(a * 3 + t * 1.3) * 5 * cfg.size;
      const ro = safeR(R + v * amp + ripple, T + 6);
      const ri = safeR(ro - T * (0.85 + v * 0.3), 3);
      const c = Math.cos(a), s = Math.sin(a);
      outer[i] = { x: cx + c * ro, y: cy + s * ro };
      inner[i] = { x: cx + c * ri, y: cy + s * ri };
    }
    const ringPath = (g: CanvasRenderingContext2D) => {
      g.beginPath();
      smoothPath(g, outer, true, 0.5);
      smoothPath(g, inner, true, 0.5);
    };

    // Layer 1: soft dark drop shadow under the ring.
    withGlowLayer(ctx, { color: "#000000", intensity: 1.4, offsetY: 18, alpha: 0.75 }, (g) => {
      ringPath(g);
      g.fillStyle = "rgba(0,0,0,0.9)";
      g.fill("evenodd");
    });

    // Layer 2: chrome body + specular + rim lines, glowing.
    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * 0.7 }, (g) => {
      const rot = cfg.rotation + t * 0.25;
      const cycle = CHROME_CYCLE(cfg);
      const cycles = 3;
      let chrome = conicOrNull(g, rot, cx, cy);
      if (!chrome) {
        const dx = Math.cos(rot) * R, dy = Math.sin(rot) * R;
        chrome = g.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
      }
      for (let c = 0; c < cycles; c++) {
        for (const [pos, col] of cycle) chrome.addColorStop((c + pos) / cycles, col);
      }
      chrome.addColorStop(1, "#ffffff");
      ringPath(g);
      g.fillStyle = chrome;
      g.fill("evenodd");

      // Specular sweep: a 20° white wedge rotating the other way.
      const specAngle = cfg.rotation - t * 0.9;
      const wedge = 20 / 360;
      let spec = conicOrNull(g, specAngle, cx, cy);
      if (spec) {
        spec.addColorStop(0, "rgba(255,255,255,0)");
        spec.addColorStop(wedge * 0.5, "rgba(255,255,255,0.85)");
        spec.addColorStop(wedge, "rgba(255,255,255,0)");
        spec.addColorStop(1, "rgba(255,255,255,0)");
      } else {
        // Fallback: a straight highlight band sweeping across the ring.
        const dx = Math.cos(specAngle) * R * 1.3, dy = Math.sin(specAngle) * R * 1.3;
        spec = g.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
        spec.addColorStop(0.42, "rgba(255,255,255,0)");
        spec.addColorStop(0.5, "rgba(255,255,255,0.8)");
        spec.addColorStop(0.58, "rgba(255,255,255,0)");
      }
      g.fillStyle = spec;
      g.fill("evenodd");

      // Rim lines: light outer edge, dark inner edge.
      g.lineWidth = Math.max(1, cfg.thickness * 0.35);
      g.strokeStyle = "rgba(255,255,255,0.45)";
      g.beginPath(); smoothPath(g, outer, true, 0.5); g.stroke();
      g.strokeStyle = "rgba(0,0,0,0.55)";
      g.beginPath(); smoothPath(g, inner, true, 0.5); g.stroke();
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 5. Laser Floor — synthwave perspective grid with kick sweeps, band-lit
//    front tiles and a striped setting sun. One glow layer.
// ─────────────────────────────────────────────────────────────────────────
const laserFloor: Preset = {
  id: "laser-floor", name: "Laser Floor", category: "Retro",
  description: "A synthwave laser grid rushing under a striped sun — every kick fires a bright line from the horizon straight at you.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const react = reactOf(cfg);
    const cx = w / 2 + cfg.position.x * w / 2;
    const horizonY = h * 0.55 + cfg.position.y * h * 0.2;
    const floorH = Math.max(1, h - horizonY);
    const kick = kickOf(audio);
    const bass = clamp01(audio.bass);
    // Even column count so mirroredIndex puts the bass tiles in the middle lane.
    const cols = Math.max(12, Math.min(48, Math.round((cfg.bandCount || 48) / 4) * 2));
    const levels = bandLevels(audio.freq, cols / 2, 0.75, cfg, audio);
    const spreadW = w * 1.6 * cfg.size;
    const thick = Math.max(1, cfg.thickness);
    const xAt = (i: number, y: number) => cx + (i / cols - 0.5) * spreadW * ((y - horizonY) / floorH);
    const yAtZ = (z: number) => horizonY + floorH * Math.pow(clamp01(z), 2.2);
    const sunR = safeR(Math.min(w, h) * 0.2 * cfg.size * (1 + bass * 0.18 * react), 4);
    const sunCy = horizonY - sunR * 0.28;

    // Horizon haze (under everything, shows through the sun stripes).
    const haze = ctx.createLinearGradient(0, horizonY - h * 0.16, 0, horizonY + h * 0.14);
    haze.addColorStop(0, hexA(cfg.accent, 0));
    haze.addColorStop(0.5, hexA(cfg.accent, 0.3 + kick * 0.15));
    haze.addColorStop(1, hexA(cfg.primary, 0));
    ctx.fillStyle = haze;
    ctx.fillRect(0, horizonY - h * 0.16, w, h * 0.3);

    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * (0.9 + kick * 0.4) }, (g) => {
      // Sun: vertical gradient disc clipped above the horizon, striped via destination-out.
      g.save();
      g.beginPath(); g.rect(0, 0, w, horizonY); g.clip();
      const sunGrad = g.createLinearGradient(0, sunCy - sunR, 0, sunCy + sunR);
      sunGrad.addColorStop(0, hexA(cfg.accent, 0.95));
      sunGrad.addColorStop(0.55, hexA(cfg.primary, 0.9));
      sunGrad.addColorStop(1, hexA(cfg.secondary, 0.9));
      g.fillStyle = sunGrad;
      g.beginPath(); g.arc(cx, sunCy, sunR, 0, TAU); g.fill();
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = "rgba(0,0,0,1)";
      const stripeTop = sunCy - sunR * 0.45;
      const stripeSpacing = sunR * 0.1;
      const drift = frac(t * 0.12) * stripeSpacing;
      for (let k = -1; k < 16; k++) {
        const y = stripeTop + k * stripeSpacing + drift;
        const p = clamp01((y - stripeTop) / (sunR * 0.75)); // thicker toward the horizon
        const th = sunR * (0.006 + 0.05 * p);
        if (y + th < stripeTop || y > sunCy + sunR) continue;
        g.fillRect(cx - sunR - 2, y, sunR * 2 + 4, th);
      }
      g.restore();

      // Front-row tiles lit by the spectrum.
      const yA = yAtZ(0.55);
      const yB = h + 2;
      const tileP = g.createLinearGradient(0, yB, 0, yA);
      tileP.addColorStop(0, hexA(cfg.primary, 0.85)); tileP.addColorStop(1, hexA(cfg.primary, 0));
      const tileA = g.createLinearGradient(0, yB, 0, yA);
      tileA.addColorStop(0, hexA(cfg.accent, 0.85)); tileA.addColorStop(1, hexA(cfg.accent, 0));
      for (let c = 0; c < cols; c++) {
        const v = clamp01(levels[mirroredIndex(c, cols)] * react);
        if (v < 0.03) continue;
        g.globalAlpha = clamp01(v * 0.9);
        g.fillStyle = c % 2 ? tileP : tileA;
        g.beginPath();
        g.moveTo(xAt(c, yA), yA);
        g.lineTo(xAt(c + 1, yA), yA);
        g.lineTo(xAt(c + 1, yB), yB);
        g.lineTo(xAt(c, yB), yB);
        g.closePath();
        g.fill();
      }
      g.globalAlpha = 1;

      // Horizon line.
      g.strokeStyle = hexA(cfg.accent, 0.9);
      g.lineWidth = Math.max(1.5, thick * 0.8);
      g.beginPath(); g.moveTo(0, horizonY); g.lineTo(w, horizonY); g.stroke();

      // Vertical lines converging on the vanishing point (one path).
      g.strokeStyle = hexA(cfg.primary, 0.7);
      g.lineWidth = Math.max(1.2, thick * 0.6);
      g.beginPath();
      for (let i = 0; i <= cols; i++) {
        g.moveTo(cx, horizonY);
        g.lineTo(xAt(i, h + 40), h + 40);
      }
      g.stroke();

      // Horizontal lines racing toward the camera.
      for (let k = 0; k < 15; k++) {
        const z = frac(k / 15 + t * 0.25);
        const y = yAtZ(z);
        g.strokeStyle = hexA(cfg.primary, 0.18 + 0.75 * z);
        g.lineWidth = Math.max(1.2, thick * (0.3 + z * 1.0));
        g.beginPath(); g.moveTo(xAt(0, y), y); g.lineTo(xAt(cols, y), y); g.stroke();
      }

      // Kick sweeps: the latest kick plus a fading echo one beat older.
      const age = kickAgeOf(audio);
      const travel = 0.8;
      for (let s = 0; s < 2; s++) {
        const a = age + s * 0.45;
        if (!Number.isFinite(a)) break;
        const z = a / travel;
        if (z < 0 || z >= 1) continue;
        const y = yAtZ(z);
        const strength = (1 - z * 0.35) * (s === 0 ? 1 : 0.5);
        g.strokeStyle = hexA(cfg.accent, strength);
        g.lineWidth = thick * (0.7 + z * 2.4);
        g.beginPath(); g.moveTo(xAt(0, y), y); g.lineTo(xAt(cols, y), y); g.stroke();
        g.strokeStyle = `rgba(255,255,255,${clamp01(strength * 0.8)})`;
        g.lineWidth = thick * (0.3 + z * 0.9);
        g.beginPath(); g.moveTo(xAt(0, y), y); g.lineTo(xAt(cols, y), y); g.stroke();
      }
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 6. Gyro Rings — three rings tumbling around different axes (rotate +
//    scale(1, cos)), each bent by a third of the spectrum. One glow layer.
// ─────────────────────────────────────────────────────────────────────────
function segmentHit(a: Pt, b: Pt, c: Pt, e: Pt): Pt | null {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = e.x - c.x, sy = e.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c.x - a.x, qy = c.y - a.y;
  const u = (qx * sy - qy * sx) / den;
  const v = (qx * ry - qy * rx) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { x: a.x + rx * u, y: a.y + ry * u };
}

const gyroRings: Preset = {
  id: "gyro-rings", name: "Gyro Rings", category: "3D",
  description: "Three gyroscope rings tumbling in 3D — lows, mids and highs each bend their own ring, and sparks fly where they cross.",
  draw: (d) => {
    const { ctx, w, h, cfg, audio, t } = d;
    const { cx, cy } = center(d);
    const react = reactOf(cfg);
    const S = Math.max(48, Math.min(192, Math.round((cfg.bandCount || 48) / 2) * 4));
    const perRing = S / 2;
    const levels = bandLevels(audio.freq, perRing * 3, 0.85, cfg, audio);
    const kick = kickOf(audio);
    const energy = energyOf(audio);
    const treble = clamp01(audio.treble * react);
    const base = Math.min(w, h) * 0.2 * cfg.size;
    const thick = Math.max(1, cfg.thickness);
    const colours = [cfg.primary, cfg.accent, cfg.secondary];

    // Screen-space polylines (rotate + scale(1, cos) applied by hand so the
    // same points feed the ring strokes AND the intersection sparkles).
    const rings: Pt[][] = [];
    const nearFar: { nx: number; ny: number; fx: number; fy: number }[] = [];
    for (let j = 0; j < 3; j++) {
      const Rj = base * (1 + j * 0.18) * (1 + kick * 0.08 * react);
      const spin = t * (0.5 + j * 0.35) + energy * 1.6 * react + j * 2.1;
      const tilt = cfg.rotation + j * 1.05 + t * (0.12 + j * 0.05);
      const sq = Math.cos(spin);
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const ring: Pt[] = new Array(S);
      for (let s = 0; s < S; s++) {
        const a = (s / S) * TAU;
        const v = clamp01(levels[j * perRing + mirroredIndex(s, S)] * react);
        const r = Rj + v * base * (0.35 + j * 0.15);
        const lx = Math.cos(a) * r, ly = Math.sin(a) * r * sq;
        ring[s] = { x: cx + lx * ct - ly * st, y: cy + lx * st + ly * ct };
      }
      rings.push(ring);
      const fy = -Rj * sq, ny = Rj * sq;
      nearFar.push({ nx: cx - ny * st, ny: cy + ny * ct, fx: cx - fy * st, fy: cy + fy * ct });
    }

    // Sparkles where rings cross (capped).
    const hits: Pt[] = [];
    if (treble > 0.08) {
      outer: for (let p = 0; p < 3; p++) {
        const A = rings[p], B = rings[(p + 1) % 3];
        for (let i = 0; i < S; i++) {
          const a0 = A[i], a1 = A[(i + 1) % S];
          for (let k = 0; k < S; k++) {
            const hit = segmentHit(a0, a1, B[k], B[(k + 1) % S]);
            if (hit) { hits.push(hit); if (hits.length >= 24) break outer; }
          }
        }
      }
    }

    withGlowLayer(ctx, { color: cfg.glow, intensity: cfg.glowIntensity * (0.8 + kick * 0.5) }, (g) => {
      // Centre pivot.
      const pr = safeR(base * 0.22 * (1 + kick * 0.5 * react));
      const pivot = g.createRadialGradient(cx, cy, 0, cx, cy, pr);
      pivot.addColorStop(0, hexA(cfg.glow, 0.9));
      pivot.addColorStop(0.4, hexA(cfg.primary, 0.35));
      pivot.addColorStop(1, hexA(cfg.primary, 0));
      g.fillStyle = pivot;
      g.beginPath(); g.arc(cx, cy, pr, 0, TAU); g.fill();

      g.lineJoin = "round";
      for (let j = 0; j < 3; j++) {
        const ring = rings[j];
        const nf = nearFar[j];
        const col = colours[j];
        // Depth cue: the near half of the ring is bright, the far half dims.
        let grad: CanvasGradient;
        if (Math.hypot(nf.nx - nf.fx, nf.ny - nf.fy) < 1) {
          grad = g.createLinearGradient(cx - 1, cy, cx + 1, cy);
          grad.addColorStop(0, hexA(col, 0.9)); grad.addColorStop(1, hexA(col, 0.9));
        } else {
          grad = g.createLinearGradient(nf.fx, nf.fy, nf.nx, nf.ny);
          grad.addColorStop(0, hexA(col, 0.32));
          grad.addColorStop(1, hexA(col, 1));
        }
        g.strokeStyle = grad;
        g.lineWidth = Math.max(1.5, thick * (2.2 - j * 0.35));
        g.beginPath();
        for (let s = 0; s < S; s++) {
          const p = ring[s];
          if (s === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        }
        g.closePath();
        g.stroke();
      }

      // Treble sparkles at the crossings.
      if (hits.length) {
        const size = (10 + treble * 28) * cfg.size + kick * 6;
        const halo = hexA(cfg.glow, clamp01(0.25 + treble * 0.5));
        const star = mixHex(cfg.glow, "#ffffff", 0.7, clamp01(0.5 + treble * 0.8));
        for (const p of hits) {
          g.fillStyle = halo;
          g.beginPath(); g.arc(p.x, p.y, size * 0.7, 0, TAU); g.fill();
          g.fillStyle = star;
          g.beginPath();
          g.moveTo(p.x, p.y - size);
          g.quadraticCurveTo(p.x, p.y, p.x + size, p.y);
          g.quadraticCurveTo(p.x, p.y, p.x, p.y + size);
          g.quadraticCurveTo(p.x, p.y, p.x - size, p.y);
          g.quadraticCurveTo(p.x, p.y, p.x, p.y - size);
          g.fill();
        }
      }
      g.lineJoin = "miter";
    });
  },
};

export const CINEMATIC_PRESETS: Preset[] = [godRays, hyperdrive, cometTrails, liquidChrome, laserFloor, gyroRings];
