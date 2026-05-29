import type { DrawContext } from "./presets";
import type { EffectsConfig } from "../project/types";

const hexA = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

const hexRGB = (hex: string) => {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
};

// Deterministic pseudo-random per index — keeps look stable across re-renders
const rand = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
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

export function drawEffects(d: DrawContext, fx: EffectsConfig) {
  const { ctx, w, h, audio, t } = d;

  if (fx.beatFlash && audio.beat) {
    ctx.fillStyle = `rgba(255,255,255,${0.08})`;
    ctx.fillRect(0, 0, w, h);
  }

  if (fx.particles.enabled) {
    const count = fx.particles.density;
    const speed = fx.particles.speed * (1 + audio.volume * fx.particles.reactivity);
    const type = fx.particles.type;
    const pool = getPool(type, count);
    const baseColor = fx.particles.color;
    const rgb = hexRGB(baseColor);

    for (let i = 0; i < count; i++) {
      const p = pool[i];

      // ───────────────────────────────────────────────────────────────
      // SNOW — gentle downward fall with horizontal sway
      // ───────────────────────────────────────────────────────────────
      if (type === "snow") {
        const fallRange = h + 80;
        const fallSpeed = (40 + Math.abs(p.vy) * 60) * speed; // px/sec
        const y = wrap(p.by * fallRange + p.phaseOffset * fallRange + t * fallSpeed, fallRange) - 40;
        const sway = Math.sin(t * p.driftFreq + p.rot) * p.driftAmp * w;
        const x = wrap(p.bx * w + sway + p.phaseOffset * w, w);
        const size = 2 + p.size * 4;
        const rot = p.rot + t * p.rotSpeed;
        drawSnowflake(ctx, x, y, size, rot, p.shape, hexA(baseColor, fx.particles.opacity * p.alpha), 1);
        continue;
      }

      // ───────────────────────────────────────────────────────────────
      // DUST — tiny slow specks drifting in all directions
      // ───────────────────────────────────────────────────────────────
      if (type === "dust") {
        const vx = p.vx * 15 * speed;
        const vy = p.vy * 12 * speed;
        const x = wrap(p.bx * w + p.phaseOffset * w + t * vx, w);
        const y = wrap(p.by * h + p.phaseOffset * h + t * vy, h);
        const size = 0.6 + p.size * 1.2;
        const tw = 0.5 + 0.5 * Math.sin(t * p.twinkleFreq + p.twinklePhase);
        ctx.fillStyle = hexA(baseColor, fx.particles.opacity * p.alpha * (0.4 + tw * 0.6));
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      // ───────────────────────────────────────────────────────────────
      // SPARKS — bright streaks with trails + warm glow, fast & erratic
      // ───────────────────────────────────────────────────────────────
      if (type === "sparks") {
        const vx = p.vx * 220 * speed;
        const vy = (p.vy * 80 - 90) * speed; // sparks tend to rise/scatter
        const x = wrap(p.bx * w + p.phaseOffset * w + t * vx, w);
        const y = wrap(p.by * h + p.phaseOffset * h + t * vy, h);
        const size = 1 + p.size * 1.5;
        const flick = 0.55 + 0.45 * Math.sin(t * (8 + p.twinkleFreq * 6) + p.twinklePhase);
        const alpha = fx.particles.opacity * p.alpha * flick;
        const len = (8 + p.size * 14) * (1 + audio.volume * 0.6);
        const ang = Math.atan2(vy, vx);
        const tx = x - Math.cos(ang) * len;
        const ty = y - Math.sin(ang) * len;

        // glowing trail
        ctx.save();
        const grad = ctx.createLinearGradient(tx, ty, x, y);
        grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        grad.addColorStop(0.6, `rgba(255,180,80,${alpha * 0.6})`);
        grad.addColorStop(1, `rgba(255,240,200,${alpha})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = size;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();

        // hot core
        ctx.shadowColor = `rgba(255,200,120,${alpha})`;
        ctx.shadowBlur = 12;
        ctx.fillStyle = `rgba(255,245,220,${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, size * 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      // ───────────────────────────────────────────────────────────────
      // BOKEH — large soft out-of-focus orbs
      // ───────────────────────────────────────────────────────────────
      if (type === "bokeh") {
        const vx = p.vx * 12 * speed;
        const vy = p.vy * 10 * speed;
        const x = wrap(p.bx * w + p.phaseOffset * w + t * vx, w);
        const y = wrap(p.by * h + p.phaseOffset * h + t * vy, h);
        const size = 10 + p.size * 22;
        const a = fx.particles.opacity * p.alpha * 0.55;
        const g = ctx.createRadialGradient(x, y, 0, x, y, size);
        g.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`);
        g.addColorStop(0.5, `rgba(${rgb.r},${rgb.g},${rgb.b},${a * 0.35})`);
        g.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      // ───────────────────────────────────────────────────────────────
      // LIGHTS — bright glowing bulbs with halo, pulse on bass
      // ───────────────────────────────────────────────────────────────
      if (type === "lights") {
        const vx = p.vx * 20 * speed;
        const vy = p.vy * 18 * speed;
        const x = wrap(p.bx * w + p.phaseOffset * w + t * vx, w);
        const y = wrap(p.by * h + p.phaseOffset * h + t * vy, h);
        const pulse = 1 + audio.bass * 0.5 + (audio.beat ? 0.2 : 0);
        const twinkle = 0.7 + 0.3 * Math.sin(t * p.twinkleFreq + p.twinklePhase);
        const core = (2 + p.size * 3) * pulse;
        const halo = core * 6;
        const a = fx.particles.opacity * p.alpha * twinkle;

        // halo
        const g = ctx.createRadialGradient(x, y, 0, x, y, halo);
        g.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${a * 0.9})`);
        g.addColorStop(0.3, `rgba(${rgb.r},${rgb.g},${rgb.b},${a * 0.35})`);
        g.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, halo, 0, Math.PI * 2);
        ctx.fill();

        // bright white core
        ctx.fillStyle = `rgba(255,255,255,${Math.min(1, a * 1.4)})`;
        ctx.beginPath();
        ctx.arc(x, y, core, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      // ───────────────────────────────────────────────────────────────
      // DOTS / default
      // ───────────────────────────────────────────────────────────────
      {
        const vx = p.vx * 40 * speed;
        const vy = p.vy * 40 * speed;
        const x = wrap(p.bx * w + p.phaseOffset * w + t * vx, w);
        const y = wrap(p.by * h + p.phaseOffset * h + t * vy, h);
        const size = 1 + p.size * 2;
        ctx.fillStyle = hexA(baseColor, fx.particles.opacity * p.alpha);
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (fx.lensFlare && audio.volume > 0.3) {
    const g = ctx.createRadialGradient(w * 0.8, h * 0.2, 0, w * 0.8, h * 0.2, 300);
    g.addColorStop(0, `rgba(255,240,200,${0.4 * audio.volume})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  if (fx.noise) {
    ctx.save(); ctx.globalAlpha = 0.04;
    for (let i = 0; i < 800; i++) {
      ctx.fillStyle = Math.random() > 0.5 ? "#fff" : "#000";
      ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
    ctx.restore();
  }

  if (fx.vignette) {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.65)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
}
