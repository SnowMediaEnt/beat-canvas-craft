import { useEffect, useState, useCallback } from "react";
import { get as idbGet, set as idbSet } from "idb-keyval";
import { PRESETS } from "@/lib/visualizer/presets";
import type { Project, RenderJob, VisualizerConfig, LyricsConfig, EffectsConfig, ExportConfig, AssetRef, AspectRatio } from "./types";
import { hydrateAsset, stripAssetUrl } from "./assets";

const KEY = "mv.projects.v1";
const JOBS_KEY = "mv.jobs.v1";
const WINDOW_BACKUP_PREFIX = "__pulse_backup__:";
const VALID_ASPECT_RATIOS = new Set<AspectRatio>(["16:9", "1:1", "9:16", "4:5"]);
const VALID_PRESET_IDS = new Set(PRESETS.map((preset) => preset.id));
const VALID_PARTICLE_TYPES = new Set(["snow", "dust", "sparks", "bokeh", "lights"] as const);
// Matches the dropdown values in RightPanel exactly. Anything outside this set
// gets snapped to the default on the next save, which previously stripped any
// band count above 64 on reload.
const VALID_BAND_COUNTS = new Set([3, 5, 7, 10, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]);
const VALID_CUSTOM_SHAPES = new Set(["bars", "mirrored", "radial", "ring", "wave", "dots", "triangles"] as const);
type CustomShape = typeof VALID_CUSTOM_SHAPES extends Set<infer T> ? T : never;

type WindowBackupState = {
  projects?: Project[];
  jobs?: RenderJob[];
};

export const defaultCustomEqualizer = () => ({
  shape: "bars" as CustomShape,
  count: 48,
  spacing: 0.25,
  amplitude: 1,
  thickness: 0,
  rounded: true,
  symmetric: false,
  reactivity: 1,
  innerRadius: 0.35,
});

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
  smoothing: 0.5,
  rotation: 0,
  movement: 0,
  shadow: 0.4,
  border: 0,
  blendMode: "source-over",
  reactivity: 1,
  bandCount: 12,
  custom: defaultCustomEqualizer(),
});

