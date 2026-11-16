import { get } from "idb-keyval";
import type { AssetRef } from "@/lib/project/types";
import { ACCESS_CODE_HEADER } from "./access-code";
import { prepareAudioForRender } from "@/lib/audio/convert-wav";

const UPLOAD_ENDPOINT = "/api/public/render-upload";
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

const uploadedCache = new Map<string, string>();

type UploadKind = "audio" | "background" | "logo" | "asset";

function getSafeExt(name: string) {
  return (name.split(".").pop() || "bin")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "bin";
}

/** Server accepts /^[a-zA-Z0-9_.:-]{1,128}$/ — normalise anything else. */
export function safeAssetId(id: string) {
  const cleaned = id.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 128);
  return cleaned || "asset";
}

export async function uploadBlobForRender({
  assetId,
  fileName,
  contentType,
  blob,
  accessCode,
  onProgress,
}: {
  assetId: string;
  fileName: string;
  contentType: string;
  blob: Blob;
  accessCode: string;
  onProgress?: (progress: number) => void;
}): Promise<string> {
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `"${fileName}" is too large to render (${(blob.size / 1024 / 1024).toFixed(1)} MB). The maximum is 200 MB.`,
    );
  }

  const ext = getSafeExt(fileName);

  // Materialize the blob to an ArrayBuffer before sending. Some browsers
  // (notably Safari) fail with a generic "Load failed" when streaming a
  // Blob pulled from IndexedDB directly through fetch.
  let body: ArrayBuffer;
  try {
    body = await blob.arrayBuffer();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotFoundError" || name === "NotReadableError") {
      throw new Error(
        `"${fileName}" can't be read from your browser anymore. Please re-upload it in the editor and try again.`,
      );
    }
    throw err;
  }

  const res = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-asset-id": safeAssetId(assetId),
      "x-asset-ext": ext,
      "x-content-type": contentType || "application/octet-stream",
      [ACCESS_CODE_HEADER]: accessCode,
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("[render-upload] upload error", { status: res.status, body: txt.slice(0, 300) });
    if (res.status === 401) throw new Error("Upload rejected: invalid access code.");
    throw new Error(`Upload failed: ${res.status}`);
  }

  const { url } = (await res.json()) as { url?: string };
  if (!url) {
    throw new Error("Upload succeeded but no file URL was returned");
  }

  onProgress?.(100);
  return url;
}

async function getBlob(ref: AssetRef): Promise<Blob | null> {
  const blob = await get<Blob>(`asset:${ref.id}`);
  return blob ?? null;
}

async function getBlobFromUrl(url: string, ref: AssetRef): Promise<Blob | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[render-upload] fetch asset url failed", { assetId: ref.id, url, status: res.status });
      return null;
    }
    return await res.blob();
  } catch (error) {
    console.error("[render-upload] fetch asset url error", { assetId: ref.id, url, error });
    return null;
  }
}

async function loadAssetBlob(ref: AssetRef): Promise<Blob | null> {
  let blob: Blob | null = null;

  // Prefer the live object URL from the current editor session when available.
  if (ref.url?.startsWith("blob:")) {
    blob = await getBlobFromUrl(ref.url, ref);
  }
  if (!blob) {
    blob = await getBlob(ref);
  }
  if (!blob && ref.url) {
    blob = await getBlobFromUrl(ref.url, ref);
  }
  if (!blob) {
    console.error("[render-upload] missing IndexedDB blob", { assetId: ref.id, name: ref.name, type: ref.type });
    return null;
  }
  return blob;
}

const audioCache = new Map<string, { url: string; durationSeconds: number }>();

/**
 * Upload the song for a cloud render as a clean WAV and report its true
 * length. See prepareAudioForRender for why the original MP3 is not sent.
 */
export async function uploadAudioForRender(
  ref: AssetRef | undefined,
  accessCode: string,
  onStage?: (stage: string) => void,
): Promise<{ url: string | null; durationSeconds: number }> {
  if (!ref) return { url: null, durationSeconds: 0 };
  const cached = audioCache.get(ref.id);
  if (cached) return cached;

  const blob = await loadAssetBlob(ref);
  if (!blob) return { url: null, durationSeconds: 0 };

  const prepared = await prepareAudioForRender(blob, ref.name, onStage);
  onStage?.("Uploading assets…");
  const url = await uploadBlobForRender({
    assetId: prepared.converted ? `${ref.id}_render` : ref.id,
    fileName: prepared.file.name,
    contentType: prepared.file.type || ref.type || "application/octet-stream",
    blob: prepared.file,
    accessCode,
  });
  const result = { url, durationSeconds: prepared.durationSeconds };
  audioCache.set(ref.id, result);
  return result;
}

export async function uploadAssetForRender(ref: AssetRef | undefined, accessCode: string): Promise<string | null> {
  if (!ref) return null;
  const cached = uploadedCache.get(ref.id);
  if (cached) return cached;

  const blob = await loadAssetBlob(ref);
  if (!blob) return null;

  const url = await uploadBlobForRender({
    assetId: ref.id,
    fileName: ref.name,
    contentType: ref.type || blob.type || "application/octet-stream",
    blob,
    accessCode,
  });

  uploadedCache.set(ref.id, url);
  return url;
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
