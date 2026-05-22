import { get, set, del } from "idb-keyval";
import type { AssetRef } from "./types";
import { PRESET_BG_PREFIX, getPresetBackground } from "@/lib/visualizer/backgrounds";

const urlCache = new Map<string, string>();

export async function storeAsset(file: File): Promise<AssetRef> {
  const id = crypto.randomUUID();
  await set(`asset:${id}`, file);
  const url = URL.createObjectURL(file);
  urlCache.set(id, url);
  return { id, name: file.name, type: file.type, url };
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
