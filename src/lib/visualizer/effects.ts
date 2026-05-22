import type { DrawContext } from "./presets";
import type { EffectsConfig } from "../project/types";

const hexA = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

export function drawEffects(d: DrawContext, fx: EffectsConfig) {
  const { ctx, w, h, audio, t } = d;

  if (fx.beatFlash && audio.beat) {
    ctx.fillStyle = `rgba(255,255,255,${0.08})`;
    ctx.fillRect(0, 0, w, h);
  }

  if (fx.particles.enabled) {
    const c = fx.particles.density;
    const sp = fx.particles.speed * (1 + audio.volume * fx.particles.reactivity);
    for (let i = 0; i < c; i++) {
      const seed = i * 13.37;
      let x = ((seed * 97 + t * 40 * sp) % w + w) % w;
      let y = ((seed * 61 + t * 60 * sp) % h + h) % h;
      const size = fx.particles.type === "bokeh" ? 6 + Math.sin(seed) * 4 : 1 + (Math.sin(seed) + 1) * 1.5;
      let col = fx.particles.color;
      if (fx.particles.type === "snow") y = ((seed * 61 + t * 80 * sp) % h + h) % h;
      if (fx.particles.type === "sparks") { x = ((seed * 97 + t * 200 * sp) % w + w) % w; col = "#ffd27a"; }
      ctx.fillStyle = hexA(col, fx.particles.opacity);
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
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
