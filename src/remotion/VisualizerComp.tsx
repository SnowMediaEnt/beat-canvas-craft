import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { AbsoluteFill, Audio, Loop, OffthreadVideo, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { useAudioData, visualizeAudio } from "@remotion/media-utils";
import type { AudioData } from "../lib/visualizer/audioEngine";
import type { EffectsConfig, LyricsConfig, VisualizerConfig, LyricLine } from "../lib/project/types";
import { drawForegroundLayers } from "../lib/visualizer/render-shared";
import { bandLevels } from "../lib/visualizer/presets";

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

const FFT_SAMPLES = 256 as const;

/**
 * Convert Remotion's linear-amplitude FFT bins to the same 0–255 byte range
 * that the browser's AnalyserNode.getByteFrequencyData() produces in the live
 * preview. AnalyserNode applies a dB conversion (default minDb=-100, maxDb=-30)
 * — that's why bass (which is loud in linear terms) looks fine in render but
 * mids/highs (which are linearly tiny) come out far too small. Doing the same
 * dB mapping here makes every band scale the same way preview does.
 */
const MIN_DB = -85;
const MAX_DB = -20;
const DB_RANGE = MAX_DB - MIN_DB;

function linearToByte(linear: number): number {
  if (linear <= 0) return 0;
  const db = 20 * Math.log10(linear);
  const norm = (db - MIN_DB) / DB_RANGE;
  if (norm <= 0) return 0;
  if (norm >= 1) return 255;
  return Math.round(norm * 255);
}

type AudioState = {
  /** Last bass value for beat detection (post-sensitivity). */
  lastBass: number;
  /** Frames remaining until another beat can fire. Matches AudioEngine's 8-frame cooldown. */
  beatCooldown: number;
};

/**
 * Build an AudioData snapshot from a single Remotion frame, matching the
 * live preview's AnalyserNode output as closely as possible (dB-scaled bins,
 * same band slicing, same sensitivity application, same beat cooldown).
 */
function buildAudioData(
  bins: number[] | null,
  waveSamples: Float32Array | null,
  time: number,
  duration: number,
  cfg: VisualizerConfig,
  state: AudioState,
): AudioData {
  const freqLen = bins?.length ?? FFT_SAMPLES;
  const freq = new Uint8Array(new ArrayBuffer(freqLen)) as Uint8Array<ArrayBuffer>;
  const waveLen = 2048;
  const wave = new Uint8Array(new ArrayBuffer(waveLen)) as Uint8Array<ArrayBuffer>;

  if (bins) {
    for (let i = 0; i < freqLen; i++) {
      freq[i] = linearToByte(bins[i]);
    }
  }

  if (waveSamples && waveSamples.length > 0) {
    // Real time-domain waveform sampled from the audio file at this frame.
    // Matches AnalyserNode.getByteTimeDomainData() in the live preview, so
    // oscilloscope / horizontal-waveform presets draw an actual waveform
    // instead of a synthetic FFT-harmonic sum.
    const srcLen = waveSamples.length;
    for (let i = 0; i < waveLen; i++) {
      const idx = Math.min(srcLen - 1, Math.max(0, (i / waveLen) * srcLen | 0));
      const v = waveSamples[idx]; // -1..1
      wave[i] = Math.max(0, Math.min(255, Math.round(128 + v * 127)));
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

  const master = cfg.sensitivity ?? 1;
  const bassMul = cfg.bassSensitivity ?? 1;
  const midMul = cfg.midSensitivity ?? 1;
  const trebMul = cfg.trebleSensitivity ?? 1;

  const bass = Math.min(1, sliceAvg(0, 0.08) * bassMul * master);
  const mid = Math.min(1, sliceAvg(0.08, 0.4) * midMul * master);
  const treble = Math.min(1, sliceAvg(0.4, 1) * trebMul * master);
  let sum = 0;
  for (let i = 0; i < freqLen; i++) sum += freq[i];
  const volume = Math.min(1, (sum / freqLen / 255) * master);

  let beat = false;
  if (state.beatCooldown > 0) state.beatCooldown--;
  if (bass > 0.55 && bass > state.lastBass * 1.25 && state.beatCooldown === 0) {
    beat = true;
    state.beatCooldown = 8;
  }
  state.lastBass = bass;

  return { freq, wave, bass, mid, treble, volume, beat, time, duration };
}

export const VisualizerComp: React.FC<VisualizerProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioStateRef = useRef<AudioState>({ lastBass: 0, beatCooldown: 0 });

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

  // Discover the video's native duration so we can loop it across the full
  // composition. OffthreadVideo doesn't loop natively, so without this the
  // background goes black once the source ends (diverging from the live
  // preview which sets `video.loop = true`).
  const [videoLoopFrames, setVideoLoopFrames] = useState<number | null>(null);
  useEffect(() => {
    setVideoLoopFrames(null);
    if (!isVideoBg || !props.backgroundUrl) return;
    const handle = delayRender(`videoBg:${props.backgroundUrl}`);
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      // Fallback to the composition's duration if metadata is bad — Loop
      // clamps to its parent anyway, so the worst case is "no loop".
      setVideoLoopFrames(dur > 0 ? Math.max(1, Math.round(dur * fps)) : durationInFrames);
      continueRender(handle);
    };
    v.onerror = () => { setVideoLoopFrames(durationInFrames); continueRender(handle); };
    v.src = props.backgroundUrl;
  }, [props.backgroundUrl, isVideoBg, fps, durationInFrames]);

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
    // eslint-disable-next-line no-console
    if (frame % 30 === 0) console.log("[size-trace] received cfg.size =", cfg?.size);
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
        if (frame % 30 === 0) {
          const firstNonZero = bins.find((v) => v > 0) ?? 0;
          const firstNonZeroIdx = bins.findIndex((v) => v > 0);
          // eslint-disable-next-line no-console
          console.log("[audio-raw]", {
            frame,
            audioDataNumChannels: audioData.numberOfChannels,
            audioDataSampleRate: audioData.sampleRate,
            audioDataDurationInSeconds: audioData.durationInSeconds,
            firstBins: bins.slice(0, 5),
            maxBin: bins.reduce((m, v) => Math.max(m, v), 0),
            firstNonZero,
            firstNonZeroIdx,
          });
        }
      } catch (err) {
        bins = null;
        if (frame % 30 === 0) {
          // eslint-disable-next-line no-console
          console.log("[audio-raw] visualizeAudio threw", err instanceof Error ? err.message : String(err));
        }
      }
    } else if (frame % 30 === 0) {
      // eslint-disable-next-line no-console
      console.log("[audio-raw] audioData is null (useAudioData not yet resolved)");
    }


    const audio = buildAudioData(bins, frame / fps, durationInFrames / fps, cfg, audioStateRef.current);

    if (frame % 30 === 0) {
      // eslint-disable-next-line no-console
      console.log("[audio-amplitude]", "frame", frame,
        "bass", +audio.bass.toFixed(4),
        "volume", +audio.volume.toFixed(4),
        "bins[0]", audio.freq[0],
        "binsLen", audio.freq.length,
        "rawBin0", bins ? bins[0] : null);
    }

    // [DIAG] log every 30 frames during render
    if (frame % 30 === 0) {
      const lv = bandLevels(audio.freq, cfg.bandCount ?? 12, 0.7, cfg);
      // eslint-disable-next-line no-console
      console.log("[DIAG render]", {
        frame, t: +(frame / fps).toFixed(2),
        freq: [audio.freq[0], audio.freq[5], audio.freq[10], audio.freq[15]],
        bass: +audio.bass.toFixed(3), mid: +audio.mid.toFixed(3),
        treble: +audio.treble.toFixed(3), volume: +audio.volume.toFixed(3),
        levels: lv.slice(0, 5).map(v => +v.toFixed(3)),
        size: cfg.size, sensitivity: cfg.sensitivity,
      });
    }

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

    // Foreground (visualizer + logo + effects + lyrics) — drawn via the
    // shared helper so it scales to a 1080p baseline identically to the
    // live preview canvas.
    drawForegroundLayers({
      ctx, w: width, h: height, cfg, audio, t: time,
      effects: props.effects, lyrics: props.lyrics,
      logo: logoImg,
    });
  }, [frame, fps, width, height, durationInFrames, audioData, bgImg, logoImg, isVideoBg, props]);

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {isVideoBg && props.backgroundUrl && videoLoopFrames !== null ? (
        <AbsoluteFill>
          {/*
            Loop the bg video on its native duration so it repeats across the
            full composition (matches `<video loop>` in the live preview).
            durationInFrames here is the LOOP interval, not the parent's run.
          */}
          <Loop durationInFrames={videoLoopFrames} layout="none">
            <OffthreadVideo src={props.backgroundUrl} muted style={videoBgStyle} />
          </Loop>
        </AbsoluteFill>
      ) : null}
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", position: "relative" }} />
      <Audio src={props.audioUrl} />
    </AbsoluteFill>
  );
};
