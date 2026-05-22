import { useEffect, useState, useCallback } from "react";
import type { Project, RenderJob, VisualizerConfig, LyricsConfig, EffectsConfig, ExportConfig } from "./types";
import { hydrateAsset, stripAssetUrl } from "./assets";

const KEY = "mv.projects.v1";
const JOBS_KEY = "mv.jobs.v1";

export const defaultVisualizer = (presetId = "circular-spectrum"): VisualizerConfig => ({
  presetId,
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
});

export const defaultLyrics = (): LyricsConfig => ({
  enabled: false, lines: [], style: "subtitle", position: "bottom",
  fontFamily: "Space Grotesk", fontSize: 42, color: "#ffffff",
  outline: true, shadow: true, glow: false, fade: true,
});

export const defaultEffects = (): EffectsConfig => ({
  particles: { enabled: true, type: "dust", density: 40, speed: 0.4, color: "#ffffff", opacity: 0.35, reactivity: 0.3 },
  beatFlash: false, vignette: true, noise: false, lensFlare: false, logoPulse: true, backgroundPulse: false,
});

export const defaultExport = (): ExportConfig => ({ resolution: "1080p", fps: 60, quality: "high" });

export const newProject = (name = "Untitled Project"): Project => ({
  id: crypto.randomUUID(),
  name,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  aspectRatio: "16:9",
  visualizer: defaultVisualizer(),
  lyrics: defaultLyrics(),
  effects: defaultEffects(),
  export: defaultExport(),
});

const read = <T,>(k: string, fallback: T): T => {
  if (typeof window === "undefined") return fallback;
  try { return JSON.parse(localStorage.getItem(k) || "") ?? fallback; } catch { return fallback; }
};
const write = (k: string, v: unknown) => { if (typeof window !== "undefined") localStorage.setItem(k, JSON.stringify(v)); };

export const listProjects = (): Project[] => read<Project[]>(KEY, []);
export const getProject = (id: string): Project | undefined => listProjects().find(p => p.id === id);
export const saveProject = (p: Project) => {
  const all = listProjects();
  const i = all.findIndex(x => x.id === p.id);
  p.updatedAt = Date.now();
  // Don't persist transient object URLs — they're regenerated on load.
  const persisted: Project = {
    ...p,
    audio: stripAssetUrl(p.audio),
    logo: stripAssetUrl(p.logo),
    background: stripAssetUrl(p.background),
  };
  if (i >= 0) all[i] = persisted; else all.unshift(persisted);
  write(KEY, all);
};
export const deleteProject = (id: string) => write(KEY, listProjects().filter(p => p.id !== id));
export const duplicateProject = (id: string): Project | undefined => {
  const p = getProject(id); if (!p) return;
  const copy: Project = { ...JSON.parse(JSON.stringify(p)), id: crypto.randomUUID(), name: `${p.name} (Copy)`, createdAt: Date.now(), updatedAt: Date.now() };
  saveProject(copy); return copy;
};

export const listJobs = (): RenderJob[] => read<RenderJob[]>(JOBS_KEY, []);
export const saveJob = (j: RenderJob) => {
  const all = listJobs();
  const i = all.findIndex(x => x.id === j.id);
  if (i >= 0) all[i] = j; else all.unshift(j);
  write(JOBS_KEY, all);
};

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => { setProjects(listProjects()); }, []);
  const refresh = useCallback(() => setProjects(listProjects()), []);
  return { projects, refresh };
}

async function hydrateProject(p: Project | undefined): Promise<Project | undefined> {
  if (!p) return p;
  const [audio, logo, background] = await Promise.all([
    hydrateAsset(p.audio),
    hydrateAsset(p.logo),
    hydrateAsset(p.background),
  ]);
  return { ...p, audio, logo, background };
}

export function useProject(id: string) {
  const [project, setProject] = useState<Project | undefined>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    hydrateProject(getProject(id)).then(p => {
      if (cancelled) return;
      setProject(p);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [id]);
  const update = useCallback((updater: (p: Project) => Project) => {
    setProject(prev => {
      if (!prev) return prev;
      const next = updater(prev);
      saveProject(next);
      return next;
    });
  }, []);
  return { project, setProject, update, loaded };
}

