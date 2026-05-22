import { get } from "idb-keyval";
import type { AssetRef } from "@/lib/project/types";
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "render-assets";
const uploadedCache = new Map<string, string>();

async function getBlob(ref: AssetRef): Promise<Blob | null> {
  const blob = await get<Blob>(`asset:${ref.id}`);
  return blob ?? null;
}

export async function uploadAssetForRender(ref: AssetRef | undefined): Promise<string | null> {
  if (!ref) return null;
  const cached = uploadedCache.get(ref.id);
  if (cached) return cached;

  const blob = await getBlob(ref);
  if (!blob) return null;

  const ext = (ref.name.split(".").pop() || "bin").toLowerCase();
  const path = `${ref.id}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: ref.type || "application/octet-stream", upsert: true });
  if (error && !`${error.message}`.toLowerCase().includes("exists")) {
    throw error;
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  uploadedCache.set(ref.id, data.publicUrl);
  return data.publicUrl;
}
