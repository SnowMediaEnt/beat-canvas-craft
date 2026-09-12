import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AbsoluteFill, Audio, Loop, OffthreadVideo,
  cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig,
} from "remotion";
import { useAudioData } from "@remotion/media-utils";
import {
  type AudioData, ANALYSER_FFT_SIZE, bandMetrics, softClip01,
} from "../lib/visualizer/audioEngine";
import type { EffectsConfig, LyricsConfig, VisualizerConfig, LyricLine } from "../lib/project/types";
import { drawBackgroundLayers, drawForegroundLayers, type BackgroundSource } from "../lib/visualizer/render-shared";
import { analyserBytes, analyserWaveBytes, mixToMono, type AnalyserState } from "../lib/visualizer/fft";
import { OnsetDetector, TRACKER_WARMUP_SECONDS } from "../lib/visualizer/onset";
import { RENDER_ENGINE_VERSION } from "../lib/visualizer/engine-version";
import { ensureLyricFontLoaded } from "../lib/visualizer/fonts";
import { renderInputPropsSchema } from "../lib/render/input-schema";

// The composition's schema is the exact schema the server validates against
// (see src/lib/render/input-schema.ts) so no field can be dropped in transit.
export const visualizerSchema = renderInputPropsSchema;

export type VisualizerProps = {
  audioUrl: string;
  durationSeconds: number;
  fps: 30 | 45 | 60 | 120;
  width: number;
  height: number;
  backgroundUrl: string | null;
  backgroundType: string | null;
  backgroundColor?: string | null;
  logoUrl: string | null;
  visualizer: VisualizerConfig;
  effects: EffectsConfig;
  lyrics: LyricsConfig;
  title?: string;
  engineVersion?: number;
  quality?: "high" | "standard";
};

export const defaultVisualizerProps: VisualizerProps = {
  audioUrl: "https://remotion-assets.s3.eu-central-1.amazonaws.com/silence.mp3",
  durationSeconds: 30,
  fps: 30,
  width: 1920,
  height: 1080,
  backgroundUrl: null,
  backgroundType: null,
  backgroundColor: null,
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
    smoothing: 0.5,
    rotation: 0,
    movement: 0,
    shadow: 0.4,
    border: 0,
    blendMode: "source-over",
    reactivity: 1,
    bandCount: 12,
    stationary: false,
    custom: {
      shape: "bars", count: 48, spacing: 0.25, amplitude: 1, thickness: 0,
      rounded: true, symmetric: false, reactivity: 1, innerRadius: 0.35,
    },
  },
  effects: {
    particles: { enabled: true, type: "dust", density: 40, speed: 0.4, color: "#ffffff", opacity: 0.35, reactivity: 0.3 },
    beatFlash: false, vignette: true, noise: false, lensFlare: false, logoPulse: true, logoBounce: false, backgroundPulse: false,
  },
  lyrics: {
    enabled: false, lines: [] as LyricLine[], style: "subtitle", position: "bottom",
    fontFamily: "Inter", fontSize: 56, color: "#ffffff",
    outline: true, shadow: true, glow: false, fade: true,
  },
  title: "",
  engineVersion: RENDER_ENGINE_VERSION,
};

type U8 = Uint8Array<ArrayBuffer>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Longest warm-up we run when a Lambda chunk starts mid-song. */
const MAX_WARMUP_FRAMES = 420;

