import { useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/project/types";
import { AudioEngine, emptyAudioData, type AudioData } from "@/lib/visualizer/audioEngine";
import { drawBackgroundLayers, drawForegroundLayers } from "@/lib/visualizer/render-shared";
import { COLOR_BG_PREFIX } from "@/lib/visualizer/backgrounds";
import { ensureLyricFontLoaded } from "@/lib/visualizer/fonts";
import { captureCanvasThumbnail, saveThumbnail } from "@/lib/project/thumbnails";

const ratioToWH = (r: string) => {
  switch (r) {
    case "1:1": return { w: 1080, h: 1080 };
    case "9:16": return { w: 1080, h: 1920 };
    case "4:5": return { w: 1080, h: 1350 };
    default: return { w: 1920, h: 1080 };
  }
};

const PREVIEW_DPR_CAP = 1.25;
/** Capture a dashboard thumbnail at most this often while music plays. */
const THUMB_INTERVAL_MS = 6000;
/** …and this long after the last edit while paused. */
const THUMB_IDLE_MS = 1500;

interface Props {
  project: Project;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  engineRef: React.RefObject<AudioEngine | null>;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /**
   * When set, every preview frame is ALSO painted into this canvas at its own
   * resolution (used by the in-browser recorder so recordings are full
   * export size instead of the on-screen preview size).
   */
  recordTargetRef?: React.RefObject<HTMLCanvasElement | null>;
}

export function VisualizerCanvas({ project, audioRef, engineRef, canvasRef: externalCanvasRef, recordTargetRef }: Props) {
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

  // The render loop reads the latest project through a ref so slider drags
  // don't restart the loop (which used to reset the canvas and flash black).
  const projectRef = useRef(project);
  const changedAtRef = useRef(performance.now());
  useEffect(() => {
    projectRef.current = project;
    changedAtRef.current = performance.now();
  }, [project]);

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
    if (project.background.id.startsWith(COLOR_BG_PREFIX)) return; // solid colour: no bitmap
    if (project.background.type.startsWith("video")) {
      const v = document.createElement("video");
      v.src = project.background.url; v.muted = true; v.loop = true; v.playsInline = true;
      v.play().catch(() => {});
      bgVidRef.current = v;
      return () => { v.pause(); v.removeAttribute("src"); v.load(); };
    }
    const img = new Image();
    img.onload = () => { bgImgRef.current = img; };
    img.src = project.background.url;
  }, [project.background]);

  // Make sure the lyric font is available to the canvas (Google fonts load lazily).
  useEffect(() => {
    if (!project.lyrics.enabled) return;
    void ensureLyricFontLoaded(project.lyrics.fontFamily);
  }, [project.lyrics.enabled, project.lyrics.fontFamily]);

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
    let lastFrameAt = performance.now();
    let lastThumbAt = 0;
    let lastThumbChangeAt = -1;
    const empty: AudioData = emptyAudioData();

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const p = projectRef.current;
      const cfg = p.visualizer;
      const dt = Math.max(0.001, Math.min(0.25, (now - lastFrameAt) / 1000));
      lastFrameAt = now;
      // Animation clock = audio time once a track has started, so every
      // time-based motion sits at the same phase as the export and pausing
      // freezes the picture like a still frame. Wall clock before playback.
      const el = audioRef.current;
      const useAudioClock = !!p.audio && !!el && Number.isFinite(el.currentTime) && (el.currentTime > 0 || !el.paused);
      const t = (useAudioClock ? el!.currentTime : (now - startRef.current) / 1000) * cfg.animationSpeed;
      const audio = engineRef.current
        ? engineRef.current.read({ master: cfg.sensitivity, bass: cfg.bassSensitivity, mid: cfg.midSensitivity, treble: cfg.trebleSensitivity })
        : empty;

      const colorBg = p.background?.id.startsWith(COLOR_BG_PREFIX)
        ? p.background.id.slice(COLOR_BG_PREFIX.length)
        : null;
      const source = bgVidRef.current ?? bgImgRef.current;

      const paintInto = (target: CanvasRenderingContext2D, tw: number, th: number, stateKey: string) => {
        drawBackgroundLayers({
          ctx: target, w: tw, h: th, cfg, audio, effects: p.effects,
          source, cacheable: !bgVidRef.current && !!bgImgRef.current, color: colorBg,
        });
        drawForegroundLayers({
          ctx: target, w: tw, h: th, cfg, audio, t,
          effects: p.effects, lyrics: p.lyrics,
          logo: logoRef.current, dt, stateKey,
          title: p.trackTitle || p.name,
        });
      };

      // Recording target (export-resolution offscreen canvas), same frame data.
      const rec = recordTargetRef?.current;
      if (rec && rec.width > 0 && rec.height > 0) {
        const rctx = rec.getContext("2d");
        if (rctx) {
          try { paintInto(rctx, rec.width, rec.height, "record"); } catch { /* keep recording alive */ }
        }
      }

      try {
        paintInto(ctx, drawWidth, drawHeight, "main");
      } catch (error) {
        if (cfg.presetId !== "circular-spectrum") {
          try {
            drawForegroundLayers({
              ctx, w: drawWidth, h: drawHeight,
              cfg: { ...cfg, presetId: "circular-spectrum" },
              audio, t, effects: p.effects, lyrics: p.lyrics,
              logo: logoRef.current, dt, stateKey: "main",
              title: p.trackTitle || p.name,
            });
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

      // Dashboard thumbnail: while playing every few seconds, or shortly after
      // the last edit while paused. Skips frames with no audio loaded.
      if (p.audio) {
        const playing = !!audioRef.current && !audioRef.current.paused;
        const idleEdit = changedAtRef.current !== lastThumbChangeAt && now - changedAtRef.current > THUMB_IDLE_MS;
        if ((playing && now - lastThumbAt > THUMB_INTERVAL_MS) || (!playing && idleEdit && now - lastThumbAt > THUMB_IDLE_MS)) {
          lastThumbAt = now;
          lastThumbChangeAt = changedAtRef.current;
          const url = captureCanvasThumbnail(canvas);
          if (url) saveThumbnail(p.id, url);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [size.w, size.h, canvasRef, engineRef, audioRef, recordTargetRef]);

  // Hidden audio el wired to engine
  useEffect(() => {
    const el = audioRef.current; if (!el || !project.audio?.url) return;
    el.preload = "metadata";
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
