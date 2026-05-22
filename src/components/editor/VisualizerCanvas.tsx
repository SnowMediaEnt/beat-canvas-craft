import { useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/project/types";
import { AudioEngine, type AudioData } from "@/lib/visualizer/audioEngine";
import { getPreset } from "@/lib/visualizer/presets";
import { drawEffects } from "@/lib/visualizer/effects";

const ratioToWH = (r: string) => {
  switch (r) {
    case "1:1": return { w: 1080, h: 1080 };
    case "9:16": return { w: 1080, h: 1920 };
    case "4:5": return { w: 1080, h: 1350 };
    default: return { w: 1920, h: 1080 };
  }
};

interface Props {
  project: Project;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  engineRef: React.RefObject<AudioEngine | null>;
}

export function VisualizerCanvas({ project, audioRef, engineRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement | null>(null);
  const bgImgRef = useRef<HTMLImageElement | null>(null);
  const bgVidRef = useRef<HTMLVideoElement | null>(null);
  const startRef = useRef<number>(performance.now());
  const [size, setSize] = useState({ w: 800, h: 450 });

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
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    canvas.width = rw; canvas.height = rh;
    let raf = 0;
    const empty: AudioData = {
      freq: new Uint8Array(new ArrayBuffer(1024)) as Uint8Array<ArrayBuffer>,
      wave: new Uint8Array(new ArrayBuffer(2048)) as Uint8Array<ArrayBuffer>,
      bass: 0, mid: 0, treble: 0, volume: 0, beat: false, time: 0, duration: 0,
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const cfg = project.visualizer;
      const t = (performance.now() - startRef.current) / 1000 * cfg.animationSpeed;
      const audio = engineRef.current
        ? engineRef.current.read({ master: cfg.sensitivity, bass: cfg.bassSensitivity, mid: cfg.midSensitivity, treble: cfg.trebleSensitivity })
        : empty;

      // Background
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, rw, rh);
      const drawBg = (src: HTMLImageElement | HTMLVideoElement) => {
        const iw = "videoWidth" in src ? src.videoWidth : src.naturalWidth;
        const ih = "videoHeight" in src ? src.videoHeight : src.naturalHeight;
        if (!iw || !ih) return;
        const scale = Math.max(rw / iw, rh / ih) * cfg.backgroundScale;
        const dw = iw * scale, dh = ih * scale;
        ctx.save();
        if (cfg.backgroundBlur > 0) ctx.filter = `blur(${cfg.backgroundBlur}px)`;
        ctx.drawImage(src, (rw - dw) / 2, (rh - dh) / 2, dw, dh);
        ctx.restore();
      };
      if (bgVidRef.current) drawBg(bgVidRef.current);
      else if (bgImgRef.current) drawBg(bgImgRef.current);

      // Background tint
      if (cfg.backgroundTintOpacity > 0) {
        ctx.fillStyle = cfg.backgroundTint;
        ctx.globalAlpha = cfg.backgroundTintOpacity;
        ctx.fillRect(0, 0, rw, rh);
        ctx.globalAlpha = 1;
      }

      // Background pulse
      if (project.effects.backgroundPulse) {
        ctx.fillStyle = `rgba(255,255,255,${audio.bass * 0.08})`;
        ctx.fillRect(0, 0, rw, rh);
      }

      // Overlay
      if (cfg.overlayOpacity > 0) {
        ctx.fillStyle = cfg.overlay;
        ctx.globalAlpha = cfg.overlayOpacity;
        ctx.fillRect(0, 0, rw, rh);
        ctx.globalAlpha = 1;
      }

      // Visualizer
      const preset = getPreset(cfg.presetId);
      ctx.save();
      ctx.globalCompositeOperation = cfg.blendMode;
      if (cfg.blur > 0) ctx.filter = `blur(${cfg.blur}px)`;
      preset.draw({ ctx, w: rw, h: rh, cfg, audio, t, logo: logoRef.current || undefined });
      ctx.restore();

      // Logo
      if (logoRef.current) {
        const lsize = Math.min(rw, rh) * cfg.logoSize * (project.effects.logoPulse ? (1 + audio.bass * 0.12) : 1);
        const lx = rw / 2 + cfg.logoPosition.x * rw / 2 - lsize / 2;
        const ly = rh / 2 + cfg.logoPosition.y * rh / 2 - lsize / 2;
        ctx.save();
        if (cfg.glowIntensity > 0) {
          ctx.shadowColor = cfg.glow;
          ctx.shadowBlur = 30 * cfg.glowIntensity;
        }
        ctx.drawImage(logoRef.current, lx, ly, lsize, lsize);
        ctx.restore();
      }

      // Effects
      drawEffects({ ctx, w: rw, h: rh, cfg, audio, t }, project.effects);

      // Lyrics
      if (project.lyrics.enabled && project.lyrics.lines.length) {
        const cur = [...project.lyrics.lines].reverse().find(l => l.time <= audio.time);
        if (cur) {
          const L = project.lyrics;
          ctx.save();
          ctx.font = `600 ${L.fontSize}px ${L.fontFamily}, sans-serif`;
          ctx.textAlign = L.position === "left" ? "left" : L.position === "right" ? "right" : "center";
          ctx.textBaseline = "middle";
          let x = rw / 2, y = rh - 120;
          if (L.position === "top") y = 120;
          if (L.position === "center") y = rh / 2;
          if (L.position === "left") { x = 60; y = rh / 2; }
          if (L.position === "right") { x = rw - 60; y = rh / 2; }
          if (L.shadow) { ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 8; }
          if (L.glow) { ctx.shadowColor = project.visualizer.glow; ctx.shadowBlur = 20; }
          if (L.outline) { ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 4; ctx.strokeText(cur.text, x, y); }
          ctx.fillStyle = L.color;
          ctx.fillText(cur.text, x, y);
          ctx.restore();
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [project, rw, rh, engineRef]);

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
        {!project.audio && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            Upload an audio file to begin
          </div>
        )}
      </div>
    </div>
  );
}