export const VisualizerComp: React.FC<VisualizerProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Guard: the bundle on S3 must not be older than the app that sent the
  // request, otherwise unknown presets/effects silently fall back.
  useEffect(() => {
    if (typeof props.engineVersion === "number" && props.engineVersion > RENDER_ENGINE_VERSION) {
      cancelRender(
        new Error(
          `The visualizer bundle deployed to AWS is out of date (bundle engine v${RENDER_ENGINE_VERSION}, app engine v${props.engineVersion}). ` +
          `Redeploy it: npx remotion lambda sites create src/remotion/index.ts --site-name=<site> --region=<region>`,
        ),
      );
    }
  }, [props.engineVersion]);

  // ── Audio analysis (browser-AnalyserNode-identical FFT on the decoded samples)
  const audioData = useAudioData(props.audioUrl);
  const mono = useMemo(() => (audioData ? mixToMono(audioData.channelWaveforms) : null), [audioData]);
  const analyserStateRef = useRef<AnalyserState>({ smoothed: null });
  const onsetRef = useRef(new OnsetDetector());
  const lastAnalysedFrameRef = useRef<number>(-10);
  const audioCacheRef = useRef<{ frame: number; audio: AudioData } | null>(null);

  const analyseFrame = useCallback((f: number): AudioData => {
    const cfg = props.visualizer;
    const sr = audioData?.sampleRate && audioData.sampleRate > 0 ? audioData.sampleRate : 48000;
    const time = f / fps;
    const freq = new Uint8Array(new ArrayBuffer(ANALYSER_FFT_SIZE / 2)) as U8;
    const wave = new Uint8Array(new ArrayBuffer(ANALYSER_FFT_SIZE)) as U8;
    if (mono && mono.length) {
      const endSample = Math.round(time * sr);
      analyserBytes(
        mono, endSample,
        { fftSize: ANALYSER_FFT_SIZE, smoothingTimeConstant: clamp(cfg.smoothing ?? 0.5, 0, 0.95) },
        analyserStateRef.current, freq,
      );
      analyserWaveBytes(mono, endSample, ANALYSER_FFT_SIZE, wave);
    } else {
      wave.fill(128);
    }

    const master = cfg.sensitivity ?? 1;
    const m = bandMetrics(freq, sr, {
      master, bass: cfg.bassSensitivity ?? 1, mid: cfg.midSensitivity ?? 1, treble: cfg.trebleSensitivity ?? 1,
    });
    const tracker = onsetRef.current;
    const feat = tracker.update(freq, time, m.rawVolume, sr);

    return {
      freq, wave, bass: m.bass, mid: m.mid, treble: m.treble, volume: m.volume, beat: feat.beat,
      time, duration: durationInFrames / fps, sampleRate: sr,
      onset: feat.onset, onsetAge: feat.onsetAge, energy: softClip01(feat.energy * master),
      kick: feat.kick, snare: feat.snare, hat: feat.hat, kickAge: feat.kickAge, snareAge: feat.snareAge, hatAge: feat.hatAge,
      history: tracker.history, historyRows: tracker.historyRows,
      dt: 1 / fps,
    };
  }, [props.visualizer, audioData, mono, fps, durationInFrames]);

  /**
   * AudioData for `f`, warming the smoothing + onset state up from earlier
   * frames whenever we're not continuing sequentially (every Lambda chunk
   * starts cold; without this the first frames of each chunk showed a dip
   * and a false beat).
   */
  const audioForFrame = useCallback((f: number): AudioData => {
    const cached = audioCacheRef.current;
    if (cached && cached.frame === f) return cached.audio;
    if (lastAnalysedFrameRef.current !== f - 1) {
      analyserStateRef.current = { smoothed: null };
      onsetRef.current.reset();
      const k = clamp(props.visualizer.smoothing ?? 0.5, 0, 0.95);
      const emaFrames = k > 0 ? Math.ceil(Math.log(0.01) / Math.log(k)) : 0;
      // Enough frames for the smoothing EMA to settle AND for the feature
      // tracker's spectral history / adaptive thresholds to fill.
      const warm = Math.min(MAX_WARMUP_FRAMES, Math.max(emaFrames, Math.ceil(TRACKER_WARMUP_SECONDS * fps)));
      for (let w = Math.max(0, f - warm); w < f; w++) analyseFrame(w);
    }
    const audio = analyseFrame(f);
    lastAnalysedFrameRef.current = f;
    audioCacheRef.current = { frame: f, audio };
    return audio;
  }, [analyseFrame, props.visualizer.smoothing, fps]);

  // ── Assets: logo + background image, gated by delayRender so Lambda waits.
  const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null);
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null);
  const [fontsReady, setFontsReady] = useState(0);

  useEffect(() => {
    if (!props.logoUrl) { setLogoImg(null); return; }
    const handle = delayRender(`logo:${props.logoUrl}`);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { setLogoImg(img); continueRender(handle); };
    img.onerror = () => { continueRender(handle); };
    img.src = props.logoUrl;
  }, [props.logoUrl]);

  const isVideoBg = !!(props.backgroundUrl && (props.backgroundType ?? "").startsWith("video"));

  useEffect(() => {
    if (!props.backgroundUrl || isVideoBg) { setBgImg(null); return; }
    const handle = delayRender(`bg:${props.backgroundUrl}`);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { setBgImg(img); continueRender(handle); };
    img.onerror = () => { continueRender(handle); };
    img.src = props.backgroundUrl;
  }, [props.backgroundUrl, isVideoBg]);

  // Lyric font (Google fonts are fetched by Lambda's Chromium; wait for them).
  useEffect(() => {
    if (!props.lyrics.enabled) return;
    const family = props.lyrics.fontFamily;
    const handle = delayRender(`font:${family}`, { timeoutInMilliseconds: 30000 });
    let done = false;
    ensureLyricFontLoaded(family).finally(() => {
      if (done) return;
      done = true;
      setFontsReady((n) => n + 1);
      continueRender(handle);
    });
  }, [props.lyrics.enabled, props.lyrics.fontFamily]);

  // ── Video background: frames are handed to us by OffthreadVideo and drawn
  // INTO the canvas (same as the preview), so blur / scale / tint / blend
  // modes composite against the video pixels exactly like the editor.
  const videoFrameRef = useRef<BackgroundSource | null>(null);
  const videoHandleRef = useRef<number | null>(null);
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
      setVideoLoopFrames(dur > 0 ? Math.max(1, Math.round(dur * fps)) : durationInFrames);
      continueRender(handle);
    };
    v.onerror = () => { setVideoLoopFrames(durationInFrames); continueRender(handle); };
    v.src = props.backgroundUrl;
  }, [props.backgroundUrl, isVideoBg, fps, durationInFrames]);

  // ── Paint one frame. Called from the layout effect (before screenshot) and
  // again when a video frame arrives.
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const cfg = props.visualizer;
    const time = (frame / fps) * (cfg.animationSpeed ?? 1);
    const audio = audioForFrame(frame);
    const source = isVideoBg ? videoFrameRef.current : bgImg;

    drawBackgroundLayers({
      ctx, w: width, h: height, cfg, audio, effects: props.effects,
      source, cacheable: !isVideoBg && !!bgImg, color: props.backgroundColor ?? null,
    });
    drawForegroundLayers({
      ctx, w: width, h: height, cfg, audio, t: time,
      effects: props.effects, lyrics: props.lyrics,
      logo: logoImg, dt: 1 / fps, stateKey: "render", title: props.title,
    });
  }, [frame, fps, width, height, props.visualizer, props.effects, props.lyrics, props.backgroundColor, props.title, audioForFrame, isVideoBg, bgImg, logoImg]);

  // Hold the screenshot until this frame's video image has been drawn.
  useEffect(() => {
    if (!isVideoBg) return;
    const handle = delayRender(`videoFrame:${frame}`, { timeoutInMilliseconds: 60000 });
    videoHandleRef.current = handle;
    // Safety valve: never hang a render on a frame that doesn't arrive.
    const timer = setTimeout(() => {
      if (videoHandleRef.current === handle) {
        videoHandleRef.current = null;
        paint();
        continueRender(handle);
      }
    }, 15000);
    return () => {
      clearTimeout(timer);
      if (videoHandleRef.current === handle) {
        videoHandleRef.current = null;
        continueRender(handle);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, isVideoBg]);

  const onVideoFrame = useCallback((img: CanvasImageSource) => {
    videoFrameRef.current = img as BackgroundSource;
    paint();
    const handle = videoHandleRef.current;
    if (handle !== null) {
      videoHandleRef.current = null;
      continueRender(handle);
    }
  }, [paint]);

  // useLayoutEffect ensures the bitmap is updated before Remotion's screenshot.
  useLayoutEffect(() => {
    paint();
  }, [paint, fontsReady]);

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {isVideoBg && props.backgroundUrl && videoLoopFrames !== null ? (
        // Invisible: the frame is drawn into the canvas by onVideoFrame.
        <AbsoluteFill style={{ opacity: 0 }}>
          <Loop durationInFrames={videoLoopFrames} layout="none">
            <OffthreadVideo
              src={props.backgroundUrl}
              muted
              onVideoFrame={onVideoFrame}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </Loop>
        </AbsoluteFill>
      ) : null}
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", position: "relative" }} />
      <Audio src={props.audioUrl} />
    </AbsoluteFill>
  );
};
