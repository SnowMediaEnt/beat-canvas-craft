import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/project/types";
import { AudioEngine, type AudioData } from "@/lib/visualizer/audioEngine";
import { drawForegroundLayers } from "@/lib/visualizer/render-shared";

const ratioToWH = (r: string) => {
  switch (r) {
    case "1:1": return { w: 1080, h: 1080 };
    case "9:16": return { w: 1080, h: 1920 };
    case "4:5": return { w: 1080, h: 1350 };
    default: return { w: 1920, h: 1080 };
  }
};

const PREVIEW_DPR_CAP = 1.25;
const PREVIEW_PARTICLE_CAP = 72;
const PREVIEW_SNOW_PARTICLE_CAP = 48;
// Preview caps exist to keep the editor responsive when band counts get huge.
// They should be permissive enough that the slider visibly affects the preview
// across its full useful range — exports always use the raw bandCount.
const PREVIEW_BAND_CAPS: Record<string, number> = {
  "circular-spectrum": 192,
  "double-circular": 128,
  "radial-bars": 128,
  "liquid-blob": 96,
  "tunnel": 64,
  "bottom-wave": 96,
  "rolling-wave": 96,
  "spiral-bars": 40,
  "leaf-border": 128,
  "custom-equalizer": 128,
  "itunes-classic": 64,
  "wmp-bars-waves": 96,
  "tidal-bloom": 64,
  "aurora-veil": 48,
  "silk-strands": 48,
  "fluid-flow": 48,
  "lissajous": 128,
  "ribbons": 48,
  "light-wave": 48,
  "murmuration": 96,
  "snow-field": 96,
  "particle-burst": 96,
};

const getPreviewSafeProject = (project: Project): Project => {
  const bandCap = PREVIEW_BAND_CAPS[project.visualizer.presetId] ?? 48;
  const particleCap = project.effects.particles.type === "snow"
    ? PREVIEW_SNOW_PARTICLE_CAP
    : PREVIEW_PARTICLE_CAP;

  return {
    ...project,
    visualizer: {
      ...project.visualizer,
      bandCount: Math.min(project.visualizer.bandCount, bandCap),
      custom: {
        ...project.visualizer.custom,
        count: Math.min(project.visualizer.custom.count, bandCap),
      },
    },
    effects: {
      ...project.effects,
      noise: false,
      particles: {
        ...project.effects.particles,
        density: Math.min(project.effects.particles.density, particleCap),
      },
    },
  };
};

interface Props {
  project: Project;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  engineRef: React.RefObject<AudioEngine | null>;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
}

