import { memo, useEffect, useRef } from "react";
import type { VisualizerConfig } from "@/lib/project/types";
import { drawVisualizerLayer, RENDER_BASELINE_HEIGHT } from "@/lib/visualizer/render-shared";
import { syntheticAudio, THUMBNAIL_AUDIO_TIME } from "@/lib/visualizer/preview-audio";
import { hexA } from "@/lib/visualizer/draw-utils";

interface Props {
  presetId: string;
  cfg: VisualizerConfig;
  /** Backing-store size of the thumbnail (CSS size fills the parent at 16:9). */
  width?: number;
  height?: number;
  /** Animate with synthetic music while true (e.g. on hover). */
  animate?: boolean;
  className?: string;
}

const THUMB_DPR_CAP = 1.5;

/** Config tweaks so every preset reads well at thumbnail size. */
function thumbConfig(cfg: VisualizerConfig, presetId: string): VisualizerConfig {
  return {
    ...cfg,
    presetId,
    blur: 0,
    border: 0,
    movement: 0,
    stationary: true,
    shadow: Math.min(cfg.shadow ?? 0, 0.3),
    // Glow at full strength washes out a 160px tile.
    glowIntensity: Math.min(cfg.glowIntensity ?? 0.8, 0.9),
  };
}

function paint(canvas: HTMLCanvasElement, cfg: VisualizerConfig, t: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.shadowBlur = 0;
  // Backdrop: near-black with a soft tint wash so glows have something to sit on.
  ctx.fillStyle = "#050308";
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w * 0.5, h * 0.55, 0, w * 0.5, h * 0.55, Math.max(w, h) * 0.75);
  g.addColorStop(0, hexA(cfg.backgroundTint || "#0a0612", 0.55));
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const scale = h / RENDER_BASELINE_HEIGHT;
  ctx.save();
  ctx.scale(scale, scale);
  try {
    drawVisualizerLayer({
      ctx,
      w: w / scale,
      h: h / scale,
      cfg,
      audio: syntheticAudio(t, { energy: 0.85 }),
      t,
    });
  } catch {
    // A broken preset should never take the picker down.
  } finally {
    ctx.restore();
  }
}

export const PresetThumb = memo(function PresetThumb({ presetId, cfg, width = 192, height = 108, animate = false, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const thumbCfg = thumbConfig(cfg, presetId);
  // Only re-render when something that changes the LOOK changes.
  const lookKey = JSON.stringify([
    presetId, cfg.primary, cfg.secondary, cfg.accent, cfg.glow, cfg.backgroundTint,
    cfg.size, cfg.thickness, cfg.bandCount, cfg.rotation, cfg.position, cfg.glowIntensity, cfg.custom,
  ]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(THUMB_DPR_CAP, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    paint(canvas, thumbCfg, THUMBNAIL_AUDIO_TIME);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookKey, width, height]);

  useEffect(() => {
    if (!animate) return;
    const canvas = ref.current;
    if (!canvas) return;
    let raf = 0;
    const start = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = THUMBNAIL_AUDIO_TIME + (performance.now() - start) / 1000;
      paint(canvas, thumbCfg, t);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      paint(canvas, thumbCfg, THUMBNAIL_AUDIO_TIME);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, lookKey]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width: "100%", aspectRatio: `${width} / ${height}`, display: "block" }}
      aria-hidden
    />
  );
});