export const defaultLyrics = (): LyricsConfig => ({
  enabled: false, lines: [], style: "subtitle", position: "bottom",
  fontFamily: "Arial", fontSize: 42, color: "#ffffff",
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

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const sanitizeText = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim().length > 0 ? value : fallback;

const sanitizeColor = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;

const sanitizeAssetRef = (ref: AssetRef | undefined): AssetRef | undefined => {
  if (!ref || typeof ref !== "object") return undefined;
  if (typeof ref.id !== "string" || typeof ref.name !== "string") return undefined;
  return {
    id: ref.id,
    name: ref.name,
    type: typeof ref.type === "string" ? ref.type : "",
    url: typeof ref.url === "string" ? ref.url : "",
  };
};

const read = <T,>(k: string, fallback: T): T => {
  if (typeof window === "undefined") return fallback;
  try { return JSON.parse(localStorage.getItem(k) || "") ?? fallback; } catch { return fallback; }
};

const write = (k: string, v: unknown) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (error) {
    console.warn(`[project-store] Failed to write ${k} to localStorage`, error);
  }
};

const readWindowBackup = (): WindowBackupState => {
  if (typeof window === "undefined") return {};
  const raw = window.name;
  if (!raw || !raw.startsWith(WINDOW_BACKUP_PREFIX)) return {};
  try {
    return JSON.parse(raw.slice(WINDOW_BACKUP_PREFIX.length)) as WindowBackupState;
  } catch {
    return {};
  }
};

const writeWindowBackup = (partial: WindowBackupState) => {
  if (typeof window === "undefined") return;
  if (window.name && !window.name.startsWith(WINDOW_BACKUP_PREFIX)) return;
  try {
    const current = readWindowBackup();
    window.name = `${WINDOW_BACKUP_PREFIX}${JSON.stringify({ ...current, ...partial })}`;
  } catch (error) {
    console.warn("[project-store] Failed to write window backup", error);
  }
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
  writeWindowBackup({ projects: projects.slice(0, 20) });
};

const persistJobs = (jobs: RenderJob[]) => {
  write(JOBS_KEY, jobs);
  void idbSet(JOBS_KEY, jobs);
  writeWindowBackup({ jobs: jobs.slice(0, 100) });
};

export const listProjects = (): Project[] => read<Project[]>(KEY, []).map(migrateProject);

export const listProjectsFromStorage = async (): Promise<Project[]> => {
  const local = listProjects();
  const indexed = (await idbGet<Project[]>(KEY)) ?? [];
  const backup = readWindowBackup().projects ?? [];
  const merged = mergeProjects(local, mergeProjects(indexed, backup));
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
  const next = migrateProject({ ...p, updatedAt: Date.now() });
  const persisted: Project = {
    ...next,
    audio: stripAssetUrl(next.audio),
    logo: stripAssetUrl(next.logo),
    background: stripAssetUrl(next.background),
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
  const backup = readWindowBackup().jobs ?? [];
  const merged = mergeJobs(local, mergeJobs(indexed, backup));
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
  const dx = defaultExport();
  const visualizer = p.visualizer || dv;
  const lyrics = p.lyrics || dl;
  const effects = p.effects || de;
  const presetId = typeof visualizer.presetId === "string" && VALID_PRESET_IDS.has(visualizer.presetId)
    ? visualizer.presetId
    : dv.presetId;

  return {
    ...p,
    id: sanitizeText(p.id, crypto.randomUUID()),
    name: sanitizeText(p.name, "Untitled Project"),
    createdAt: clamp(p.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    updatedAt: clamp(p.updatedAt, 0, Number.MAX_SAFE_INTEGER, p.createdAt || Date.now()),
    aspectRatio: VALID_ASPECT_RATIOS.has(p.aspectRatio) ? p.aspectRatio : "16:9",
    audio: sanitizeAssetRef(p.audio),
    logo: sanitizeAssetRef(p.logo),
    background: sanitizeAssetRef(p.background),
    visualizer: {
      ...dv,
      ...visualizer,
      presetId,
      primary: sanitizeColor(visualizer.primary, dv.primary),
      secondary: sanitizeColor(visualizer.secondary, dv.secondary),
      accent: sanitizeColor(visualizer.accent, dv.accent),
      glow: sanitizeColor(visualizer.glow, dv.glow),
      overlay: sanitizeColor(visualizer.overlay, dv.overlay),
      backgroundTint: sanitizeColor(visualizer.backgroundTint, dv.backgroundTint),
      overlayOpacity: clamp(visualizer.overlayOpacity, 0, 1, dv.overlayOpacity),
      glowIntensity: clamp(visualizer.glowIntensity, 0, 3, dv.glowIntensity),
      blur: clamp(visualizer.blur, 0, 24, dv.blur),
      size: clamp(visualizer.size, 0.1, 2, dv.size),
      thickness: clamp(visualizer.thickness, 1, 30, dv.thickness),
      position: {
        x: clamp(visualizer.position?.x, -1, 1, dv.position.x),
        y: clamp(visualizer.position?.y, -1, 1, dv.position.y),
      },
      logoSize: clamp(visualizer.logoSize, 0.05, 1.2, dv.logoSize),
      logoPosition: {
        x: clamp(visualizer.logoPosition?.x, -1, 1, dv.logoPosition.x),
        y: clamp(visualizer.logoPosition?.y, -1, 1, dv.logoPosition.y),
      },
      backgroundScale: clamp(visualizer.backgroundScale, 0.5, 2, dv.backgroundScale),
      backgroundBlur: clamp(visualizer.backgroundBlur, 0, 24, dv.backgroundBlur),
      backgroundTintOpacity: clamp(visualizer.backgroundTintOpacity, 0, 1, dv.backgroundTintOpacity),
      animationSpeed: clamp(visualizer.animationSpeed, 0.1, 4, dv.animationSpeed),
      sensitivity: clamp(visualizer.sensitivity, 0.1, 3, dv.sensitivity),
      bassSensitivity: clamp(visualizer.bassSensitivity, 0.1, 3, dv.bassSensitivity),
      midSensitivity: clamp(visualizer.midSensitivity, 0.1, 3, dv.midSensitivity),
      trebleSensitivity: clamp(visualizer.trebleSensitivity, 0.1, 3, dv.trebleSensitivity),
      smoothing: clamp(visualizer.smoothing, 0, 0.95, dv.smoothing),
      rotation: clamp(visualizer.rotation, -Math.PI * 2, Math.PI * 2, dv.rotation),
      movement: clamp(visualizer.movement, 0, 2, dv.movement),
      shadow: clamp(visualizer.shadow, 0, 2, dv.shadow),
      border: clamp(visualizer.border, 0, 2, dv.border),
      reactivity: clamp(visualizer.reactivity, 0, 3, dv.reactivity),
      bandCount: VALID_BAND_COUNTS.has(visualizer.bandCount) ? visualizer.bandCount : dv.bandCount,
      custom: (() => {
        const dc = defaultCustomEqualizer();
        const c = (visualizer as Partial<VisualizerConfig>).custom ?? dc;
        return {
          shape: VALID_CUSTOM_SHAPES.has(c.shape as CustomShape) ? (c.shape as CustomShape) : dc.shape,
          count: Math.round(clamp(c.count, 3, 256, dc.count)),
          spacing: clamp(c.spacing, 0, 0.9, dc.spacing),
          amplitude: clamp(c.amplitude, 0, 2, dc.amplitude),
          thickness: clamp(c.thickness, 0, 40, dc.thickness),
          rounded: typeof c.rounded === "boolean" ? c.rounded : dc.rounded,
          symmetric: typeof c.symmetric === "boolean" ? c.symmetric : dc.symmetric,
          reactivity: clamp(c.reactivity, 0, 3, dc.reactivity),
          innerRadius: clamp(c.innerRadius, 0, 0.9, dc.innerRadius),
        };
      })(),
    },
    lyrics: {
      ...dl,
      ...lyrics,
      enabled: Boolean(lyrics.enabled),
      lines: Array.isArray(lyrics.lines)
        ? lyrics.lines
            .filter((line): line is { time: number; text: string } => !!line && typeof line.text === "string")
            .slice(0, 400)
            .map((line) => ({
              time: clamp(line.time, 0, Number.MAX_SAFE_INTEGER, 0),
              text: line.text,
            }))
        : dl.lines,
      fontFamily: sanitizeText(lyrics.fontFamily, dl.fontFamily),
      fontSize: clamp(lyrics.fontSize, 12, 160, dl.fontSize),
      color: sanitizeColor(lyrics.color, dl.color),
    },
    effects: {
      ...de,
      ...effects,
      particles: {
        ...de.particles,
        ...(effects.particles || {}),
        type: VALID_PARTICLE_TYPES.has(effects.particles?.type as typeof de.particles.type)
          ? effects.particles!.type
          : de.particles.type,
        density: clamp(effects.particles?.density, 0, 120, de.particles.density),
        speed: clamp(effects.particles?.speed, 0, 3, de.particles.speed),
        color: sanitizeColor(effects.particles?.color, de.particles.color),
        opacity: clamp(effects.particles?.opacity, 0, 1, de.particles.opacity),
        reactivity: clamp(effects.particles?.reactivity, 0, 3, de.particles.reactivity),
      },
      beatFlash: Boolean(effects.beatFlash),
      vignette: Boolean(effects.vignette),
      noise: Boolean(effects.noise),
      lensFlare: Boolean(effects.lensFlare),
      logoPulse: Boolean(effects.logoPulse),
      backgroundPulse: Boolean(effects.backgroundPulse),
    },
    export: {
      ...dx,
      ...(p.export || {}),
      resolution: p.export?.resolution === "4k" || p.export?.resolution === "720p" || p.export?.resolution === "1080p"
        ? p.export.resolution
        : dx.resolution,
      fps: p.export?.fps === 30 || p.export?.fps === 45 || p.export?.fps === 60 || p.export?.fps === 120
        ? p.export.fps
        : dx.fps,
      quality: p.export?.quality === "standard" || p.export?.quality === "high"
        ? p.export.quality
        : dx.quality,
    },
  };
}

async function hydrateProject(p: Project | undefined): Promise<Project | undefined> {
  if (!p) return p;
  const migrated = migrateProject(p);
  const safeHydrate = async (asset: AssetRef | undefined) => {
    try {
      return await hydrateAsset(asset);
    } catch {
      return asset ? { ...asset, url: "" } : undefined;
    }
  };
  const [audio, logo, background] = await Promise.all([
    safeHydrate(migrated.audio),
    safeHydrate(migrated.logo),
    safeHydrate(migrated.background),
  ]);
  return { ...migrated, audio, logo, background };
}

export function useProject(id: string) {
  const [project, setProject] = useState<Project | undefined>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getProjectFromStorage(id)
      .then(hydrateProject)
      .then((p) => {
        if (cancelled) return;
        setProject(p);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = getProject(id);
        setProject(fallback ? migrateProject(fallback) : undefined);
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

