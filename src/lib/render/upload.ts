import { get } from "idb-keyval";
import type { AssetRef } from "@/lib/project/types";
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "render-assets";
const uploadedCache = new Map<string, string>();

type UploadKind = "audio" | "background" | "logo" | "asset";

async function getBlob(ref: AssetRef): Promise<Blob | null> {
  const blob = await get<Blob>(`asset:${ref.id}`);
  return blob ?? null;
}

export async function uploadAssetForRender(ref: AssetRef | undefined): Promise<string | null> {
  if (!ref) return null;
  const cached = uploadedCache.get(ref.id);
  if (cached) {
    console.log("[render-upload] cache hit", { assetId: ref.id, name: ref.name, url: cached });
    return cached;
  }

  let blob = await getBlob(ref);
  if (!blob && ref.url) {
    // Preset / bundled asset: no IndexedDB blob, fetch the bundled URL instead.
    try {
      const res = await fetch(ref.url);
      if (res.ok) {
        blob = await res.blob();
        console.log("[render-upload] fetched bundled asset", { assetId: ref.id, url: ref.url, size: blob.size });
      } else {
        console.error("[render-upload] fetch bundled asset failed", { assetId: ref.id, url: ref.url, status: res.status });
      }
    } catch (e) {
      console.error("[render-upload] fetch bundled asset error", { assetId: ref.id, url: ref.url, error: e });
    }
  }
  if (!blob) {
    console.error("[render-upload] missing IndexedDB blob", { assetId: ref.id, name: ref.name, type: ref.type });
    return null;
  }


  const ext = (ref.name.split(".").pop() || "bin").toLowerCase();
  const path = `${ref.id}.${ext}`;

  console.log("[render-upload] upload start", {
    assetId: ref.id,
    name: ref.name,
    type: ref.type,
    indexedDbKey: `asset:${ref.id}`,
    bucket: BUCKET,
    path,
    size: blob.size,
  });

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: ref.type || "application/octet-stream", upsert: true });
  if (error && !`${error.message}`.toLowerCase().includes("exists")) {
    console.error("[render-upload] upload error", {
      assetId: ref.id,
      name: ref.name,
      path,
      message: error.message,
    });
    throw error;
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data.publicUrl) {
    console.error("[render-upload] public URL missing", { assetId: ref.id, name: ref.name, path });
    return null;
  }
  console.log("[render-upload] upload success", {
    assetId: ref.id,
    name: ref.name,
    path,
    publicUrl: data.publicUrl,
  });
  uploadedCache.set(ref.id, data.publicUrl);
  return data.publicUrl;
}

export function assertRenderableAssetUrl(kind: UploadKind, url: string | null | undefined) {
  if (typeof url === "string" && url.trim().length > 0) return url;

  const messageByKind: Record<UploadKind, string> = {
    audio: "Audio upload failed — cannot render",
    background: "Background upload failed — cannot render with the selected background",
    logo: "Logo upload failed — cannot render with the selected logo",
    asset: "Asset upload failed — cannot render",
  };

  throw new Error(messageByKind[kind]);
}
