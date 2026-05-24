import { useEffect, useState, useCallback } from "react";
import { get as idbGet, set as idbSet } from "idb-keyval";
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

const write = (k: string, v: unknown) => {
  if (typeof window !== "undefined") localStorage.setItem(k, JSON.stringify(v));
};

const mergeProjects = (primary: Project[], secondary: Project[]) => {
  const merged = new Map<string, Project>();
  for (const project of [...secondary, ...primary]) {
    const existing = merged.get(project.id);
    if (!existing || (project.updatedAt || 0) >= (existing.updatedAt || 0)) {
      merged.set(project.id, project);
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
};

const mergeJobs = (primary: RenderJob[], secondary: RenderJob[]) => {
  const merged = new Map<string, RenderJob>();
  for (const job of [...secondary, ...primary]) {
    const existing = merged.get(job.id);
    const existingTs = existing ? Math.max(existing.completedAt || 0, existing.createdAt || 0) : -1;
    const jobTs = Math.max(job.completedAt || 0, job.createdAt || 0);
    if (!existing || jobTs >= existingTs) {
      merged.set(job.id, job);
    }
  }
  return Array.from(merged.values()).sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
};

const persistProjects = (projects: Project[]) => {
  write(KEY, projects);
  void idbSet(KEY, projects);
};

const persistJobs = (jobs: RenderJob[]) => {
  write(JOBS_KEY, jobs);
  void idbSet(JOBS_KEY, jobs);
};

export const listProjects = (): Project[] => read<Project[]>(KEY, []);

export const listProjectsFromStorage = async (): Promise<Project[]> => {
  const local = listProjects();
  const indexed = (await idbGet<Project[]>(KEY)) ?? [];
  const merged = mergeProjects(local, indexed);
  if (merged.length !== local.length || merged.length !== indexed.length) {
    persistProjects(merged);
  } else if (local.length === 0 && merged.length > 0) {
    persistProjects(merged);
  }
  return merged;
};

export const getProject = (id: string): Project | undefined => listProjects().find(p => p.id === id);

export const getProjectFromStorage = async (id: string): Promise<Project | undefined> => {
  const local = getProject(id);
  if (local) return local;
  const projects = await listProjectsFromStorage();
  return projects.find((project) => project.id === id);
};

export const saveProject = (p: Project) => {
  const all = listProjects();
  const i = all.findIndex(x => x.id === p.id);
  p.updatedAt = Date.now();
  const persisted: Project = {
    ...p,
    audio: stripAssetUrl(p.audio),
    logo: stripAssetUrl(p.logo),
    background: stripAssetUrl(p.background),
  };
  if (i >= 0) all[i] = persisted; else all.unshift(persisted);
  persistProjects(all);
};

export const deleteProject = (id: string) => {
  persistProjects(listProjects().filter(p => p.id !== id));
};

export const duplicateProject = (id: string): Project | undefined => {
  const p = getProject(id); if (!p) return;
  const copy: Project = { ...JSON.parse(JSON.stringify(p)), id: crypto.randomUUID(), name: `${p.name} (Copy)`, createdAt: Date.now(), updatedAt: Date.now() };
  saveProject(copy); return copy;
};

export const listJobs = (): RenderJob[] => read<RenderJob[]>(JOBS_KEY, []);

export const listJobsFromStorage = async (): Promise<RenderJob[]> => {
  const local = listJobs();
  const indexed = (await idbGet<RenderJob[]>(JOBS_KEY)) ?? [];
  const merged = mergeJobs(local, indexed);
  if (merged.length !== local.length || merged.length !== indexed.length) {
    persistJobs(merged);
  } else if (local.length === 0 && merged.length > 0) {
    persistJobs(merged);
  }
  return merged;
};

export const saveJob = (j: RenderJob) => {
  const all = listJobs();
  const i = all.findIndex(x => x.id === j.id);
  const persisted: RenderJob = {
    ...j,
    localAsset: stripAssetUrl(j.localAsset),
  };
  if (i >= 0) all[i] = persisted; else all.unshift(persisted);
  persistJobs(all);
};

export const deleteJob = (id: string) => {
  persistJobs(listJobs().filter(j => j.id !== id));
};

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let cancelled = false;
    setProjects(listProjects());
    void listProjectsFromStorage().then((next) => {
      if (!cancelled) setProjects(next);
    });
    return () => { cancelled = true; };
  }, []);
  const refresh = useCallback(() => {
    setProjects(listProjects());
    void listProjectsFromStorage().then(setProjects);
  }, []);
  return { projects, refresh };
}

function migrateProject(p: Project): Project {
  const dv = defaultVisualizer();
  const dl = defaultLyrics();
  const de = defaultEffects();
  return {
    ...p,
    visualizer: { ...dv, ...p.visualizer, position: { ...dv.position, ...(p.visualizer?.position || {}) }, logoPosition: { ...dv.logoPosition, ...(p.visualizer?.logoPosition || {}) } },
    lyrics: { ...dl, ...(p.lyrics || {}) },
    effects: { ...de, ...(p.effects || {}), particles: { ...de.particles, ...((p.effects?.particles) || {}) } },
  };
}

async function hydrateProject(p: Project | undefined): Promise<Project | undefined> {
  if (!p) return p;
  const migrated = migrateProject(p);
  const [audio, logo, background] = await Promise.all([
    hydrateAsset(migrated.audio),
    hydrateAsset(migrated.logo),
    hydrateAsset(migrated.background),
  ]);
  return { ...migrated, audio, logo, background };
}

export function useProject(id: string) {
  const [project, setProject] = useState<Project | undefined>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getProjectFromStorage(id).then(hydrateProject).then(p => {
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

