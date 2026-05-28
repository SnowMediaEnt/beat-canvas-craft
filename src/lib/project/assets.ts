import { get, set, del } from "idb-keyval";
import type { AssetRef } from "./types";
import { PRESET_BG_PREFIX, getPresetBackground } from "@/lib/visualizer/backgrounds";

const urlCache = new Map<string, string>();

export async function storeAsset(file: File): Promise<AssetRef> {
  const id = crypto.randomUUID();
  // Read the bytes into memory and store a fresh Blob, not the File itself.
  // A File is backed by an OS file handle — after a browser restart, or if the
  // user moves / renames / deletes the source file, reading it later throws
  // NotReadableError ("The I/O read operation failed.") when we try to upload.
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
    // idb-keyval can reject with a DOMException or a raw IDB error event whose
    // .message is empty / null (notably in Safari private mode or when storage
    // is full). Re-throw with a useful message so the UI can show something
    // other than "null".
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
  return { id, name: file.name, type: blob.type, url };
}

export async function hydrateAsset(ref: AssetRef | undefined): Promise<AssetRef | undefined> {
  if (!ref) return ref;
  // Built-in preset background — resolve URL from bundled asset catalog.
  if (ref.id.startsWith(PRESET_BG_PREFIX)) {
    const bg = getPresetBackground(ref.id.slice(PRESET_BG_PREFIX.length));
    return bg ? { ...ref, url: bg.url } : { ...ref, url: "" };
  }
  if (ref.url && urlCache.get(ref.id) === ref.url) return ref;
  const cached = urlCache.get(ref.id);
  if (cached) return { ...ref, url: cached };
  const blob = await get<Blob>(`asset:${ref.id}`);
  if (!blob) return { ...ref, url: "" };
  const url = URL.createObjectURL(blob);
  urlCache.set(ref.id, url);
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
  await del(`asset:${ref.id}`);
}

export function stripAssetUrl<T extends AssetRef | undefined>(ref: T): T {
  if (!ref) return ref;
  return { ...ref, url: "" } as T;
}
