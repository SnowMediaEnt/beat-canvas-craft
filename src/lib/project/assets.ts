import { get, set, del } from "idb-keyval";
import type { AssetRef } from "./types";
import { PRESET_BG_PREFIX, COLOR_BG_PREFIX, getPresetBackground, solidColorBackgroundRef } from "@/lib/visualizer/backgrounds";

const urlCache = new Map<string, string>();

/**
 * Read a media file's duration without decoding it fully. Resolves undefined
 * when the browser can't tell (or after a short timeout) so uploads are
 * never blocked on it.
 */
export function probeMediaDuration(blob: Blob, timeoutMs = 8000): Promise<number | undefined> {
  if (typeof document === "undefined") return Promise.resolve(undefined);
  const type = blob.type || "";
  const isAudio = type.startsWith("audio/");
  const isVideo = type.startsWith("video/");
  if (!isAudio && !isVideo) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const el = document.createElement(isVideo ? "video" : "audio");
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (value: number | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      try { el.load(); } catch { /* ignore */ }
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () => {
      const d = el.duration;
      finish(Number.isFinite(d) && d > 0 ? d : undefined);
    };
    el.onerror = () => finish(undefined);
    el.src = url;
  });
}

export async function storeAsset(file: File): Promise<AssetRef> {
  const id = crypto.randomUUID();
  // Read the bytes into memory and store a fresh Blob, not the File itself.
  // A File is backed by an OS file handle — after a browser restart, or if the
  // user moves / renames / deletes the source file, reading it later throws.
  let blob: Blob;
  try {
    const buf = await file.arrayBuffer();
    blob = new Blob([buf], { type: file.type || "application/octet-stream" });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "";
    throw new Error(raw || "Couldn't read the selected file from disk.");
  }
  try {
    await set(`asset:${id}`, blob);
  } catch (err) {
    const raw =
      err instanceof Error
        ? err.message
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message ?? "")
          : "";
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    const detail =
      raw ||
      `Browser storage rejected the file (${sizeMB} MB). It may be too large, storage is full, or private/incognito mode is blocking IndexedDB.`;
    throw new Error(detail);
  }
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  const duration = await probeMediaDuration(blob);
  return { id, name: file.name, type: blob.type, url, ...(duration ? { duration } : {}) };
}

export async function hydrateAsset(ref: AssetRef | undefined): Promise<AssetRef | undefined> {
  if (!ref) return ref;
  // Built-in preset background — resolve URL from bundled asset catalog.
  if (ref.id.startsWith(PRESET_BG_PREFIX)) {
    const bg = getPresetBackground(ref.id.slice(PRESET_BG_PREFIX.length));
    return bg ? { ...ref, url: bg.url } : { ...ref, url: "" };
  }
  // Solid colour — regenerate the tiny data URL (never stored in IndexedDB).
  if (ref.id.startsWith(COLOR_BG_PREFIX)) {
    const regenerated = solidColorBackgroundRef(ref.id.slice(COLOR_BG_PREFIX.length));
    return { ...ref, url: regenerated.url };
  }
  if (ref.url && urlCache.get(ref.id) === ref.url) return ref;
  const cached = urlCache.get(ref.id);
  if (cached) return { ...ref, url: cached };
  const blob = await get<Blob>(`asset:${ref.id}`);
  if (!blob) return { ...ref, url: "" };
  const url = URL.createObjectURL(blob);
  urlCache.set(ref.id, url);
  // Back-fill duration for assets stored before we measured it.
  if (!ref.duration && (blob.type.startsWith("audio/") || blob.type.startsWith("video/"))) {
    const duration = await probeMediaDuration(blob, 4000);
    if (duration) return { ...ref, url, duration };
  }
  return { ...ref, url };
}

export async function getAssetDownloadUrl(ref: AssetRef | undefined): Promise<string | null> {
  if (!ref) return null;
  const hydrated = await hydrateAsset(ref);
  if (hydrated?.url) return hydrated.url;
  const blob = await get<Blob>(`asset:${ref.id}`);
  if (!blob) return null;
  const cached = urlCache.get(ref.id);
  if (cached) return cached;
  const url = URL.createObjectURL(blob);
  urlCache.set(ref.id, url);
  return url;
}

export async function deleteAsset(ref: AssetRef | undefined) {
  if (!ref) return;
  const cached = urlCache.get(ref.id);
  if (cached) { URL.revokeObjectURL(cached); urlCache.delete(ref.id); }
  if (ref.id.startsWith(PRESET_BG_PREFIX) || ref.id.startsWith(COLOR_BG_PREFIX)) return;
  await del(`asset:${ref.id}`);
}

export function stripAssetUrl<T extends AssetRef | undefined>(ref: T): T {
  if (!ref) return ref;
  return { ...ref, url: "" } as T;
}
