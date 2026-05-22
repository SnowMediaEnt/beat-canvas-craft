import type { Project } from "@/lib/project/types";
import { presetBackgroundRef } from "./backgrounds";

export interface ThemePackage {
  id: string;
  name: string;
  description: string;
  backgroundId: string;
  presetId: string;
  colors: { primary: string; secondary: string; accent: string; glow: string; tint: string };
  glowIntensity?: number;
  bgBlur?: number;
  tintOpacity?: number;
}

export const PACKAGES: ThemePackage[] = [
  {
    id: "aurora-pulse", name: "Aurora Pulse", description: "Cinematic night sky with circular waves",
    backgroundId: "aurora", presetId: "circular-spectrum",
    colors: { primary: "#22e3ff", secondary: "#7affb1", accent: "#a48bff", glow: "#22e3ff", tint: "#06121f" },
    glowIntensity: 0.9, bgBlur: 4, tintOpacity: 0.2,
  },
  {
    id: "deep-ocean", name: "Deep Ocean", description: "Underwater ambience with soft glow",
    backgroundId: "ocean", presetId: "bass-glow",
    colors: { primary: "#5cdfff", secondary: "#3b82f6", accent: "#a0e8ff", glow: "#5cdfff", tint: "#001022" },
    glowIntensity: 1, bgBlur: 0, tintOpacity: 0.1,
  },
  {
    id: "sunset-ribbons", name: "Sunset Ribbons", description: "Warm sky with flowing waves",
    backgroundId: "sunset-clouds", presetId: "ribbons",
    colors: { primary: "#ffd166", secondary: "#ff6b6b", accent: "#ff9ed8", glow: "#ff8a5c", tint: "#1a0608" },
    glowIntensity: 0.7, bgBlur: 8, tintOpacity: 0.25,
  },
  {
    id: "cosmic-tunnel", name: "Cosmic Tunnel", description: "Nebula with frequency rings",
    backgroundId: "nebula", presetId: "tunnel",
    colors: { primary: "#b14bff", secondary: "#22e3ff", accent: "#ff4bd1", glow: "#b14bff", tint: "#0a0220" },
    glowIntensity: 1, bgBlur: 2, tintOpacity: 0.3,
  },
  {
    id: "neon-pulse", name: "Neon Pulse", description: "Cyberpunk city with mirrored EQ",
    backgroundId: "neon-city", presetId: "mirrored-bars",
    colors: { primary: "#ff2bd1", secondary: "#22e3ff", accent: "#a48bff", glow: "#ff2bd1", tint: "#08051a" },
    glowIntensity: 0.85, bgBlur: 6, tintOpacity: 0.35,
  },
  {
    id: "forest-calm", name: "Forest Calm", description: "Misty woods with ambient pulse",
    backgroundId: "forest-mist", presetId: "ambient-pulse",
    colors: { primary: "#9be15d", secondary: "#f0c674", accent: "#7ad7ff", glow: "#bdf26b", tint: "#04120a" },
    glowIntensity: 0.6, bgBlur: 4, tintOpacity: 0.2,
  },
  {
    id: "golden-wave", name: "Golden Wave", description: "Warm horizon with bottom waveform",
    backgroundId: "golden-hour", presetId: "bottom-wave",
    colors: { primary: "#ffb84d", secondary: "#ff6b6b", accent: "#ffe29a", glow: "#ffb84d", tint: "#1b0a02" },
    glowIntensity: 0.5, bgBlur: 0, tintOpacity: 0.15,
  },
  {
    id: "midnight-tide", name: "Midnight Tide", description: "Dark ocean with light wave",
    backgroundId: "dark-waves", presetId: "light-wave",
    colors: { primary: "#7ad7ff", secondary: "#5cdfff", accent: "#ffffff", glow: "#7ad7ff", tint: "#00060f" },
    glowIntensity: 0.8, bgBlur: 0, tintOpacity: 0.3,
  },
  {
    id: "twilight-orbit", name: "Twilight Orbit", description: "Dusk silhouette with radial bars",
    backgroundId: "mountain-dusk", presetId: "radial-bars",
    colors: { primary: "#ff6cb5", secondary: "#7b5cff", accent: "#22e3ff", glow: "#ff6cb5", tint: "#0a0420" },
    glowIntensity: 1, bgBlur: 0, tintOpacity: 0.2,
  },
  {
    id: "cherry-bloom", name: "Cherry Bloom", description: "Soft pink dream with liquid blob",
    backgroundId: "cherry-sky", presetId: "liquid-blob",
    colors: { primary: "#ff8cc1", secondary: "#ffd1ea", accent: "#a48bff", glow: "#ffb1da", tint: "#1c0a14" },
    glowIntensity: 0.7, bgBlur: 6, tintOpacity: 0.2,
  },
  {
    id: "lava-storm", name: "Lava Storm", description: "Molten energy with diamond frame",
    backgroundId: "lava", presetId: "diamond-frame",
    colors: { primary: "#ff3b1f", secondary: "#ffb84d", accent: "#ff6b6b", glow: "#ff3b1f", tint: "#0a0000" },
    glowIntensity: 1.2, bgBlur: 0, tintOpacity: 0.1,
  },
  {
    id: "retro-grid", name: "Retro Grid", description: "Synthwave with equalizer bars",
    backgroundId: "synthwave", presetId: "eq-bars",
    colors: { primary: "#ff2bd1", secondary: "#22e3ff", accent: "#ffd166", glow: "#ff2bd1", tint: "#0a0218" },
    glowIntensity: 0.8, bgBlur: 0, tintOpacity: 0.2,
  },
  {
    id: "stellar-drift", name: "Stellar Drift", description: "Starfield with floating orb",
    backgroundId: "starfield", presetId: "floating-orb",
    colors: { primary: "#a48bff", secondary: "#22e3ff", accent: "#ffffff", glow: "#a48bff", tint: "#02020a" },
    glowIntensity: 1, bgBlur: 0, tintOpacity: 0.15,
  },
  {
    id: "noir-smoke", name: "Noir Smoke", description: "Minimal black with double circular",
    backgroundId: "smoke", presetId: "double-circular",
    colors: { primary: "#e8e8e8", secondary: "#c9a84c", accent: "#a48bff", glow: "#ffffff", tint: "#000000" },
    glowIntensity: 0.6, bgBlur: 0, tintOpacity: 0.2,
  },
  {
    id: "iridescent-flow", name: "Iridescent Flow", description: "Holographic swirl with oscilloscope",
    backgroundId: "liquid-ink", presetId: "oscilloscope",
    colors: { primary: "#ffffff", secondary: "#22e3ff", accent: "#ff6cb5", glow: "#ffffff", tint: "#080018" },
    glowIntensity: 0.9, bgBlur: 0, tintOpacity: 0.15,
  },
];

export function applyPackage(p: Project, pkg: ThemePackage): Project {
  return {
    ...p,
    background: presetBackgroundRef(pkg.backgroundId) ?? p.background,
    visualizer: {
      ...p.visualizer,
      presetId: pkg.presetId,
      primary: pkg.colors.primary,
      secondary: pkg.colors.secondary,
      accent: pkg.colors.accent,
      glow: pkg.colors.glow,
      backgroundTint: pkg.colors.tint,
      backgroundTintOpacity: pkg.tintOpacity ?? p.visualizer.backgroundTintOpacity,
      backgroundBlur: pkg.bgBlur ?? p.visualizer.backgroundBlur,
      glowIntensity: pkg.glowIntensity ?? p.visualizer.glowIntensity,
    },
  };
}
