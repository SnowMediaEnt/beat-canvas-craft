import type { DrawContext } from "./presets";
import type { EffectsConfig } from "../project/types";

const hexA = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

// Deterministic pseudo-random per index — keeps look stable across re-renders
const rand = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

type Particle = {
  bx: number; by: number;      // base position (0-1)
  vx: number; vy: number;      // velocity multiplier
  size: number;                // size multiplier
  rot: number;                 // rotation phase
  rotSpeed: number;
  driftAmp: number;            // horizontal sway amplitude
  driftFreq: number;
  shape: number;               // 0-3 for snowflake variants
  alpha: number;
  hueShift: number;
};

// Cache particle pools so changing density/speed doesn't reshuffle existing ones
const pools = new Map<string, Particle[]>();
function getPool(type: string, count: number): Particle[] {
  let pool = pools.get(type);
  if (!pool) { pool = []; pools.set(type, pool); }
  while (pool.length < count) {
    const i = pool.length;
    pool.push({
      bx: rand(i, 1),
      by: rand(i, 2),
      vx: (rand(i, 3) - 0.5) * 0.4,
      vy: 0.4 + rand(i, 4) * 0.8,
      size: 0.4 + rand(i, 5) * 1.8,
      rot: rand(i, 6) * Math.PI * 2,
      rotSpeed: (rand(i, 7) - 0.5) * 1.2,
      driftAmp: 0.02 + rand(i, 8) * 0.08,
      driftFreq: 0.3 + rand(i, 9) * 1.5,
      shape: Math.floor(rand(i, 10) * 4),
      alpha: 0.5 + rand(i, 11) * 0.5,
      hueShift: (rand(i, 12) - 0.5) * 40,
    });
  }
  return pool;
}

// Accumulated phase keeps motion smooth when speed slider changes
const phaseState = { last: 0, x: 0, y: 0, spark: 0 };

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
    // 6-arm star flake
    for (let i = 0; i < 6; i++) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -size * 2);
      ctx.stroke();
      // small branches
      ctx.beginPath();
      ctx.moveTo(0, -size * 1.2);
      ctx.lineTo(size * 0.5, -size * 1.6);
      ctx.moveTo(0, -size * 1.2);
      ctx.lineTo(-size * 0.5, -size * 1.6);
      ctx.stroke();
    }
  } else if (shape === 1) {
    // Solid round
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === 2) {
    // 4-point sparkle
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
    // Hexagon
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

    // Integrate phase using dt so changing `speed` doesn't snap positions
    const dt = Math.min(0.1, Math.max(0, t - phaseState.last));
    phaseState.last = t;
    phaseState.x += dt * 40 * speed;
    phaseState.y += dt * 60 * speed;
    phaseState.spark += dt * 200 * speed;

    const pool = getPool(type, count);
    const baseColor = fx.particles.color;

    for (let i = 0; i < count; i++) {
      const p = pool[i];
      let x: number, y: number, size: number, col = baseColor;

      if (type === "snow") {
        const fallSpeed = phaseState.y * p.vy;
        y = ((p.by * h + fallSpeed) % (h + 40) + h + 40) % (h + 40) - 20;
        const sway = Math.sin(t * p.driftFreq + p.rot) * p.driftAmp * w;
        x = ((p.bx * w + phaseState.x * p.vx + sway) % w + w) % w;
        size = 2 + p.size * 4;
        const rot = p.rot + t * p.rotSpeed;
        drawSnowflake(ctx, x, y, size, rot, p.shape, hexA(baseColor, fx.particles.opacity * p.alpha), 1);
        continue;
      } else if (type === "sparks") {
        x = ((p.bx * w + phaseState.spark * p.vx * 2) % w + w) % w;
        y = ((p.by * h + phaseState.y * p.vy * 0.5) % h + h) % h;
        size = 1 + p.size * 1.5;
        col = "#ffd27a";
      } else if (type === "bokeh") {
        x = ((p.bx * w + phaseState.x * p.vx * 0.3) % w + w) % w;
        y = ((p.by * h + phaseState.y * p.vy * 0.3) % h + h) % h;
        size = 4 + p.size * 8;
      } else {
        // dots / default
        x = ((p.bx * w + phaseState.x * p.vx) % w + w) % w;
        y = ((p.by * h + phaseState.y * p.vy) % h + h) % h;
        size = 1 + p.size * 2;
      }

      ctx.fillStyle = hexA(col, fx.particles.opacity * p.alpha);
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
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
