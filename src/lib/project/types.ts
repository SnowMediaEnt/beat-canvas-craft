export type AspectRatio = "16:9" | "1:1" | "9:16" | "4:5";

export interface AssetRef {
  id: string;
  name: string;
  type: string;
  /** Transient object URL — regenerated on load, never persisted. */
  url: string;
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
  reactivity: number; // visual amplitude multiplier (0..3)
  bandCount: number;  // number of equalizer bands (3,5,7,10,12,16,24,32)
}

export interface LyricLine { time: number; text: string; }

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
}

export interface EffectsConfig {
  particles: { enabled: boolean; type: "snow" | "dust" | "sparks" | "bokeh" | "lights"; density: number; speed: number; color: string; opacity: number; reactivity: number };
  beatFlash: boolean;
  vignette: boolean;
  noise: boolean;
  lensFlare: boolean;
  logoPulse: boolean;
  backgroundPulse: boolean;
}

export interface ExportConfig {
  resolution: "1080p" | "720p";
  fps: 30 | 60;
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
  thumbnail?: string;
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
}
