// Small per-project thumbnail store. Thumbnails are JPEG data URLs captured
// from the live preview canvas. They live OUTSIDE the Project object so
// writing one doesn't re-render the editor or bloat project JSON, and so
// deleting a project can drop its image in one place.

const KEY = "mv.thumbs.v1";
const MAX_ENTRIES = 60;
const THUMB_WIDTH = 480;

type ThumbMap = Record<string, { url: string; at: number }>;

const listeners = new Set<() => void>();

function read(): ThumbMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as ThumbMap) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(map: ThumbMap) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch (error) {
    // Storage full — drop the oldest half and retry once.
    try {
      const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, Math.ceil(MAX_ENTRIES / 2));
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      console.warn("[thumbnails] failed to persist", error);
    }
  }
  for (const l of listeners) l();
}

export function getThumbnail(projectId: string): string | undefined {
  return read()[projectId]?.url;
}

export function getAllThumbnails(): Record<string, string> {
  const map = read();
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(map)) out[id] = v.url;
  return out;
}

export function saveThumbnail(projectId: string, dataUrl: string) {
  const map = read();
  map[projectId] = { url: dataUrl, at: Date.now() };
  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    const sorted = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    write(Object.fromEntries(sorted));
  } else {
    write(map);
  }
}

export function deleteThumbnail(projectId: string) {
  const map = read();
  if (map[projectId]) {
    delete map[projectId];
    write(map);
  }
}

export function subscribeThumbnails(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Downscale a source canvas to a small JPEG data URL. Returns null when the
 * canvas is empty/tainted or the browser refuses to encode.
 */
export function captureCanvasThumbnail(source: HTMLCanvasElement, quality = 0.72): string | null {
  try {
    if (!source.width || !source.height) return null;
    const scale = Math.min(1, THUMB_WIDTH / source.width);
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    return off.toDataURL("image/jpeg", quality);
  } catch {
    return null;
  }
}
