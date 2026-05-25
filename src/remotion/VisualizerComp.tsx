import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { AbsoluteFill, Audio, OffthreadVideo, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { useAudioData, visualizeAudio } from "@remotion/media-utils";
import type { AudioData } from "../lib/visualizer/audioEngine";
import type { EffectsConfig, LyricsConfig, VisualizerConfig, LyricLine } from "../lib/project/types";
import { drawEffects } from "../lib/visualizer/effects";
import { drawLyrics, drawVisualizerLayer } from "../lib/visualizer/render-shared";

const lyricLineSchema = z.object({ time: z.number(), text: z.string() });

// We ship the full VisualizerConfig / EffectsConfig / LyricsConfig as-is so the
// renderer can call the exact same draw code as the live preview. The Remotion
// composition treats them as opaque records — runtime validation happens via
// our own Zod schema in `lambda.functions.ts`.
export const visualizerSchema = z.object({
  audioUrl: z.string(),
  durationSeconds: z.number(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  backgroundUrl: z.string().nullable(),
  backgroundType: z.string().nullable(),
  logoUrl: z.string().nullable(),
  visualizer: z.any(),
  effects: z.any(),
  lyrics: z.object({
    enabled: z.boolean(),
    lines: z.array(lyricLineSchema),
    style: z.string(),
    position: z.string(),
    fontFamily: z.string(),
    fontSize: z.number(),
    color: z.string(),
    outline: z.boolean(),
    shadow: z.boolean(),
    glow: z.boolean(),
    fade: z.boolean(),
  }),
});

export type VisualizerProps = {
  audioUrl: string;
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  backgroundUrl: string | null;
  backgroundType: string | null;
  logoUrl: string | null;
  visualizer: VisualizerConfig;
  effects: EffectsConfig;
  lyrics: LyricsConfig;
};

export const defaultVisualizerProps: VisualizerProps = {
  audioUrl: "https://remotion-assets.s3.eu-central-1.amazonaws.com/silence.mp3",
  durationSeconds: 30,
  fps: 30,
  width: 1920,
  height: 1080,
  backgroundUrl: null,
  backgroundType: null,
  logoUrl: null,
  visualizer: {
    presetId: "circular-spectrum",
    primary: "#22e3ff",
    secondary: "#b14bff",
    accent: "#ff4bd1",
    glow: "#22e3ff",
    overlay: "#000000",
    overlayOpacity: 0.35,
    glowIntensity: 0.8,
    blur: 0,
    size: 1,
    thickness: 4,
    position: { x: 0, y: 0 },
    logoSize: 0.35,
    logoPosition: { x: 0, y: 0 },
    backgroundScale: 1.05,
    backgroundBlur: 6,
    backgroundTint: "#0a0612",
    backgroundTintOpacity: 0.25,
    animationSpeed: 1,
    sensitivity: 1.2,
    bassSensitivity: 1.3,
    midSensitivity: 1,
    trebleSensitivity: 1,
    smoothing: 0.78,
    rotation: 0,
    movement: 0.5,
    shadow: 0.4,
    border: 0,
    blendMode: "source-over",
    reactivity: 1,
    bandCount: 12,
  },
  effects: {
    particles: { enabled: true, type: "dust", density: 40, speed: 0.4, color: "#ffffff", opacity: 0.35, reactivity: 0.3 },
    beatFlash: false, vignette: true, noise: false, lensFlare: false, logoPulse: true, backgroundPulse: false,
  },
  lyrics: {
    enabled: false, lines: [] as LyricLine[], style: "subtitle", position: "bottom",
    fontFamily: "Inter", fontSize: 56, color: "#ffffff",
    outline: true, shadow: true, glow: false, fade: true,
  },
};

const FFT_SAMPLES = 1024 as const;

function buildAudioData(
  bins: number[] | null,
  time: number,
  duration: number,
  prevBass: { value: number },
): AudioData {
  const freqLen = bins?.length ?? FFT_SAMPLES;
  const freq = new Uint8Array(new ArrayBuffer(freqLen)) as Uint8Array<ArrayBuffer>;
  const waveLen = 2048;
  const wave = new Uint8Array(new ArrayBuffer(waveLen)) as Uint8Array<ArrayBuffer>;

  if (bins) {
    for (let i = 0; i < freqLen; i++) {
      // visualizeAudio returns 0..1 magnitudes; map to byte range like AnalyserNode.
      const v = Math.max(0, Math.min(1, bins[i]));
      freq[i] = Math.round(v * 255);
    }
    // Synthesize a plausible time-domain waveform from the first 24 bins so
    // oscilloscope-style presets have something to draw.
    const harmonics = Math.min(24, freqLen);
    for (let i = 0; i < waveLen; i++) {
      let sum = 0;
      for (let k = 1; k < harmonics; k++) {
        const amp = bins[k] || 0;
        sum += amp * Math.sin((i / waveLen) * k * Math.PI * 2 + time * k * 0.7);
      }
      wave[i] = Math.max(0, Math.min(255, Math.round(128 + sum * 60)));
    }
  } else {
    wave.fill(128);
  }

  const sliceAvg = (lo: number, hi: number) => {
    const a = Math.floor(lo * freqLen), b = Math.floor(hi * freqLen);
    let s = 0;
    for (let i = a; i < b; i++) s += freq[i];
    return (s / Math.max(1, b - a)) / 255;
  };
  const bass = Math.min(1, sliceAvg(0, 0.08));
  const mid = Math.min(1, sliceAvg(0.08, 0.4));
  const treble = Math.min(1, sliceAvg(0.4, 1));
  let sum = 0;
  for (let i = 0; i < freqLen; i++) sum += freq[i];
  const volume = Math.min(1, sum / freqLen / 255);
  const beat = bass > 0.55 && bass > prevBass.value * 1.25;
  prevBass.value = bass;

  return { freq, wave, bass, mid, treble, volume, beat, time, duration };
}

export const VisualizerComp: React.FC<VisualizerProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevBassRef = useRef({ value: 0 });

  const audioData = useAudioData(props.audioUrl);

  // Load logo + background as HTMLImageElements once, gated by delayRender so
  // Lambda waits for them before screenshotting frame 0.
  const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null);
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!props.logoUrl) return;
    const handle = delayRender(`logo:${props.logoUrl}`);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { setLogoImg(img); continueRender(handle); };
    img.onerror = () => { continueRender(handle); };
    img.src = props.logoUrl;
  }, [props.logoUrl]);

  useEffect(() => {
    if (!props.backgroundUrl || (props.backgroundType ?? "").startsWith("video")) return;
    const handle = delayRender(`bg:${props.backgroundUrl}`);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { setBgImg(img); continueRender(handle); };
    img.onerror = () => { continueRender(handle); };
    img.src = props.backgroundUrl;
  }, [props.backgroundUrl, props.backgroundType]);

  const isVideoBg = !!(props.backgroundUrl && (props.backgroundType ?? "").startsWith("video"));

  // CSS transform applied to the OffthreadVideo so backgroundScale +
  // backgroundBlur work just like the image bg path on the live canvas.
  const videoBgStyle = useMemo<React.CSSProperties>(() => ({
    width: "100%",
    height: "100%",
    objectFit: "cover",
    transform: `scale(${props.visualizer.backgroundScale})`,
    transformOrigin: "center center",
    filter: props.visualizer.backgroundBlur > 0
      ? `blur(${props.visualizer.backgroundBlur}px)`
      : undefined,
  }), [props.visualizer.backgroundScale, props.visualizer.backgroundBlur]);

  // Draw a single frame synchronously into the canvas. useLayoutEffect ensures
  // the bitmap is updated before Remotion's screenshot is captured.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = width;
    canvas.height = height;

    const cfg = props.visualizer;
    const time = (frame / fps) * (cfg.animationSpeed ?? 1);

    let bins: number[] | null = null;
    if (audioData) {
      try {
        const out = visualizeAudio({
          fps,
          frame,
          audioData,
          numberOfSamples: FFT_SAMPLES,
        });
        bins = Array.from(out);
      } catch {
        bins = null;
      }
    }

    const audio = buildAudioData(bins, frame / fps, durationInFrames / fps, prevBassRef.current);

    // --- Identical paint pipeline as VisualizerCanvas.tsx ---

    if (isVideoBg) {
      // Video plays behind the canvas via <OffthreadVideo> — keep canvas
      // transparent so it shows through.
      ctx.clearRect(0, 0, width, height);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      if (bgImg) {
        const iw = bgImg.naturalWidth || width;
        const ih = bgImg.naturalHeight || height;
        const scale = Math.max(width / iw, height / ih) * cfg.backgroundScale;
        const dw = iw * scale, dh = ih * scale;
        ctx.save();
        if (cfg.backgroundBlur > 0) ctx.filter = `blur(${cfg.backgroundBlur}px)`;
        ctx.drawImage(bgImg, (width - dw) / 2, (height - dh) / 2, dw, dh);
        ctx.restore();
      }
    }

    if (cfg.backgroundTintOpacity > 0) {
      ctx.fillStyle = cfg.backgroundTint;
      ctx.globalAlpha = cfg.backgroundTintOpacity;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }

    if (props.effects.backgroundPulse) {
      ctx.fillStyle = `rgba(255,255,255,${audio.bass * 0.08})`;
      ctx.fillRect(0, 0, width, height);
    }

    if (cfg.overlayOpacity > 0) {
      ctx.fillStyle = cfg.overlay;
      ctx.globalAlpha = cfg.overlayOpacity;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }

    // Visualizer (Movement / Shadow / Border applied inside helper).
    drawVisualizerLayer({ ctx, w: width, h: height, cfg, audio, t: time, logo: logoImg ?? undefined });

    if (logoImg) {
      const lsize = Math.min(width, height) * cfg.logoSize * (props.effects.logoPulse ? 1 + audio.bass * 0.12 : 1);
      const lx = width / 2 + cfg.logoPosition.x * width / 2 - lsize / 2;
      const ly = height / 2 + cfg.logoPosition.y * height / 2 - lsize / 2;
      ctx.save();
      if (cfg.glowIntensity > 0) {
        ctx.shadowColor = cfg.glow;
        ctx.shadowBlur = 30 * cfg.glowIntensity;
      }
      ctx.drawImage(logoImg, lx, ly, lsize, lsize);
      ctx.restore();
    }

    drawEffects({ ctx, w: width, h: height, cfg, audio, t: time }, props.effects);

    // Lyrics (subtitle/karaoke + fade handled in shared helper)
    drawLyrics(ctx, width, height, props.lyrics, audio.time, cfg.glow);
  }, [frame, fps, width, height, durationInFrames, audioData, bgImg, logoImg, isVideoBg, props]);

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {isVideoBg && props.backgroundUrl ? (
        <AbsoluteFill>
          <OffthreadVideo src={props.backgroundUrl} muted style={videoBgStyle} />
        </AbsoluteFill>
      ) : null}
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", position: "relative" }} />
      <Audio src={props.audioUrl} />
    </AbsoluteFill>
  );
};