export function VisualizerCanvas({ project, audioRef, engineRef, canvasRef: externalCanvasRef }: Props) {
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement | null>(null);
  const bgImgRef = useRef<HTMLImageElement | null>(null);
  const bgVidRef = useRef<HTMLVideoElement | null>(null);
  const startRef = useRef<number>(performance.now());
  const renderErrorRef = useRef<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [renderError, setRenderError] = useState<string | null>(null);
  const previewProject = useMemo(() => getPreviewSafeProject(project), [project]);

  const { w: rw, h: rh } = ratioToWH(project.aspectRatio);

  // Fit canvas to container
  useEffect(() => {
    const onResize = () => {
      const el = containerRef.current; if (!el) return;
      const maxW = el.clientWidth, maxH = el.clientHeight;
      const ratio = rw / rh;
      let w = maxW, h = maxW / ratio;
      if (h > maxH) { h = maxH; w = h * ratio; }
      setSize({ w: Math.floor(w), h: Math.floor(h) });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [rw, rh]);

  // Load logo
  useEffect(() => {
    if (!project.logo?.url) { logoRef.current = null; return; }
    const img = new Image();
    img.onload = () => { logoRef.current = img; };
    img.src = project.logo.url;
  }, [project.logo]);

  // Load background
  useEffect(() => {
    bgImgRef.current = null; bgVidRef.current = null;
    if (!project.background?.url) return;
    if (project.background.type.startsWith("video")) {
      const v = document.createElement("video");
      v.src = project.background.url; v.muted = true; v.loop = true; v.playsInline = true;
      v.play().catch(() => {});
      bgVidRef.current = v;
    } else {
      const img = new Image();
      img.onload = () => { bgImgRef.current = img; };
      img.src = project.background.url;
    }
  }, [project.background]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    if (!size.w || !size.h) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const previewDpr = typeof window === "undefined" ? 1 : Math.min(PREVIEW_DPR_CAP, window.devicePixelRatio || 1);
    const drawWidth = Math.max(1, Math.round(size.w * previewDpr));
    const drawHeight = Math.max(1, Math.round(size.h * previewDpr));
    canvas.width = drawWidth;
    canvas.height = drawHeight;
    renderErrorRef.current = null;
    setRenderError(null);
    let raf = 0;
    const empty: AudioData = {
      freq: new Uint8Array(new ArrayBuffer(1024)) as Uint8Array<ArrayBuffer>,
      wave: new Uint8Array(new ArrayBuffer(2048)) as Uint8Array<ArrayBuffer>,
      bass: 0, mid: 0, treble: 0, volume: 0, beat: false, time: 0, duration: 0,
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const cfg = previewProject.visualizer;
      const t = (performance.now() - startRef.current) / 1000 * cfg.animationSpeed;
      const audio = engineRef.current
        ? engineRef.current.read({ master: cfg.sensitivity, bass: cfg.bassSensitivity, mid: cfg.midSensitivity, treble: cfg.trebleSensitivity })
        : empty;

      // Background
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, drawWidth, drawHeight);
      const drawBg = (src: HTMLImageElement | HTMLVideoElement) => {
        const iw = "videoWidth" in src ? src.videoWidth : src.naturalWidth;
        const ih = "videoHeight" in src ? src.videoHeight : src.naturalHeight;
        if (!iw || !ih) return;
        const scale = Math.max(drawWidth / iw, drawHeight / ih) * cfg.backgroundScale;
        const dw = iw * scale, dh = ih * scale;
        ctx.save();
        if (cfg.backgroundBlur > 0) ctx.filter = `blur(${cfg.backgroundBlur}px)`;
        ctx.drawImage(src, (drawWidth - dw) / 2, (drawHeight - dh) / 2, dw, dh);
        ctx.restore();
      };
      if (bgVidRef.current) drawBg(bgVidRef.current);
      else if (bgImgRef.current) drawBg(bgImgRef.current);

      // Background tint
      if (cfg.backgroundTintOpacity > 0) {
        ctx.fillStyle = cfg.backgroundTint;
        ctx.globalAlpha = cfg.backgroundTintOpacity;
        ctx.fillRect(0, 0, drawWidth, drawHeight);
        ctx.globalAlpha = 1;
      }

      // Background pulse
      if (project.effects.backgroundPulse) {
        ctx.fillStyle = `rgba(255,255,255,${audio.bass * 0.08})`;
        ctx.fillRect(0, 0, drawWidth, drawHeight);
      }

      // Overlay
      if (cfg.overlayOpacity > 0) {
        ctx.fillStyle = cfg.overlay;
        ctx.globalAlpha = cfg.overlayOpacity;
        ctx.fillRect(0, 0, drawWidth, drawHeight);
        ctx.globalAlpha = 1;
      }

      // Foreground (visualizer + logo + effects + lyrics) — scaled to a
      // 1080p baseline inside `drawForegroundLayers` so the same draw code
      // produces identical proportions at any export resolution.
      try {
        drawForegroundLayers({
          ctx, w: drawWidth, h: drawHeight, cfg, audio, t,
          effects: previewProject.effects, lyrics: previewProject.lyrics,
          logo: logoRef.current,
        });
      } catch (error) {
        if (cfg.presetId !== "circular-spectrum") {
          try {
            drawForegroundLayers({
              ctx,
              w: drawWidth,
              h: drawHeight,
              cfg: { ...cfg, presetId: "circular-spectrum" },
              audio,
              t,
              effects: previewProject.effects,
              lyrics: previewProject.lyrics,
              logo: logoRef.current,
            });
            return;
          } catch {
            // fall through to friendly error state below
          }
        }

        if (!renderErrorRef.current) {
          const message = error instanceof Error ? error.message : "Visualizer render failed";
          renderErrorRef.current = message;
          setRenderError(message);
          console.error("[visualizer] preview render failed", error);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [previewProject, size.w, size.h, canvasRef, engineRef, project.effects.backgroundPulse]);

  // Hidden audio el wired to engine
  useEffect(() => {
    const el = audioRef.current; if (!el || !project.audio?.url) return;
    el.src = project.audio.url;
    if (!engineRef.current) {
      try { engineRef.current = new AudioEngine(el, project.visualizer.smoothing); } catch { /* will try after user gesture */ }
    } else {
      engineRef.current.setSmoothing(project.visualizer.smoothing);
    }
  }, [project.audio, project.visualizer.smoothing, audioRef, engineRef]);

  return (
    <div ref={containerRef} className="relative w-full h-full flex items-center justify-center p-6">
      <div
        className="relative rounded-xl overflow-hidden glow-ring bg-black"
        style={{ width: size.w, height: size.h }}
      >
        <canvas ref={canvasRef} className="w-full h-full block" />
        {renderError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-sm text-muted-foreground">
            This project loaded with a safer visualizer fallback.
          </div>
        )}
        {!project.audio && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            Upload an audio file to begin
          </div>
        )}
      </div>
    </div>
  );
}
