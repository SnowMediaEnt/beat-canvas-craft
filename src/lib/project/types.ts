export type AspectRatio = "16:9" | "1:1" | "9:16" | "4:5";

export interface AssetRef {
  id: string;
  name: string;
  type: string;
  /** Transient object URL — regenerated on load, never persisted. */
  url: string;
  /** Media duration in seconds (audio/video), measured at upload time. */
  duration?: number;
}

export interface CustomEqualizerConfig {
  /** Visual primitive used to render each band. */
  shape: "bars" | "mirrored" | "radial" | "ring" | "wave" | "dots" | "triangles";
  /** Number of bands (3..256). */
  count: number;
  /** Gap between bands as a fraction of slot width (0..0.9). */
  spacing: number;
  /** Min/max bar length multiplier vs available space (0..2). */
  amplitude: number;
  /** Stroke / bar width in baseline px (1..40). 0 = use cfg.thickness. */
  thickness: number;
  /** Rounded ends / corners. */
  rounded: boolean;
  /** Mirror left↔right for symmetric layouts. */
  symmetric: boolean;
  /** Local reactivity multiplier (0..3). */
  reactivity: number;
  /** Inner radius fraction for radial/ring (0..1). */
  innerRadius: number;
}

export interface VisualizerConfig {
  presetId: string;
  primary: string;
  secondary: string;
  accent: string;
  glow: string;
  overlay: string;
  overlayOpacity: number;
  glowIntensity: number;
  blur: number;
  size: number;       // 0.1 - 2
  thickness: number;  // 1 - 30
  position: { x: number; y: number }; // -1 .. 1
  logoSize: number;
  logoPosition: { x: number; y: number };
  backgroundScale: number;
  backgroundBlur: number;
  backgroundTint: string;
  backgroundTintOpacity: number;
  animationSpeed: number;
  sensitivity: number;
  bassSensitivity: number;
  midSensitivity: number;
  trebleSensitivity: number;
  smoothing: number;
  rotation: number;
  movement: number;
  shadow: number;
  border: number;
  blendMode: GlobalCompositeOperation;
  reactivity: number;
  bandCount: number;
  stationary: boolean;
  /** Settings used by the "custom-equalizer" preset only. Always present
   *  so the renderer and the preview share defaults. */
  custom: CustomEqualizerConfig;
}

export interface LyricWord { time: number; text: string; }
export interface LyricLine {
  time: number;
  text: string;
  /** Optional per-word start times (from auto-sync) for word-level karaoke. */
  words?: LyricWord[];
}

export type LyricAnimation = "none" | "slide" | "pop" | "typewriter";

export interface LyricsConfig {
  enabled: boolean;
  lines: LyricLine[];
  style: "subtitle" | "karaoke";
  position: "center" | "bottom" | "top" | "left" | "right";
  fontFamily: string;
  fontSize: number;
  color: string;
  outline: boolean;
  shadow: boolean;
  glow: boolean;
  fade: boolean;
  timingOffset?: number; // seconds; positive = show earlier, negative = show later
  /** Entrance animation for each new line. Default "none" (fade still applies). */
  animation?: LyricAnimation;
  /** Karaoke highlights word by word when word timings exist. Default true. */
  wordHighlight?: boolean;
  /** Show the upcoming line, smaller and dimmer, under the current one. Default false. */
  showNext?: boolean;
  /** Highlight colour for karaoke. Defaults to the visualizer glow colour. */
  highlightColor?: string;
  /** Uppercase all lyrics. Default false. */
  uppercase?: boolean;
}


export type ParticleType = "snow" | "dust" | "sparks" | "bokeh" | "lights" | "embers" | "stars";
export type ParticleTrigger = "volume" | "kick" | "snare" | "hat";

export interface ParticlesConfig {
  enabled: boolean;
  type: ParticleType;
  density: number;
  speed: number;
  color: string;
  opacity: number;
  reactivity: number;
  /** Size multiplier 0.3..3 (default 1). */
  size?: number;
  /** Extra randomness in motion 0..1 (default 0.3). */
  jitter?: number;
  /** Which signal drives speed/size bursts (default "volume"). */
  trigger?: ParticleTrigger;
  /** Size/alpha burst on the trigger 0..2 (default 0). */
  burst?: number;
}

export interface EffectsConfig {
  particles: ParticlesConfig;
  beatFlash: boolean;
  vignette: boolean;
  noise: boolean;
  lensFlare: boolean;
  logoPulse: boolean;
  logoBounce: boolean;
  /** Brightness flash on bass (legacy name kept for saved projects). */
  backgroundPulse: boolean;

  // ── Newer effects (all optional so older saved projects load unchanged) ──
  /** Whole-frame punch-in on kicks (zoom 0..0.15) + handheld shake (0..1). */
  camera?: { zoom: number; shake: number };
  /** Real zoom pulse of the background on bass, 0..0.2. */
  bgZoomPulse?: number;
  /** Mirror image of the visualizer below a horizon line. */
  reflection?: { enabled: boolean; opacity: number; height: number; horizon: number };
  /** Long-exposure after-images of the visualizer (decay 0.5..0.97). */
  trails?: { enabled: boolean; decay: number };
  /** Ghost copies shifted left/right on kicks, 0..1. */
  beatSplit?: number;
  /** Film-grain strength 0..0.3 (used when `noise` is on). */
  noiseAmount?: number;
  /** Diagonal light streaks that sweep on hits. */
  lightStreaks?: { enabled: boolean; intensity: number; color: string };
  /** Slow drifting fog layer. */
  fog?: { enabled: boolean; density: number; color: string; speed: number };
  /** Soft moving colour gradients behind the visualizer. */
  gradientWash?: { enabled: boolean; intensity: number };
  /** Expanding rings emitted on kicks. */
  ripples?: { enabled: boolean; intensity: number };
  /** Vignette that tightens with energy, 0..1 (0 = static vignette). */
  breathingVignette?: number;
}

export interface ExportConfig {
  resolution: "4k" | "1080p" | "720p";
  fps: 30 | 45 | 60 | 120;
  quality: "high" | "standard";
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  aspectRatio: AspectRatio;
  audio?: AssetRef;
  logo?: AssetRef;
  background?: AssetRef;
  visualizer: VisualizerConfig;
  lyrics: LyricsConfig;
  effects: EffectsConfig;
  export: ExportConfig;
  /** Legacy inline thumbnail; new thumbnails live in the thumbnail store. */
  thumbnail?: string;
  /** Song title shown by text-based presets (defaults to the project name). */
  trackTitle?: string;
  /** Artist name shown by text-based presets. */
  trackArtist?: string;
}

export interface RenderJob {
  id: string;
  projectId: string;
  projectName: string;
  kind?: "lambda" | "browser";
  status: "queued" | "rendering" | "completed" | "failed";
  progress: number;
  createdAt: number;
  completedAt?: number;
  sizeBytes?: number;
  downloadUrl?: string;
  localAsset?: AssetRef;
  fileFormat?: "mp4" | "webm";
  config: ExportConfig;
  aspectRatio: AspectRatio;
  error?: string;
  /** AWS Lambda render handle — kept so polling can resume after reload. */
  renderId?: string;
  bucketName?: string;
  /** AWS region the render bucket lives in (needed to build download URLs). */
  region?: string;
}
